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

async function ensureInjected(tabId) {
  // Inject content.js into the page if not already
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

// UPDATED: highlight now also passes the label text
async function highlight(tabId, selector, label) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'HIGHLIGHT', selector, label },
      () => resolve()
    );
  });
}

async function askLLM(query, page) {
  // DEV: local proxy to avoid exposing API key in the extension
  const res = await fetch('http://localhost:8787/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, page })
  });
  if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  return await res.json();
}

document.addEventListener('DOMContentLoaded', () => {
  const qEl = document.getElementById('query');

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      qEl.value = btn.dataset.q;
    });
  });

  document.getElementById('askBtn').addEventListener('click', async () => {
    setStatus('Scanning page…');
    setResult('');
    const query = qEl.value.trim() || 'Find account settings';

    try {
      const tabId = await getActiveTabId();
      if (!tabId) throw new Error('No active tab');

      await ensureInjected(tabId);
      const page = await scrapePage(tabId);

      setStatus('Thinking…');
      const answer = await askLLM(query, page);

      setStatus('');
      setResult(answer);

      // UPDATED: pass both selector + label into highlighter
      if (document.getElementById('highlightToggle').checked && answer.selector) {
        await highlight(tabId, answer.selector, answer.action_label);
      }
    } catch (err) {
      setStatus('Error');
      setResult(String(err));
    }
  });
});