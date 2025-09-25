import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'button-buddy', endpoints: ['/rank'] });
});

app.post('/rank', async (req, res) => {
  try {
    const { goal, candidates } = req.body || {};
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

    const system =
      'You are a careful UI action ranker. Given a user goal and a small list of interactable UI controls from a web page, choose the single best control that most directly progresses the goal. Prefer highly specific controls that immediately advance the task over generic navigation. Be conservative. Return JSON only.';

    const user = {
      goal,
      instructions:
        'Select ONE best candidate. Consider accessible name, role/type, nearby/ancestor text, and hints. If confidence is low, reflect that in confidence score. Avoid generic links unless they clearly lead to the desired area. Output as JSON.',
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
          '\nRespond ONLY with a compact JSON object: {"elementId":"...","reason":"...","confidence":0-100,"alternates":["..."]?}',
      },
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages,
    });

    const text = response.choices?.[0]?.message?.content?.trim() || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      // Try to extract JSON via a naive match
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed || !parsed.elementId) {
      return res.status(502).json({ error: 'Bad LLM response', raw: text });
    }

    const result = {
      elementId: parsed.elementId,
      reason: parsed.reason || 'Chosen as best match to goal',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
      alternates: Array.isArray(parsed.alternates) ? parsed.alternates.slice(0, 3) : undefined,
    };

    res.json(result);
  } catch (err) {
    console.error('Rank error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(port, () => {
  console.log(`[button-buddy] server listening on http://localhost:${port}`);
});


