/* Button Buddy content script */
(() => {
  // Resolve server URL with flexible overrides for easier dev/testing:
  // 1) localStorage '__bb_server_url'
  // 2) window.__BB_SERVER_URL (settable via console or injected script)
  // 3) default to localhost:8787 (server default)
  const SERVER_URL = (() => {
    try {
      const fromLS = localStorage.getItem('__bb_server_url');
      if (fromLS && /^https?:\/\//.test(fromLS)) return fromLS;
    } catch (_) {}
    if (typeof window !== 'undefined' && window.__BB_SERVER_URL && /^https?:\/\//.test(window.__BB_SERVER_URL)) {
      return window.__BB_SERVER_URL;
    }
    return 'http://localhost:8787';
  })();

  let currentGoal = '';
  let lastResult = null;
  let overlay = null;
  let rerunTimer = null;

  const BB_UID_ATTR = 'data-bb-uid';
  let uidCounter = 1;

  function assignUid(el) {
    if (!el.getAttribute(BB_UID_ATTR)) {
      el.setAttribute(BB_UID_ATTR, `__bb_uid_${uidCounter++}`);
    }
    return el.getAttribute(BB_UID_ATTR);
  }

  function elementBounds(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
    if (r.width < 1 || r.height < 1) return false;
    // Check it or an ancestor is not hidden via 'hidden' attribute
    let cur = el;
    while (cur) {
      if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function hasClickHandler(el) {
    if (typeof el.onclick === 'function') return true;
    // Heuristic: pointer cursor and bounding box > small
    const style = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (style.cursor === 'pointer' && r.width > 8 && r.height > 8) return true;
    // Event listener detection (best effort)
    // Not generally available; skip deep hooks for v0
    return false;
  }

  function computeDomPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList.length && parts.length === 0) {
        const classes = Array.from(cur.classList).slice(0, 2).join('.');
        if (classes) part += '.' + classes;
      }
      const siblings = Array.from(cur.parentElement ? cur.parentElement.children : []);
      const sameTag = siblings.filter((s) => s.tagName === cur.tagName);
      if (sameTag.length > 1) {
        const index = sameTag.indexOf(cur) + 1;
        part += `:nth-of-type(${index})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function getLabelsForControl(el) {
    const labels = [];
    if ('labels' in el && el.labels) {
      for (const l of el.labels) {
        const t = (l.textContent || '').trim();
        if (t) labels.push(t);
      }
    }
    const ariaLabelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      for (const id of ariaLabelledby.split(/\s+/)) {
        const lab = document.getElementById(id);
        const t = lab ? (lab.textContent || '').trim() : '';
        if (t) labels.push(t);
      }
    }
    return labels.slice(0, 3);
  }

  function getTextShort(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  function getAncestorTextSample(el) {
    const pieces = [];
    let cur = el.parentElement;
    while (cur && pieces.join(' ').length < 140) {
      const t = (cur.getAttribute('aria-label') || '').trim();
      if (t) pieces.push(t);
      const heading = cur.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading) {
        const ht = (heading.textContent || '').trim();
        if (ht) pieces.push(ht);
      }
      cur = cur.parentElement;
    }
    const s = pieces.join(' • ');
    return s.length > 160 ? s.slice(0, 157) + '…' : s;
  }

  function normalize(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim();
  }

  function getAccessibleName(el) {
    // Priority: aria-label > aria-labelledby > associated <label> > alt/title > textContent
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const ariaLabelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      for (const id of ariaLabelledby.split(/\s+/)) {
        const lab = document.getElementById(id);
        const t = lab ? (lab.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (t) return t;
      }
    }

    if ('labels' in el && el.labels && el.labels.length) {
      for (const l of el.labels) {
        const t = (l.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }

    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const text = getTextShort(el);
    if (text) return text;
    return '';
  }

  // Debug helper: logs chosen element info and flashes magenta outline
  function bbDebugChosen(result) {
    try {
      if (!result) return null;
      const id = result.elementId || result.id || '';
      let node = null;
      if (id) {
        node = document.querySelector(`[${BB_UID_ATTR}="${id}"]`) || document.getElementById(id);
      }
      if (!node) return null;

      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const role = node.getAttribute ? (node.getAttribute('role') || '') : '';
      const type = node.getAttribute ? (node.getAttribute('type') || '') : '';
      const accName = getAccessibleName(node);
      const textSnippet = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const payload = { id, source: result.source || '', tag, role, type, accName, textSnippet };
      console.log('[BB]', payload);

      const prevOutline = node.style.outline;
      node.style.outline = '3px solid magenta';
      const t = setTimeout(() => {
        node.style.outline = prevOutline || '';
        clearTimeout(t);
      }, 1200);
      return node;
    } catch (_) {
      return null;
    }
  }

  function inferRole(el) {
    const roleAttr = el.getAttribute && el.getAttribute('role');
    if (roleAttr) return roleAttr;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return '';
  }

  function inferControlType(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type')) || '';
    const role = inferRole(el);
    if (tag === 'input') {
      if (type === 'submit' || role === 'button') return 'submit';
      if (['button', 'reset'].includes(type)) return type;
      if (['email', 'password', 'text', 'search', 'url', 'tel', 'number'].includes(type)) return type || 'text';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
    }
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (role === 'tab') return 'tab';
    if (role === 'menuitem') return 'menuitem';
    if (role === 'link' || role === 'button') return role;
    return tag;
  }

  function isDisabled(el) {
    if (el.hasAttribute && el.hasAttribute('disabled')) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function isClickable(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'button') return true;
    if (el.getAttribute && el.getAttribute('role')) {
      const r = el.getAttribute('role');
      if (['button', 'link', 'tab', 'menuitem'].includes(r)) return true;
    }
    if (hasClickHandler(el)) return true;
    return false;
  }

  function collectCandidates() {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]'
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(selector));
    const candidates = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const bounds = elementBounds(el);
      const clickable = isClickable(el);
      const disabled = isDisabled(el);
      if (!clickable && !(el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'select')) continue;
      const id = assignUid(el);
      const accName = getAccessibleName(el);
      const text = getTextShort(el);
      const role = inferRole(el);
      const controlType = inferControlType(el);
      const labels = getLabelsForControl(el);
      const href = el.getAttribute && el.getAttribute('href');
      const classes = Array.from(el.classList || []);
      const domPath = computeDomPath(el);
      const ancestorTextSample = getAncestorTextSample(el);
      const nameAttr = el.getAttribute && el.getAttribute('name');
      const placeholder = el.getAttribute && el.getAttribute('placeholder');
      const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      candidates.push({
        id,
        tag: el.tagName.toLowerCase(),
        role,
        type: (el.getAttribute && el.getAttribute('type')) || '',
        text,
        accName,
        ariaLabel: ariaLabel || '',
        nameAttr: nameAttr || '',
        placeholder: placeholder || '',
        labels,
        href: href || '',
        classes,
        bounds,
        visible: true,
        clickable: !!clickable,
        disabled: !!disabled,
        domPath,
        ancestorTextSample,
        confidenceHints: { keywordHits: [], locale: document.documentElement.lang || navigator.language || 'en' },
        controlType,
      });
    }
    return candidates;
  }

  function scoreCandidate(goalNorm, candidate) {
    // Tokenize goal
    const keywords = goalNorm.split(/\s+/).filter(Boolean);
    const hayAcc = normalize(candidate.accName);
    const hayText = normalize(candidate.text);
    const hayLabels = normalize((candidate.labels || []).join(' '));
    const hayAria = normalize(candidate.ariaLabel);
    const hayAnc = normalize(candidate.ancestorTextSample);

    let score = 0;

    if (goalNorm && (hayAcc.includes(goalNorm) || hayText.includes(goalNorm))) score += 3;

    let keywordHits = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      if (hayAcc.includes(kw) || hayText.includes(kw) || hayLabels.includes(kw) || hayAria.includes(kw)) {
        score += 2;
        keywordHits++;
      } else if (hayAnc.includes(kw)) {
        score += 1;
      }
    }

    // Role/type priors
    if (/password|security/.test(goalNorm)) {
      if (hayAnc.includes('password') || hayAnc.includes('security')) score += 2;
      if (candidate.controlType === 'password' || candidate.controlType === 'submit') score += 1;
    }
    if (/email|name/.test(goalNorm)) {
      if (['email', 'text'].includes(candidate.controlType) && keywordHits) score += 2;
      if (candidate.labels && candidate.labels.length) score += 1;
    }

    // Interactability/visibility bonuses
    if (candidate.clickable) score += 1;
    if (candidate.disabled) score -= 3;

    // Slight preference for medium-sized elements
    const area = (candidate.bounds?.w || 0) * (candidate.bounds?.h || 0);
    if (area > 200 && area < 200000) score += 0.5;

    return score;
  }

  function preRank(goal, candidates) {
    const goalNorm = normalize(goal);
    const scored = candidates.map((c) => ({ c, score: scoreCandidate(goalNorm, c) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 50).map((s) => {
      if (!s.c.confidenceHints) s.c.confidenceHints = {};
      s.c.confidenceHints.keywordHits = []; // can be set above if needed
      return s.c;
    });
    return { top, bestLocal: scored[0] ? scored[0].c : null, bestLocalScore: scored[0]?.score || 0 };
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = '__bb_overlay_root';
    overlay.style.position = 'absolute';
    overlay.style.left = '0px';
    overlay.style.top = '0px';
    overlay.style.width = '0px';
    overlay.style.height = '0px';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2147483647';

    const ring = document.createElement('div');
    ring.className = 'bb-ring';
    ring.style.position = 'absolute';
    ring.style.pointerEvents = 'none';
    overlay.appendChild(ring);

    const tooltip = document.createElement('div');
    tooltip.className = 'bb-tooltip';
    tooltip.style.position = 'absolute';
    tooltip.style.pointerEvents = 'auto';
    overlay.appendChild(tooltip);

    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function showOverlayFor(candidate, reason, confidence) {
    if (!candidate) return hideOverlay();
    ensureOverlay();
    const ring = overlay.querySelector('.bb-ring');
    const tooltip = overlay.querySelector('.bb-tooltip');
    const b = candidate.bounds;
    ring.style.left = b.x + 'px';
    ring.style.top = b.y + 'px';
    ring.style.width = b.w + 'px';
    ring.style.height = b.h + 'px';
    ring.style.border = '2px solid #5B9BFF';
    ring.style.borderRadius = '6px';
    ring.style.boxShadow = '0 0 0 2px rgba(91,155,255,0.2)';

    // If confidence is a number, compose legacy label; else treat reason as a precomposed label
    const label = typeof confidence === 'number'
      ? `${reason || 'Best match'} · ${Math.round(confidence || 0)}%`
      : (reason || '');
    tooltip.textContent = label;
    tooltip.style.left = Math.max(8, b.x) + 'px';
    tooltip.style.top = Math.max(0, b.y - 28) + 'px';
    tooltip.style.background = 'rgba(17,25,40,0.9)';
    tooltip.style.color = '#fff';
    tooltip.style.padding = '4px 6px';
    tooltip.style.borderRadius = '4px';
    tooltip.style.font = '12px/16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
  }

  async function rankWithServer(goal, topCandidates) {
    try {
      const resp = await fetch(`${SERVER_URL}/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, candidates: topCandidates })
      });
      if (!resp.ok) throw new Error('Bad response');
      return await resp.json();
    } catch (e) {
      return null;
    }
  }

  function reRankSoon(reason) {
    window.clearTimeout(rerunTimer);
    rerunTimer = window.setTimeout(() => {
      if (currentGoal) runFlow(currentGoal, reason || 'rerank');
    }, 400);
  }

  function attachCompletionDetectors(targetEl) {
    const area = targetEl.closest('form') || targetEl;
    const mo = new MutationObserver(() => reRankSoon('mutation'));
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener('popstate', () => reRankSoon('popstate'), { once: true });
    window.addEventListener('hashchange', () => reRankSoon('hashchange'), { once: true });
    if (targetEl instanceof HTMLInputElement || targetEl instanceof HTMLTextAreaElement || targetEl instanceof HTMLSelectElement) {
      const onChanged = () => reRankSoon('input');
      targetEl.addEventListener('change', onChanged, { once: true });
      targetEl.addEventListener('input', onChanged, { once: true });
    }
    // Clean up on next run by recreating observers per run
  }

  async function runFlow(goal, trigger) {
    const candidates = collectCandidates();
    if (candidates.length === 0) {
      hideOverlay();
      return;
    }
    const { top, bestLocal, bestLocalScore } = preRank(goal, candidates);
    // If very strong local score, show immediately with provisional confidence
    let provisional = null;
    if (bestLocal && bestLocalScore >= 4) {
      provisional = { elementId: bestLocal.id, reason: 'Local match', confidence: Math.min(95, 60 + Math.round(bestLocalScore * 6)), source: 'local' };
      // Debug before drawing overlay
      bbDebugChosen(provisional);
      const sourceLabel = provisional.source === 'local' ? 'Local match' : (provisional.source === 'llm' ? 'LLM rank' : 'Match');
      const tip = `${sourceLabel} • ${Math.round(provisional.confidence || 0)}% — ${provisional.reason || ''}`;
      showOverlayFor(bestLocal, tip);
    }
    // Ask server for final ranking
    const ranked = await rankWithServer(goal, top);
    if (!ranked) {
      if (!provisional) {
        const msg = { bounds: { x: 10, y: 10, w: 0, h: 0 } };
        showOverlayFor(msg, 'No good match yet; try rephrasing or navigate closer', 0);
      }
      return;
    }

    const chosen = candidates.find((c) => c.id === ranked.elementId) || bestLocal;
    if (!chosen) {
      hideOverlay();
      return;
    }
    lastResult = { ...ranked, source: 'llm' };
    // Debug before drawing overlay
    bbDebugChosen(lastResult);
    const sourceLabel = lastResult.source === 'local' ? 'Local match' : (lastResult.source === 'llm' ? 'LLM rank' : 'Match');
    const tip = `${sourceLabel} • ${Math.round(lastResult.confidence || 0)}% — ${lastResult.reason || ''}`;
    showOverlayFor(chosen, tip);
    attachCompletionDetectors(document.querySelector(`[${BB_UID_ATTR}="${chosen.id}"]`) || document.body);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg && msg.type === 'BB_FIND') {
      currentGoal = (msg.goal || '').trim();
      if (!currentGoal) return;
      runFlow(currentGoal, 'user');
    }
  });
})();


