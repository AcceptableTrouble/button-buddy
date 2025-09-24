async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg || '';
}

function setResult(obj) {
  const pre = document.getElementById('result');
  pre.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function setLoading(isLoading) {
  const btn = document.getElementById('askBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (isLoading) {
    btn.classList.add('loading');
    btn.disabled = true;
    if (nextBtn) {
      // remember previous disabled state to restore accurately
      nextBtn.dataset.prevDisabled = String(nextBtn.disabled);
      nextBtn.disabled = true;
    }
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (nextBtn && 'prevDisabled' in nextBtn.dataset) {
      nextBtn.disabled = nextBtn.dataset.prevDisabled === 'true';
      delete nextBtn.dataset.prevDisabled;
    }
  }
}

async function ensureInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function scrapePage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_PAGE' }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else {
        resolve(resp);
      }
    });
  });
}

const USE_LOCAL_FASTPATH = false;

// highlight now also passes the label text and enforces selector validation
async function highlight(tabId, selector, label, opts = {}) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'HIGHLIGHT', selector, label, strictSelector: Boolean(opts.strictSelector) },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(Boolean(resp?.ok));
        }
      }
    );
  });
}

async function validateSelector(tabId, selector) {
  if (!tabId || !selector) return false;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'VALIDATE_SELECTOR', selector },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(Boolean(resp?.ok));
        }
      }
    );
  });
}

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w && w.length >= 3);
}

function labelForElement(el) {
  return (el?.text || el?.ariaLabel || el?.name || '').trim();
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function computeElementScores(query, elements) {
  const tokens = tokenizeQuery(query);
  if (!Array.isArray(elements) || !elements.length || !tokens.length) return [];
  const scores = [];
  for (const el of elements) {
    if (!el || !el.selector) continue;
    const label = `${el.text || ''} ${el.ariaLabel || ''} ${el.name || ''}`.toLowerCase();
    const trimmed = label.trim();
    if (!trimmed) continue;
    let score = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (trimmed.includes(token)) {
        score += token.length >= 6 ? 2 : 1;
        if (trimmed.startsWith(token)) score += 0.5;
      }
    }
    if (score > 0) {
      scores.push({ el, score, label: labelForElement(el) });
    }
  }
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aLen = a.label ? a.label.length : 0;
    const bLen = b.label ? b.label.length : 0;
    if (bLen !== aLen) return bLen - aLen; // prefer longer, more specific labels
    return 0;
  });
  return scores;
}

function buildAlternateSuggestions(query, elements, excludeSelectors = new Set(), limit = 3) {
  const scored = computeElementScores(query, elements);
  const alternates = [];
  for (const { el } of scored) {
    if (excludeSelectors.has(el.selector)) continue;
    const label = labelForElement(el) || 'Open';
    alternates.push({
      action_label: label,
      selector: el.selector,
      confidence: clampConfidence(0.5 - alternates.length * 0.05),
      explanation: alternates.length === 0
        ? 'Not fully certain; this seems closest on the current page.'
        : 'Not fully certain; alternate option from current page.',
      source: 'alternate'
    });
    if (alternates.length >= limit) break;
  }
  return alternates;
}

function sanitizeCandidate(candidate, selectorMap, source) {
  if (!candidate || typeof candidate !== 'object') return null;
  const selector = candidate.selector;
  if (!selector || !selectorMap.has(selector)) return null;
  const el = selectorMap.get(selector);
  const label = labelForElement(el) || (candidate.action_label || '').trim() || 'Open';
  const explanation = String(candidate.explanation || '').trim().slice(0, 160) || 'This element matches the goal.';
  return {
    action_label: label,
    selector,
    confidence: clampConfidence(Number(candidate.confidence ?? 0.6)),
    explanation,
    source: source || candidate.source || 'llm'
  };
}

