import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

const app = express();
const port = process.env.PORT || 8787;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LLM_TIMEOUT_MS = 8000;

// /rank in-memory cache (60s TTL, max 500, simple LRU via Map insertion order)
const RANK_CACHE_TTL_MS = 60 * 1000;
const RANK_CACHE_MAX_ENTRIES = 500;
const rankCache = new Map(); // key -> { timestamp:number, data:object }

function normalizeToken(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

function tinyHash(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // return short base36 string
  return h.toString(36);
}

function buildPageSignatureFromCandidates(compactCandidates) {
  // Use top 30-50 tokens from accName/text/labels/role/tag
  const tokens = [];
  for (const c of compactCandidates.slice(0, 50)) {
    if (c.accName) tokens.push(normalizeToken(c.accName));
    if (c.text) tokens.push(normalizeToken(c.text));
    if (Array.isArray(c.labels)) {
      for (const l of c.labels) tokens.push(normalizeToken(l));
    }
    if (c.role) tokens.push(normalizeToken(c.role));
    if (c.tag) tokens.push(normalizeToken(c.tag));
  }
  const deduped = Array.from(new Set(tokens.filter(Boolean))).slice(0, 50);
  return tinyHash(deduped.join('|'));
}

function getRankCache(key) {
  const ent = rankCache.get(key);
  if (!ent) return null;
  if (Date.now() - ent.timestamp > RANK_CACHE_TTL_MS) {
    rankCache.delete(key);
    return null;
  }
  // refresh LRU order
  rankCache.delete(key);
  rankCache.set(key, ent);
  return ent.data;
}

function setRankCache(key, data) {
  rankCache.set(key, { timestamp: Date.now(), data });
  // evict expired first
  for (const [k, v] of rankCache.entries()) {
    if (Date.now() - v.timestamp > RANK_CACHE_TTL_MS) {
      rankCache.delete(k);
    }
  }
  // enforce max entries (delete oldest)
  while (rankCache.size > RANK_CACHE_MAX_ENTRIES) {
    const oldestKey = rankCache.keys().next().value;
    if (oldestKey === undefined) break;
    rankCache.delete(oldestKey);
  }
}

// Site hints feature flag
const ENABLE_SITE_HINTS = process.env.ENABLE_SITE_HINTS !== 'false';

// Site hints cache (in-memory, 30 min TTL)
const siteHintsCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Site hints configuration
const MAX_SITEMAP_URLS = 200;
const MAX_CRAWL_LINKS = 80;
const MAX_CONCURRENT_REQUESTS = 2;
const USER_AGENT = 'ButtonBuddyBot/0.1';
const REQUEST_TIMEOUT_MS = 5000;

// URL scoring keywords
const RELEVANT_PATH_TOKENS = [
  'settings', 'account', 'profile', 'billing', 'subscription', 'subscriptions',
  'users', 'security', 'password', 'invoices', 'payment', 'preferences',
  'admin', 'dashboard', 'manage', 'edit', 'update', 'change'
];

const GOAL_KEYWORDS_MAP = {
  'email': ['settings', 'account', 'profile', 'preferences'],
  'subscription': ['billing', 'subscription', 'subscriptions', 'payment'],
  'invoice': ['billing', 'invoices', 'payment', 'account'],
  'user': ['users', 'admin', 'manage', 'team'],
  'password': ['security', 'password', 'account', 'settings'],
  'billing': ['billing', 'payment', 'subscription', 'account'],
  'cancel': ['subscription', 'billing', 'account', 'manage']
};

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'button-buddy', endpoints: ['/rank', '/site-hints'] });
});

