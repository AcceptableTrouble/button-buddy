import('node-fetch').then(({ default: fetch }) => {
  const express = require('express');
  const cors = require('cors');
  const dotenv = require('dotenv');
  dotenv.config();

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '1mb' }));

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.MODEL || 'gpt-3.5-turbo';
  const PORT = process.env.PORT || 8787;

  function buildPrompt(query, page) {
    // Keep payload compact: we only need visible elements summary
    const trimmed = {
      url: page.url,
      title: page.title,
      elements: (page.elements || []).slice(0, 200).map(e => ({
        role: e.role, text: e.text, ariaLabel: e.ariaLabel, selector: e.selector, bounding: e.bounding
      })),
      context: (page.context || []).slice(0, 50).map(e => ({ role: e.role, text: e.text }))
    };

    return [
      { role: 'system', content: `You are a web navigation assistant. 
Return a SINGLE best next click to move toward the user's goal on the CURRENT page. 
Prefer obvious navigation like "Menu", "Account", "Settings", "Billing", "Subscriptions", "Profile".
If nothing is relevant, suggest a search or scanning action.
STRICTLY reply with compact JSON: {"action_label": string, "selector": string|null, "confidence": number (0-1), "explanation": string (max 160 chars)}.` },
      { role: 'user', content: `User goal: ${query}\nPage summary:\n${JSON.stringify(trimmed)}` }
    ];
  }

  app.post('/ask', async (req, res) => {
    try {
      const { query, page } = req.body || {};
      if (!query || !page) return res.status(400).json({ error: 'Missing query or page' });

      const messages = buildPrompt(query, page);

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
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
        // Fallback: extract JSON block if the model added extra text
        const m = content.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { action_label: 'Try the main menu', selector: null, confidence: 0.4, explanation: 'Could not parse model output cleanly.' };
      }

      // Sanitize fields
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
}).catch(err => {
  console.error('Failed to start server:', err);
});