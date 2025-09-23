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

// ---- Last query storage helpers ----
async function loadLastQuery() {
  const res = await chrome.storage.local.get('lastQuery');
  return res.lastQuery || '';
}
async function saveLastQuery(query) {
  await chrome.storage.local.set({ lastQuery: query || '' });
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
  const askBtn = document.getElementById('askBtn');

  // load existing session state (if any)
  const initial = await loadGuidance();
  updateSessionUI(initial);

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