app.post('/rank', async (req, res) => {
  try {
    const { goal, candidates, siteHints } = req.body || {};
    if (!goal || !Array.isArray(candidates)) {
      return res.status(400).json({ error: 'Missing goal or candidates' });
    }

    // Reduce payload size: keep compact fields, cap to 50
    const compact = candidates
      .slice(0, 50)
      .map((c) => ({
        id: c.id,
        tag: c.tag,
        role: c.role,
        type: c.type,
        text: c.text,
        accName: c.accName,
        ariaLabel: c.ariaLabel,
        nameAttr: c.nameAttr,
        placeholder: c.placeholder,
        labels: c.labels,
        href: c.href,
        classes: c.classes,
        visible: c.visible,
        clickable: c.clickable,
        disabled: c.disabled,
        domPath: c.domPath,
        ancestorTextSample: c.ancestorTextSample,
        confidenceHints: c.confidenceHints,
      }));

    // Build cache key from goal + compact page signature (no raw HTML stored)
    const pageSignature = buildPageSignatureFromCandidates(compact);
    const cacheKey = `${goal.toLowerCase().trim()}|${pageSignature}`;
    const cached = getRankCache(cacheKey);
    if (cached) {
      return res.json({ ...cached, cache_hit: true });
    }

    // Build system prompt with site hints context if available
    let systemPrompt = 'You are a careful UI action ranker. Given a user goal and a small list of interactable UI controls from a web page, choose the single best control that most directly progresses the goal. Prefer highly specific controls that immediately advance the task over generic navigation. Be conservative. Return JSON only.\n\nCONSTRAINT: Choose exactly one element from candidates. Prefer labels that include goal-relevant nouns (email, billing, subscription, subscriptions, users, password, security) over generic words (change, more, menu, help, docs). If only generics exist, choose the most specific path (settings/account/profile) and lower confidence.';
    
    let siteHintsContext = '';
    if (siteHints && Array.isArray(siteHints.hints) && siteHints.hints.length > 0) {
      const hintsText = siteHints.hints.map(h => `- ${h.url} (${h.label}, score: ${h.score.toFixed(2)})`).join('\n');
      siteHintsContext = `\n\nSITE CONTEXT: Based on site analysis, these relevant paths were found:\n${hintsText}\n\nConsider these paths when selecting candidates - elements that link to or are near these paths may be more relevant to the goal.`;
      systemPrompt += siteHintsContext;
    }

    const system = systemPrompt;

    const user = {
      goal,
      instructions:
        'Select ONE best candidate. Consider accessible name, role/type, nearby/ancestor text, and hints. If confidence is low, reflect that in confidence score. Avoid generic links unless they clearly lead to the desired area. Prefer goal-relevant nouns (email, billing, subscription, subscriptions, users, password, security) over generics (change, more, menu, help, docs). If only generics exist, pick the most specific path (settings/account/profile) and lower confidence. Output as JSON.',
      candidates: compact,
      output_schema: {
        elementId: 'string',
        reason: 'string, 1 short sentence',
        confidence: 'number 0-100',
        alternates: 'optional, up to 3 elementId strings ordered by preference',
      },
    };

    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          'USER GOAL:\n' +
          goal +
          '\nCANDIDATES (JSON):\n' +
          JSON.stringify(compact).slice(0, 120000) +
          '\nIMPORTANT: You must choose an elementId strictly from the provided candidates (by id). Do not invent or transform ids.\nRespond ONLY with a compact JSON object: {"elementId":"...","reason":"...","confidence":0-100,"alternates":["..."]?}',
      },
    ];

    // call LLM with a hard timeout and capture timing (Promise.race, no SDK signal)
    const started = Date.now();
    let timer;
    let llmText = '';
    let llm_ms = 0;
    try {
      const llmCall = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.15,
        messages,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM_TIMEOUT')), LLM_TIMEOUT_MS);
      });

      const resp = await Promise.race([llmCall, timeout]);
      clearTimeout(timer);
      llm_ms = Date.now() - started;

      // If we got a real response object, extract text
      if (resp && resp.choices) {
        llmText = resp.choices?.[0]?.message?.content?.trim() || '';
      } else {
        // Defensive: if Promise.race resolved with something unexpected
        throw new Error('LLM_TIMEOUT');
      }
    } catch (e) {
      llm_ms = Date.now() - started;
      clearTimeout(timer);

      if (e && e.message === 'LLM_TIMEOUT') {
        // Soft fallback guess from compact candidates when the LLM times out
        const pick = compact.find(c => /email|subscription|billing|settings|account|password/i.test(
          (c.text || '') + ' ' + (c.accName || '') + ' ' + (c.ariaLabel || '')
        )) || compact[0];

        const fallback = {
          elementId: pick?.id || null,
          reason: 'Timed out; offering best local guess',
          confidence: 35,
          alternates: undefined,
          llm_ms,
        };
        setRankCache(cacheKey, fallback);
        return res.json({ ...fallback, cache_hit: false });
      }

      console.error('LLM call error:', e);
      return res.status(502).json({ error: 'LLM error', detail: String(e), llm_ms });
    }

    // parse LLM output (try robustly)
    const text = llmText;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed || !parsed.elementId) {
      return res.status(502).json({ error: 'Bad LLM response', raw: text, llm_ms });
    }

    const result = {
      elementId: parsed.elementId,
      reason: parsed.reason || 'Chosen as best match to goal',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
      alternates: Array.isArray(parsed.alternates) ? parsed.alternates.slice(0, 3) : undefined,
    };

    const payload = { ...result, llm_ms };
    setRankCache(cacheKey, payload);
    res.json({ ...payload, cache_hit: false });
  } catch (err) {
    console.error('Rank error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Site hints utility functions
function getCacheKey(origin, goal) {
  return `${origin}::${goal.toLowerCase()}`;
}

function isCacheValid(timestamp) {
  return Date.now() - timestamp < CACHE_TTL_MS;
}

function extractPathStem(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function scoreUrl(url, goal, pathStem) {
  let score = 0;
  const lowerUrl = url.toLowerCase();
  const lowerGoal = goal.toLowerCase();
  const lowerPathStem = pathStem.toLowerCase();
  
  // Base score for relevant path tokens
  for (const token of RELEVANT_PATH_TOKENS) {
    if (lowerPathStem.includes(token)) {
      score += 0.3;
    }
  }
  
  // Goal-specific scoring
  for (const [goalKeyword, relevantTokens] of Object.entries(GOAL_KEYWORDS_MAP)) {
    if (lowerGoal.includes(goalKeyword)) {
      for (const token of relevantTokens) {
        if (lowerPathStem.includes(token)) {
          score += 0.4;
        }
      }
    }
  }
  
  // Path depth penalty (prefer shallow paths)
  const depth = (pathStem.match(/\//g) || []).length;
  score -= depth * 0.05;
  
  // Bonus for exact matches
  if (lowerPathStem === '/' + goal.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    score += 0.5;
  }
  
  return Math.max(0, Math.min(1, score));
}

function deduplicateByStem(urls) {
  const seen = new Set();
  const result = [];
  
  for (const url of urls) {
    const stem = extractPathStem(url.url);
    if (!seen.has(stem)) {
      seen.add(stem);
      result.push(url);
    }
  }
  
  return result;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...options.headers
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function fetchRobotsTxt(origin) {
  try {
    const response = await fetchWithTimeout(`${origin}/robots.txt`);
    if (!response.ok) return null;
    
    const text = await response.text();
    const sitemapMatches = text.match(/^Sitemap:\s*(.+)$/gm);
    
    if (sitemapMatches) {
      return sitemapMatches.map(match => match.replace(/^Sitemap:\s*/, '').trim());
    }
    return [];
  } catch {
    return null;
  }
}

async function parseSitemap(sitemapUrl) {
  try {
    const response = await fetchWithTimeout(sitemapUrl);
    if (!response.ok) return [];
    
    const xml = await response.text();
    const parser = new XMLParser();
    const parsed = parser.parse(xml);
    
    const urls = [];
    
    // Handle different sitemap formats
    if (parsed.urlset && parsed.urlset.url) {
      const urlEntries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
      for (const entry of urlEntries) {
        if (entry.loc) {
          urls.push(entry.loc);
        }
      }
    } else if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      // Sitemap index - get first 2 child sitemaps
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap) ? parsed.sitemapindex.sitemap : [parsed.sitemapindex.sitemap];
      const childSitemaps = sitemaps.slice(0, 2);
      
      for (const childSitemap of childSitemaps) {
        if (childSitemap.loc) {
          const childUrls = await parseSitemap(childSitemap.loc);
          urls.push(...childUrls);
        }
      }
    }
    
    return urls.slice(0, MAX_SITEMAP_URLS);
  } catch {
    return [];
  }
}

async function shallowCrawl(origin) {
  try {
    const response = await fetchWithTimeout(origin);
    if (!response.ok) return [];
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const links = [];
    
    // Extract navigation and footer links
    const selectors = [
      'nav a[href]',
      'header a[href]',
      'footer a[href]',
      '.nav a[href]',
      '.navigation a[href]',
      '.menu a[href]',
      '.header a[href]',
      '.footer a[href]'
    ];
    
    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          try {
            const url = new URL(href, origin);
            if (url.origin === origin) {
              links.push(url.href);
            }
          } catch {
            // Skip invalid URLs
          }
        }
      });
    }
    
    return [...new Set(links)].slice(0, MAX_CRAWL_LINKS);
  } catch {
    return [];
  }
}

