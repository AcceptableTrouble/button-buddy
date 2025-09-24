(function () {
  // ---------- visibility & scraping helpers ----------
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (rect.width === 0 || rect.height === 0) return false;
    return true; // allow offscreen; we can scroll later
  }

  function getText(el) {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 200);
  }

  function getRole(el) {
    return el.getAttribute('role') || el.tagName.toLowerCase();
  }

  function getUniqueSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let selector = node.nodeName.toLowerCase();
      if (node.classList.length && node.classList.length < 4) {
        selector += '.' + [...node.classList].slice(0, 3).map(c => CSS.escape(c)).join('.');
      }
      const siblingTagName = node.nodeName.toLowerCase();
      let index = 1, sib = node;
      while ((sib = sib.previousElementSibling) != null) {
        if (sib.nodeName.toLowerCase() === siblingTagName) index++;
      }
      selector += `:nth-of-type(${index})`;
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  function elementToItem(el) {
    const rect = el.getBoundingClientRect();
    return {
      type: el.tagName.toLowerCase(),
      role: getRole(el),
      text: getText(el),
      ariaLabel: el.getAttribute('aria-label') || null,
      name: el.name || null,
      href: el.getAttribute('href') || null,
      selector: getUniqueSelector(el),
      bounding: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }

  function collectElements() {
    const nodes = document.querySelectorAll(`
      a, button, [role="button"],
      input[type="button"], input[type="submit"],
      [data-testid], [aria-label]
    `);

    const items = [];
    nodes.forEach(el => {
      if (!isVisible(el)) return;
      const textish =
        getText(el) ||
        el.getAttribute('aria-label') ||
        el.name ||
        el.getAttribute('data-testid') ||
        '';
      if (!textish) return;
      items.push(elementToItem(el));
    });

    const headings = [...document.querySelectorAll('h1,h2,h3,nav [role="menuitem"], [role="link"]')]
      .filter(isVisible)
      .slice(0, 50)
      .map(elementToItem);

    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || null,
      elements: items.slice(0, 400),
      context: headings
    };
  }

  // ---------- highlight & tooltip helpers ----------
  function elFromXPath(xpath) {
    try {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue || null;
    } catch { return null; }
  }

  function resolveSelectorStrict(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function resolveTarget(selectorOrText, opts = {}) {
    if (!selectorOrText) return null;
    const allowFuzzy = opts.allowFuzzy !== false;

    // 1) Try CSS selector
    try {
      const cssHit = document.querySelector(selectorOrText);
      if (cssHit) return cssHit;
    } catch {}

    if (!allowFuzzy) return null;

    // 2) Try XPath if it looks like XPath or CSS failed
    if (selectorOrText.startsWith('/') || selectorOrText.startsWith('(')) {
      const xpHit = elFromXPath(selectorOrText);
      if (xpHit) return xpHit;
    }

    // 3) Fallback: fuzzy text match on common clickables
    const text = selectorOrText.trim();
    if (text && text.length < 120) {
      const candidates = [...document.querySelectorAll(
        'a,button,[role="button"],[aria-label],[role="link"],input[type="submit"],input[type="button"]'
      )];
      const lower = text.toLowerCase();
      const hit = candidates.find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        return (t && t.includes(lower)) || (aria && aria.includes(lower));
      });
      if (hit) return hit;
    }

    return null;
  }

  function scrollIntoViewCenter(el) {
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch {}
  }

  // UPDATED: absolute positioning with scroll offsets (more reliable)
  function outline(el) {
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = (rect.left + window.scrollX) + 'px';
    box.style.top = (rect.top + window.scrollY) + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.style.border = '2px solid #ff57a6';
    box.style.borderRadius = '8px';
    box.style.background = 'rgba(255,87,166,0.12)';
    box.style.zIndex = 2147483647;
    box.style.pointerEvents = 'none';
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3500);
  }

  // UPDATED: absolute positioning with scroll offsets for tooltip too
  function makeTooltip(el, label) {
    const rect = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.textContent = label || 'Try clicking this';
    tip.style.position = 'absolute';
    tip.style.left = (rect.left + rect.width / 2 + window.scrollX) + 'px';
    tip.style.top = (rect.top + window.scrollY - 10) + 'px';
    tip.style.transform = 'translate(-50%, -100%)';
    tip.style.background = '#ff57a6';
    tip.style.color = '#fff';
    tip.style.padding = '6px 8px';
    tip.style.font = '12px/1.1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    tip.style.borderRadius = '8px';
    tip.style.boxShadow = '0 6px 20px rgba(0,0,0,0.12)';
    tip.style.zIndex = 2147483647;
    tip.style.pointerEvents = 'none';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 3500);
  }

  function showOverlayAdvanced(selectorOrText, label, opts = {}) {
    console.log('[ButtonBuddy] highlight called with:', selectorOrText, label);
    const target = opts.strictSelector ? resolveSelectorStrict(selectorOrText) : resolveTarget(selectorOrText, { allowFuzzy: !opts.strictSelector });
    if (!target) {
      console.warn('[ButtonBuddy] No target resolved for:', selectorOrText);
      return false;
    }
    console.log('[ButtonBuddy] Target found:', target);
    scrollIntoViewCenter(target);
    // give the browser a tick to settle after scroll for correct rects
    setTimeout(() => {
      outline(target);
      makeTooltip(target, label);
    }, 50);
    return true;
  }

  // ---------- message bridge ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_PAGE') {
      const data = collectElements();
      sendResponse(data);
      return true;
    }
    if (msg.type === 'HIGHLIGHT') {
      const success = showOverlayAdvanced(msg.selector, msg.label || 'Try clicking this', { strictSelector: Boolean(msg.strictSelector) });
      sendResponse({ ok: Boolean(success) });
      return true;
    }
    if (msg.type === 'VALIDATE_SELECTOR') {
      const el = resolveSelectorStrict(msg.selector);
      sendResponse({ ok: Boolean(el) });
      return true;
    }
  });
})();

