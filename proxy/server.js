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
    elements: (page.elements || []).slice(0, 200).map(e => ({
      role: e.role, text: e.text, ariaLabel: e.ariaLabel, selector: e.selector, bounding: e.bounding
    })),
    context: (page.context || []).slice(0, 40).map(e => ({ role: e.role, text: e.text }))
  };
  const prior = (history || []).slice(-3);

  const system = {
    role: 'system',
    content:
`You are a web navigation assistant. Suggest ONE best next click on the CURRENT page toward the user's goal.

Heuristics (very important):
- Prefer direct matches to the goal in visible text or aria-labels (e.g., 'Password', 'Subscriptions', 'Invoices').
- If direct match is missing, choose the most *specific* parent: Profile/Account/Settings before Menu/More.
- For cancellation/billing: prefer Subscriptions/Billing/Plans over generic Menu.
- For password/security: prefer Profile/Account/Settings/Security over Menu.
- Be multilingual-aware (e.g., Norwegian): 
  - account/konto, settings/innstillinger, profile/profil, billing/fakturering/betaling, subscription/abonnement, invoices/faktura, security/sikkerhet, password/passord, cancel/avslutt/si opp, unsubscribe/avmeld/oppheve.
- If nothing relevant exists, choose the main entry (Menu) with low confidence.

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

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});