async function getSiteHints(origin, goal) {
  const startTime = Date.now();
  let source = 'none';
  let urls = [];
  
  try {
    // Try robots.txt first
    const sitemapUrls = await fetchRobotsTxt(origin);
    
    if (sitemapUrls && sitemapUrls.length > 0) {
      source = 'sitemap';
      
      // Parse up to 2 sitemaps
      const sitemapsToParse = sitemapUrls.slice(0, 2);
      
      for (const sitemapUrl of sitemapsToParse) {
        const sitemapUrls = await parseSitemap(sitemapUrl);
        urls.push(...sitemapUrls);
        
        if (urls.length >= MAX_SITEMAP_URLS) break;
      }
    }
    
    // Fallback to shallow crawl if no sitemap URLs
    if (urls.length === 0) {
      source = 'crawl';
      urls = await shallowCrawl(origin);
    }
    
    // Score and rank URLs
    const scoredUrls = urls.map(url => ({
      url: extractPathStem(url),
      label: extractPathStem(url).split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Home',
      score: scoreUrl(url, goal, extractPathStem(url))
    }));
    
    // Deduplicate and sort by score
    const deduplicated = deduplicateByStem(scoredUrls);
    const sorted = deduplicated.sort((a, b) => b.score - a.score);
    
    return {
      hints: sorted.slice(0, 10), // Top 10 hints
      meta: {
        source,
        fetched_ms: Date.now() - startTime,
        ttl_s: Math.floor(CACHE_TTL_MS / 1000)
      }
    };
  } catch (error) {
    console.error('Site hints error:', error);
    return {
      hints: [],
      meta: {
        source: 'error',
        fetched_ms: Date.now() - startTime,
        ttl_s: Math.floor(CACHE_TTL_MS / 1000)
      }
    };
  }
}