async function prepareFinalSuggestion({ tabId, page, query, candidate, source }) {
  const elements = Array.isArray(page?.elements) ? page.elements.filter(el => el && el.selector) : [];
  const selectorMap = new Map(elements.map(el => [el.selector, el]));

  const original = sanitizeCandidate(candidate, selectorMap, source);
  const response = {
    original,
    primary: null,
    alternates: [],
    usedAlternate: false,
    status: ''
  };

  let originalValid = false;
  let originalLowConfidence = false;
  if (original) {
    originalValid = await validateSelector(tabId, original.selector);
    originalLowConfidence = original.confidence <= 0.55;
    if (originalValid && !originalLowConfidence) {
      response.primary = original;
      response.status = original.explanation || '';
      return response;
    }
    response.status = originalValid
      ? 'Not fully certain; offering alternates for a safer choice.'
      : 'Original suggestion no longer resolves on the page.';
  } else {
    response.status = 'Model did not return a selectable element.';
  }

  const exclude = new Set();
  if (original?.selector) exclude.add(original.selector);
  const alternates = buildAlternateSuggestions(query, elements, exclude, 5);
  const validatedAlternates = [];
  for (const alt of alternates) {
    const ok = await validateSelector(tabId, alt.selector);
    if (ok) validatedAlternates.push(alt);
    if (validatedAlternates.length >= 3) break;
  }

  if (!validatedAlternates.length) {
    response.alternates = [];
    if (!original) {
      response.status = 'No matching elements found. Please refine your request.';
      return response;
    }
    if (originalValid) {
      response.primary = {
        ...original,
        confidence: clampConfidence(Math.min(original.confidence, 0.55)),
        explanation: 'Not fully certain; no better matches found on this page.'
      };
      return response;
    }
    response.primary = {
      ...original,
      selector: null,
      confidence: clampConfidence(Math.min(original.confidence, 0.5)),
      explanation: 'Not fully certain; suggestion unavailable on the page right now.'
    };
    return response;
  }

  const [firstAlt] = validatedAlternates;
  response.alternates = validatedAlternates.slice(0, 3);

  const primary = {
    ...firstAlt,
    confidence: clampConfidence(Math.min(firstAlt.confidence, 0.55)),
    explanation: originalValid
      ? 'Not fully certain; using the closest alternate instead.'
      : 'Primary suggestion unavailable; this alternate should be the closest match.'
  };
  response.primary = primary;
  response.usedAlternate = true;
  response.status = originalValid
    ? 'Not fully certain; choosing a safer alternate.'
    : 'Primary suggestion unavailable; showing alternates.';
  return response;
}

// ---- Session storage helpers ----
async function loadGuidance() {
  const res = await chrome.storage.local.get('guidance');
  return res.guidance || null;
}
async function saveGuidance(g) {
  await chrome.storage.local.set({ guidance: g });
}
async function resetGuidance() {
  await chrome.storage.local.remove('guidance');
}
function updateSessionUI(g) {
  const el = document.getElementById('goalLine');
  const usageEl = document.getElementById('usageLine');
  const nextBtn = document.getElementById('nextBtn');
  const resetBtn = document.getElementById('resetBtn');
  if (!g) {
    el.textContent = 'No active guidance.';
    if (usageEl) usageEl.textContent = 'Uses this session: 0';
    nextBtn.disabled = true;
    resetBtn.disabled = true;
  } else {
    el.textContent = `Goal: ${g.goal} • Steps: ${g.steps.length}`;
    if (usageEl) usageEl.textContent = `Uses this session: ${g.usageCount ?? 0}`;
    nextBtn.disabled = false;
    resetBtn.disabled = false;
  }
}

// ---- Last query storage helpers ----
async function loadLastQuery() {
  const res = await chrome.storage.local.get('lastQuery');
  return res.lastQuery || '';
}
async function saveLastQuery(query) {
  await chrome.storage.local.set({ lastQuery: query || '' });
}

// ---- Usage counter helpers ----
async function loadUsageCount() {
  const res = await chrome.storage.local.get('usageCount');
  return typeof res.usageCount === 'number' ? res.usageCount : 0;
}
async function saveUsageCount(count) {
  await chrome.storage.local.set({ usageCount: count });
}
async function incrementUsageCount() {
  const n = await loadUsageCount();
  const next = n + 1;
  await saveUsageCount(next);
  return next;
}

// include history when asking the model
async function askLLM(query, page, history) {
  const res = await fetch('http://localhost:8787/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, page, history })
  });
  if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  return await res.json();
}

