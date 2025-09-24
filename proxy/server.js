const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const PORT = process.env.PORT || 8787;

function buildPrompt(query, page, history) {
  const trimmed = {
    url: page.url,
    title: page.title,
    lang: page.lang || null,
    elements: (page.elements || []).slice(0, 200).map(e => ({
      role: e.role,
      text: e.text,
      ariaLabel: e.ariaLabel,
      selector: e.selector,
      bounding: e.bounding
    })),
    context: (page.context || []).slice(0, 40).map(e => ({ role: e.role, text: e.text }))
  };
  const prior = (history || []).slice(-3);

  const system = {
    role: 'system',
    content:
`You are Button Buddy, a cautious browser assistant. Choose exactly one actionable element from the provided page data to move the user toward their goal.

Rules you must follow:
- Only pick from the given elements array; never fabricate new labels or selectors.
- Output the element's exact selector. If multiple look relevant, prefer the most specific, visible option over generic entries like “Change”.
- Use the element's visible text (or aria-label) verbatim for "action_label". Keep explanations in English but reference the real label even if the page uses another language.
- Infer the page language from title, lang attribute, and visible text to disambiguate meanings.
- When the goal targets a specific concept (e.g., email), strongly prefer labels that mention that concept or a clear parent path (Profile/Account/Settings → Email) instead of vague labels.
- If you are not fully confident, cap confidence at 0.55 and include a cautious explanation that clearly states the uncertainty (e.g., "Not fully certain; ...").
- If nothing is a good fit, choose the closest helpful element with low confidence rather than inventing anything.

STRICTLY reply with JSON ONLY:
{"action_label": string, "selector": string|null, "confidence": number (0-1), "explanation": string (<=160 chars)}`
  };

  // Few-shot examples to steer behavior
  const examples = [
    {
      role: 'user',
      content:
`User goal: Change my password
Prior steps: []
Current page summary:
{"url":"https://app.example.com","title":"Dashboard","elements":[
  {"role":"button","text":"Menu","selector":"#menu"},
  {"role":"link","text":"Profile","selector":"#profile"},
  {"role":"link","text":"Settings","selector":"#settings"},
  {"role":"link","text":"Billing","selector":"#billing"}]}`
    },
    {
      role: 'assistant',
      content: `{"action_label":"Settings","selector":"#settings","confidence":0.9,"explanation":"Passwords are typically under Settings/Profile/Account."}`
    },
    {
      role: 'user',
      content:
`User goal: Cancel my subscription
Prior steps: []
Current page summary:
{"url":"https://app.example.com","title":"Account","elements":[
  {"role":"link","text":"Menu","selector":"#menu"},
  {"role":"link","text":"Billing","selector":"#billing"},
  {"role":"link","text":"Subscriptions","selector":"#subs"}]}`
    },
    {
      role: 'assistant',
      content: `{"action_label":"Subscriptions","selector":"#subs","confidence":0.95,"explanation":"Subscriptions is the most direct path to cancellation."}`
    },
    {
      role: 'user',
      content:
`User goal: Find invoices
Prior steps: []
Current page summary:
{"url":"https://no.example.com","title":"Min konto","elements":[
  {"role":"link","text":"Innstillinger","selector":"#innstillinger"},
  {"role":"link","text":"Fakturering","selector":"#fakturering"},
  {"role":"link","text":"Hjelp","selector":"#hjelp"}]}`
    },
    {
      role: 'assistant',
      content: `{"action_label":"Fakturering","selector":"#fakturering","confidence":0.92,"explanation":"Invoices live under Billing/Fakturering."}`
    },
    {
      role: 'user',
      content:
`User goal: Change my email
Prior steps: []
Current page summary:
{"url":"https://app.example.com/settings","title":"Account Settings","elements":[
  {"role":"button","text":"Change","selector":"#change"},
  {"role":"link","text":"Change password","selector":"#change-password"},
  {"role":"link","text":"Email settings","selector":"#email-settings"},
  {"role":"link","text":"Profile","selector":"#profile"},
  {"role":"link","text":"Settings","selector":"#settings"}]}`
    },
    {
      role: 'assistant',
      content: `{"action_label":"Email settings","selector":"#email-settings","confidence":0.93,"explanation":"Email settings is the most direct path for updating email."}`
    },
    {
      role: 'user',
      content:
`User goal: Cancel my subscription
Prior steps: []
Current page summary:
{"url":"https://app.example.com","title":"Dashboard","lang":null,"elements":[
  {"role":"link","text":"Menu","selector":"#menu"},
  {"role":"link","text":"Plans","selector":"#plans"}]}`
    },
    {
      role: 'assistant',
      content: `{"action_label":"Plans","selector":"#plans","confidence":0.55,"explanation":"Not fully certain; Plans is the closest option for managing subscriptions."}`
    }
  ];

  const user = {
    role: 'user',
    content:
`User goal: ${query}

Prior steps (most recent last):
${JSON.stringify(prior)}

Current page summary:
${JSON.stringify(trimmed)}`
  };

  return [system, ...examples, user];
}

app.post('/ask', async (req, res) => {
  try {
    const { query, page, history } = req.body || {};
    if (!query || !page) return res.status(400).json({ error: 'Missing query or page' });

    const allowedElements = (page.elements || [])
      .slice(0, 200)
      .filter(el => el && el.selector);
    const selectorMap = new Map(allowedElements.map(el => [el.selector, el]));

    const messages = buildPrompt(query, page, history);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        messages
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: text });
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '{}';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {
        action_label: 'Open the main menu',
        selector: null,
        confidence: 0.4,
        explanation: 'Fallback: could not parse JSON cleanly.'
      };
    }

    const out = {
      action_label: String(parsed.action_label || 'Open the menu'),
      selector: parsed.selector || null,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      explanation: String(parsed.explanation || 'This seems relevant.')
    };

    const chosen = out.selector ? selectorMap.get(out.selector) : null;
    if (!chosen) {
      out.selector = null;
      out.confidence = Math.min(out.confidence, 0.45);
      out.action_label = 'No validated element';
      out.explanation = 'Model response did not match provided elements.';
    } else {
      const label = (chosen.text || chosen.ariaLabel || chosen.name || '').trim();
      if (label) out.action_label = label;
    }

    if (out.confidence < 0 && Number.isFinite(out.confidence)) {
      out.confidence = 0;
    }

    if (out.confidence > 1) out.confidence = 1;

    // Keep explanations concise to avoid UI overflow.
    if (out.explanation.length > 160) {
      out.explanation = out.explanation.slice(0, 157) + '...';
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});