// Site hints endpoint
app.post('/site-hints', async (req, res) => {
  if (!ENABLE_SITE_HINTS) {
    return res.json({ hints: [], meta: { source: 'disabled', fetched_ms: 0, ttl_s: 0 } });
  }
  
  try {
    const { origin, goal } = req.body || {};
    if (!origin || !goal) {
      return res.status(400).json({ error: 'Missing origin or goal' });
    }
    
    // Validate origin URL
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return res.status(400).json({ error: 'Invalid origin URL' });
    }
    
    const cacheKey = getCacheKey(origin, goal);
    const cached = siteHintsCache.get(cacheKey);
    
    if (cached && isCacheValid(cached.timestamp)) {
      return res.json({
        origin,
        hints: cached.hints,
        meta: {
          ...cached.meta,
          cached: true
        }
      });
    }
    
    // Fetch fresh hints
    const result = await getSiteHints(origin, goal);
    
    // Cache the result
    siteHintsCache.set(cacheKey, {
      hints: result.hints,
      meta: result.meta,
      timestamp: Date.now()
    });
    
    // Clean up old cache entries
    for (const [key, value] of siteHintsCache.entries()) {
      if (!isCacheValid(value.timestamp)) {
        siteHintsCache.delete(key);
      }
    }
    
    res.json({
      origin,
      hints: result.hints,
      meta: result.meta
    });
  } catch (error) {
    console.error('Site hints endpoint error:', error);
    res.json({
      hints: [],
      meta: {
        source: 'error',
        fetched_ms: 0,
        ttl_s: 0
      }
    });
  }
});

app.listen(port, () => {
  console.log(`[button-buddy] server listening on http://localhost:${port}`);
});