// ---- Client-side heuristic: direct keyword match on page elements ----
function findLocalDirectMatch(query, page) {
  if (!USE_LOCAL_FASTPATH) return null;
  try {
    const elements = Array.isArray(page?.elements) ? page.elements : [];
    const scored = computeElementScores(query, elements);
    if (!scored.length) return null;
    const best = scored[0];
    if (!best.el?.selector) return null;
    const label = labelForElement(best.el) || 'Open';
    return {
      action_label: label,
      selector: best.el.selector,
      confidence: 0.95,
      explanation: 'Direct match found locally.'
    };
  } catch (_) {
    return null;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const qEl = document.getElementById('query');
  const askBtn = document.getElementById('askBtn');

  // load existing session state (if any)
  const initial = await loadGuidance();
  updateSessionUI(initial);

  // initialize usage line from stored counter
  try {
    const usage = await loadUsageCount();
    const usageEl = document.getElementById('usageLine');
    if (usageEl) usageEl.textContent = `Uses this session: ${usage}`;
  } catch {}

  // restore last query if any
  try {
    const last = await loadLastQuery();
    if (last) qEl.value = last;
  } catch {}

  // persist query on input
  qEl.addEventListener('input', () => { saveLastQuery(qEl.value); });

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      qEl.value = btn.dataset.q;
      saveLastQuery(qEl.value);
    });
  });

  // common handler used by Ask button and Cmd/Ctrl+Enter
  async function performAsk() {
    setStatus('Scanning page…');
    setResult('');
    setLoading(true);
    const query = qEl.value.trim() || 'Find account settings';
    saveLastQuery(query);

    try {
      const tabId = await getActiveTabId();
      if (!tabId) throw new Error('No active tab');

      await ensureInjected(tabId);
      const page = await scrapePage(tabId);

      const existingGuidance = await loadGuidance();

      setStatus('Thinking…');
      const history = existingGuidance?.steps?.slice(-3) || [];
      const answer = await askLLM(query, page, history);
      const answerSource = 'llm';

      const prepared = await prepareFinalSuggestion({ tabId, page, query, candidate: answer, source: answerSource });
      const statusMsg = prepared.status || (prepared.primary?.explanation ?? '');
      setStatus(statusMsg);
      setResult({
        primary: prepared.primary,
        alternates: prepared.alternates,
        original: prepared.original
      });

      const shouldHighlight = document.getElementById('highlightToggle').checked && prepared.primary?.selector;
      if (shouldHighlight) {
        await highlight(tabId, prepared.primary.selector, prepared.primary.action_label, { strictSelector: true });
      }

      if (prepared.primary) {
        const guidance = existingGuidance || { goal: query, steps: [], lastUrl: page.url };
        if (!guidance.goal) guidance.goal = query;
        guidance.steps.push({
          url: page.url,
          action_label: prepared.primary.action_label,
          selector: prepared.primary.selector,
          confidence: prepared.primary.confidence,
          source: prepared.primary.source,
          t: Date.now()
        });
        guidance.lastUrl = page.url;

        const usage = await incrementUsageCount();
        guidance.usageCount = usage;

        await saveGuidance(guidance);
        updateSessionUI(guidance);
      }

    } catch (err) {
      setStatus('Error');
      setResult(String(err));
    } finally {
      setLoading(false);
    }
  }

  // ASK (start or continue guidance)
  askBtn.addEventListener('click', performAsk);

  // Cmd/Ctrl + Enter triggers Ask
  qEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!askBtn.disabled) performAsk();
    }
  });

  // NEXT STEP (continue with context)
  document.getElementById('nextBtn').addEventListener('click', async () => {
    try {
      setStatus('Scanning for next…');
      setResult('');
      setLoading(true);

      const tabId = await getActiveTabId();
      if (!tabId) throw new Error('No active tab');
      await ensureInjected(tabId);
      const page = await scrapePage(tabId);

      const g = await loadGuidance();
      if (!g) throw new Error('No active guidance session. Ask a goal first.');

      setStatus('Thinking…');
      const answer = await askLLM(g.goal, page, g.steps.slice(-3));
      const answerSource = 'llm';

      const prepared = await prepareFinalSuggestion({ tabId, page, query: g.goal, candidate: answer, source: answerSource });
      const statusMsg = prepared.status || (prepared.primary?.explanation ?? '');
      setStatus(statusMsg);
      setResult({
        primary: prepared.primary,
        alternates: prepared.alternates,
        original: prepared.original
      });

      const shouldHighlight = document.getElementById('highlightToggle').checked && prepared.primary?.selector;
      if (shouldHighlight) {
        await highlight(tabId, prepared.primary.selector, prepared.primary.action_label, { strictSelector: true });
      }

      if (prepared.primary) {
        g.steps.push({
          url: page.url,
          action_label: prepared.primary.action_label,
          selector: prepared.primary.selector,
          confidence: prepared.primary.confidence,
          source: prepared.primary.source,
          t: Date.now()
        });
        g.lastUrl = page.url;
        const usage = await incrementUsageCount();
        g.usageCount = usage;
        await saveGuidance(g);
        updateSessionUI(g);
      }
    } catch (err) {
      setStatus('Error');
      setResult(String(err));
    } finally {
      setLoading(false);
    }
  });

  // RESET
  document.getElementById('resetBtn').addEventListener('click', async () => {
    await resetGuidance();
    updateSessionUI(null);
    setResult(''); setStatus('');
  });
});
