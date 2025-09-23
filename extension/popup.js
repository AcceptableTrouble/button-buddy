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
  if (isLoading) btn.classList.add('loading');
  else btn.classList.remove('loading');
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

// highlight now also passes the label text
async function highlight(tabId, selector, label) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'HIGHLIGHT', selector, label },
      () => resolve()
    );
  });
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
  const nextBtn = document.getElementById('nextBtn');
  const resetBtn = document.getElementById('resetBtn');
  if (!g) {
    el.textContent = 'No active guidance.';
    nextBtn.disabled = true;
    resetBtn.disabled = true;
  } else {
    el.textContent = `Goal: ${g.goal} • Steps: ${g.steps.length}`;
    nextBtn.disabled = false;
    resetBtn.disabled = false;
  }
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

document.addEventListener('DOMContentLoaded', async () => {
  const qEl = document.getElementById('query');

  // load existing session state (if any)
  const initial = await loadGuidance();
  updateSessionUI(initial);

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => { qEl.value = btn.dataset.q; });
  });

  // ASK (start or continue guidance)
  document.getElementById('askBtn').addEventListener('click', async () => {
    setStatus('Scanning page…');
    setResult('');
    setLoading(true);
    const query = qEl.value.trim() || 'Find account settings';

    try {
      const tabId = await getActiveTabId();
      if (!tabId) throw new Error('No active tab');

      await ensureInjected(tabId);
      const page = await scrapePage(tabId);

      setStatus('Thinking…');
      const g0 = await loadGuidance();
      const history = g0?.steps?.slice(-3) || []; // send last 3 steps if any
      const answer = await askLLM(query, page, history);

      setStatus('');
      setResult(answer);

      if (document.getElementById('highlightToggle').checked && answer.selector) {
        await highlight(tabId, answer.selector, answer.action_label);
      }

      // create/update guidance session
      let g = g0 || { goal: query, steps: [], lastUrl: page.url };
      if (!g.goal) g.goal = query;
      g.steps.push({ url: page.url, action_label: answer.action_label, selector: answer.selector, t: Date.now() });
      g.lastUrl = page.url;
      await saveGuidance(g);
      updateSessionUI(g);

    } catch (err) {
      setStatus('Error');
      setResult(String(err));
    } finally {
      setLoading(false);
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

      const answer = await askLLM(g.goal, page, g.steps.slice(-3));
      setStatus('');
      setResult(answer);

      if (document.getElementById('highlightToggle').checked && answer.selector) {
        await highlight(tabId, answer.selector, answer.action_label);
      }

      g.steps.push({ url: page.url, action_label: answer.action_label, selector: answer.selector, t: Date.now() });
      g.lastUrl = page.url;
      await saveGuidance(g);
      updateSessionUI(g);
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