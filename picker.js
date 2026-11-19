/* Element picker for the local preview.
 *
 * Loaded only by serve.py — never deployed. Click a badge (bottom left) or use
 * the keys, hover to outline, click to pick. The pick is POSTed to the dev
 * server, which writes picks/last-pick.json so the agent can read exactly
 * which node was pointed at.
 *
 * Modes
 *   pick   badge / Alt+I — one pick, then disarms. A dashed marker and a
 *          live-edit box stay on the node: type "prop: value", Enter applies
 *          it to el.style and POSTs /__edit so you see the change before any
 *          source edit (an empty value removes the property).
 *   queue  badge / Alt+Q — stays armed. Each click drops a numbered pin and
 *          asks for a one-line note; Enter commits it to the server-side
 *          queue (POST /__picks, read back with GET /__picks). Esc ends.
 *
 * A pick carries pageX/pageY (unambiguous below the fold), the matched CSS
 * rules in cascade order plus the inline style, and pierces shadow roots —
 * the selector crosses each boundary with " >>> ". Same-origin iframes get
 * their own picker instance via injection and report their frame chain.
 */
(() => {
  if (window.__pickerLoaded) return;
  window.__pickerLoaded = true;

  const INK = '#050505';
  const PAPER = '#f2f0ea';
  const ACCENT = '#b8492a';
  const IN_FRAME = window.self !== window.top;

  const keysOfInterest = [
    'display', 'position', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-transform', 'color', 'background-color', 'padding',
    'margin', 'gap', 'border-top', 'opacity', 'transform', 'grid-template-columns',
  ];

  let on = false;
  let queueMode = false;
  let hovering = null;
  let markerEl = null;
  let queueSerial = 0;
  let pendingQueue = null;
  const pins = [];

  // ---- ui ----------------------------------------------------------------

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.textContent = 'pick';
  Object.assign(badge.style, {
    position: 'fixed', left: '10px', bottom: '10px', zIndex: 2147483647,
    font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.12em',
    textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
    color: INK, background: PAPER, border: '0', borderRadius: '0',
    opacity: '0.35', transition: 'opacity .15s ease',
  });
  badge.title = 'Pick an element (Alt+I)';

  const badgeQueue = document.createElement('button');
  badgeQueue.type = 'button';
  badgeQueue.textContent = 'queue';
  Object.assign(badgeQueue.style, {
    position: 'fixed', left: '10px', bottom: '44px', zIndex: 2147483647,
    font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.12em',
    textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
    color: INK, background: PAPER, border: '0', borderRadius: '0',
    opacity: '0.35', transition: 'opacity .15s ease',
  });
  badgeQueue.title = 'Queue several picks with notes (Alt+Q)';

  const outline = document.createElement('div');
  Object.assign(outline.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
    outline: `1px solid ${PAPER}`, background: 'rgba(242,240,234,0.08)',
    display: 'none',
  });

  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483647,
    font: '10px/1.5 ui-monospace, monospace', letterSpacing: '0.08em',
    padding: '3px 7px', background: PAPER, color: INK, display: 'none',
    whiteSpace: 'nowrap',
  });

  // persistent marker on the last single pick (page coords, scrolls for free)
  const marker = document.createElement('div');
  Object.assign(marker.style, {
    position: 'absolute', pointerEvents: 'none', zIndex: 2147483645,
    outline: `1.5px dashed ${ACCENT}`, display: 'none',
  });
  const markerTag = document.createElement('div');
  Object.assign(markerTag.style, {
    position: 'absolute', left: '0', top: '0', transform: 'translateY(-100%)',
    font: '10px/1.7 ui-monospace, monospace', letterSpacing: '0.1em',
    textTransform: 'uppercase', background: INK, color: PAPER,
    padding: '2px 7px', whiteSpace: 'nowrap',
  });
  marker.appendChild(markerTag);

  // live edit box shown after a single pick
  const editBox = document.createElement('div');
  Object.assign(editBox.style, {
    position: 'fixed', zIndex: 2147483647, display: 'none',
    background: INK, color: PAPER, padding: '8px 10px', borderRadius: '2px',
    font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.05em',
    boxShadow: '0 6px 24px rgba(0,0,0,.35)',
  });
  const editRow = document.createElement('div');
  Object.assign(editRow.style, { display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' });
  const editLabel = document.createElement('span');
  editLabel.textContent = 'live edit — applied to el.style, POSTed to /__edit';
  Object.assign(editLabel.style, { textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '9px', color: '#8f8d85' });
  const editClose = document.createElement('button');
  editClose.type = 'button';
  editClose.textContent = '\u2715 esc';
  Object.assign(editClose.style, {
    font: 'inherit', fontSize: '9px', color: '#8f8d85', background: 'transparent',
    border: '0', cursor: 'pointer', padding: '0', letterSpacing: '0.1em',
  });
  editRow.append(editLabel, editClose);
  const editInput = document.createElement('input');
  editInput.placeholder = 'prop: value — e.g. color: #b8492a';
  Object.assign(editInput.style, {
    font: 'inherit', color: PAPER, background: 'transparent', border: '0',
    borderBottom: '1px solid #55524b', outline: 'none', width: '250px',
    padding: '4px 2px',
  });
  const editHint = document.createElement('div');
  editHint.textContent = 'enter applies · empty value removes the prop · esc closes';
  Object.assign(editHint.style, { color: '#8f8d85', fontSize: '9px', marginTop: '5px' });
  editBox.append(editRow, editInput, editHint);

  // note box for queue picks
  const noteBox = document.createElement('div');
  Object.assign(noteBox.style, {
    position: 'fixed', zIndex: 2147483647, display: 'none',
    background: INK, color: PAPER, padding: '8px 10px', borderRadius: '2px',
    font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.05em',
    boxShadow: '0 6px 24px rgba(0,0,0,.35)',
  });
  const noteLabel = document.createElement('div');
  Object.assign(noteLabel.style, { textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '9px', color: '#8f8d85', marginBottom: '6px' });
  const noteInput = document.createElement('input');
  noteInput.placeholder = 'note for this pick (optional)';
  Object.assign(noteInput.style, {
    font: 'inherit', color: PAPER, background: 'transparent', border: '0',
    borderBottom: '1px solid #55524b', outline: 'none', width: '230px',
    padding: '4px 2px',
  });
  const noteHint = document.createElement('div');
  noteHint.textContent = 'enter commits to the queue · esc skips this pick';
  Object.assign(noteHint.style, { color: '#8f8d85', fontSize: '9px', marginTop: '5px' });
  noteBox.append(noteLabel, noteInput, noteHint);

  // ---- helpers -----------------------------------------------------------

  function isOurUi(t) {
    return t === badge || t === badgeQueue || editBox.contains(t) || noteBox.contains(t);
  }

  function targetOf(e) {
    // composedPath()[0] is the real innermost target even inside shadow roots
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    return t instanceof Element ? t : null;
  }

  function nthOf(n) {
    if (!n.parentElement) return '';
    const sibs = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
    if (sibs.length < 2) return '';
    return `:nth-of-type(${sibs.indexOf(n) + 1})`;
  }

  function segmentsWithin(el, root, force) {
    // selector segments for el relative to its own root (document or shadow
    // root); stops at the boundary so the caller can stitch pieces across it.
    // force pins every level that has same-tag siblings — identical sibling
    // chains (seven div.wrap under main) leave the plain path ambiguous, and
    // anything re-resolving the selector (a watcher, a marker) would grab the
    // first match instead of the picked node.
    const isDoc = root && root.nodeType === 9;
    const top = isDoc ? root.documentElement : null;
    const segs = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== top) {
      if (n.id) {
        segs.unshift('#' + CSS.escape(n.id));
        break;
      }
      let s = n.tagName.toLowerCase();
      if (n.classList.length) s += '.' + [...n.classList].map((c) => CSS.escape(c)).join('.');
      if (force || !n.classList.length) s += nthOf(n);
      segs.unshift(s);
      n = n.parentElement;
      if (!n) break; // top of a shadow tree
    }
    return segs;
  }

  function selectorFor(el) {
    const build = (force) => {
      const pieces = [];
      let n = el;
      let shadow = false;
      for (;;) {
        const root = n.getRootNode();
        const piece = segmentsWithin(n, root, force).join(' > ') || n.tagName.toLowerCase();
        let matches = 1;
        try { matches = root.querySelectorAll(piece).length; } catch { /* bad piece */ }
        pieces.push({ piece, matches });
        if (root instanceof ShadowRoot) {
          shadow = true;
          n = root.host;
          continue;
        }
        break;
      }
      return { pieces: pieces.reverse(), shadow };
    };
    let { pieces, shadow } = build(false);
    if (pieces.some((p) => p.matches > 1)) {
      const forced = build(true);
      const worse = (list) => list.filter((p) => p.matches > 1).length;
      if (worse(forced.pieces) < worse(pieces)) {
        pieces = forced.pieces;
        shadow = forced.shadow;
      }
    }
    const sel = pieces.map((p) => p.piece).join(shadow ? ' >>> ' : ' > ');
    const bad = pieces.find((p) => p.matches > 1);
    let out = sel;
    if (bad) {
      // never pretend a selector is unique — say which piece is ambiguous
      out += shadow ? `  /* piece "${bad.piece}": ${bad.matches} matches */` : `  /* ${bad.matches} matches */`;
    }
    return { selector: out, shadow };
  }

  function frameChain() {
    if (!IN_FRAME) return [];
    const chain = [];
    let w = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement; // null across origins, throws from sandboxed
        if (!fe) break;
        chain.unshift(selectorFor(fe).selector);
        w = w.parent;
      }
    } catch { /* cross-origin parent */ }
    return chain;
  }

  function inlineStyleOf(el) {
    const out = {};
    for (let i = 0; i < el.style.length; i += 1) {
      const p = el.style.item(i);
      out[p] = el.style.getPropertyValue(p);
    }
    return out;
  }

  function matchedRules(el) {
    // walk the sheets that actually style this tree and report every rule the
    // element matches, in document (cascade) order — document rules do not
    // cross a shadow boundary, so a shadow pick only sees the root's sheets.
    const out = [];
    const root = el.getRootNode();
    const sheetList = [];
    try {
      if (root instanceof ShadowRoot) sheetList.push(...root.styleSheets);
      else if (root === document) sheetList.push(...document.styleSheets);
    } catch { /* exotic root */ }
    const walk = (rules, media) => {
      for (const rule of rules) {
        if (typeof rule.selectorText === 'string' && rule.style) {
          let hit = false;
          try { hit = el.matches(rule.selectorText); } catch { continue; }
          if (hit) {
            // cssText keeps the authored declarations ("font: inherit") without
            // expanding shorthands into a wall of longhands
            const props = {};
            rule.style.cssText.split(';').forEach((chunk) => {
              const s = chunk.trim();
              const i = s.indexOf(':');
              if (i < 1) return;
              props[s.slice(0, i).trim()] = s.slice(i + 1).trim();
            });
            out.push({ selector: rule.selectorText, media: media || null, props });
          }
        } else if (rule.cssRules) {
          const m = rule.media && rule.media.mediaText
            ? (media ? media + ' and ' : '') + rule.media.mediaText : media;
          try { walk(rule.cssRules, m); } catch { /* cross-origin group rule */ }
        }
      }
    };
    for (const sheet of sheetList) {
      try { walk(sheet.cssRules, null); } catch { /* cross-origin sheet */ }
    }
    return out;
  }

  function pagePoint(el, ev) {
    if (ev && typeof ev.pageX === 'number' && typeof ev.pageY === 'number') {
      return { pageX: Math.round(ev.pageX), pageY: Math.round(ev.pageY) };
    }
    const r = el.getBoundingClientRect();
    return {
      pageX: Math.round(r.x + scrollX + r.width / 2),
      pageY: Math.round(r.y + scrollY + r.height / 2),
    };
  }

  function describe(el, ev) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const sel = selectorFor(el);
    const chain = [];
    let p = el.parentElement;
    for (let i = 0; p && i < 4; i += 1, p = p.parentElement) {
      chain.push({
        tag: p.tagName.toLowerCase(),
        classes: [...p.classList],
        selector: selectorFor(p).selector,
      });
    }
    const styles = {};
    keysOfInterest.forEach((k) => { styles[k] = cs.getPropertyValue(k); });
    const out = {
      ts: Date.now(),
      url: location.href,
      selector: sel.selector,
      shadow: sel.shadow,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList],
      text: (el.textContent || '').trim().slice(0, 160),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      point: pagePoint(el, ev),
      rules: matchedRules(el),
      inlineStyle: inlineStyleOf(el),
      styles,
      parents: chain,
    };
    const fc = frameChain();
    if (fc.length) out.frame = fc;
    return out;
  }

  // ---- outline / marker / pins -------------------------------------------

  function place(el) {
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, {
      display: 'block', left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
    const label = `${IN_FRAME ? 'frame \u00b7 ' : ''}${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList][0] : ''} \u00b7 ${Math.round(r.width)}\u00d7${Math.round(r.height)}`;
    tip.textContent = label;
    Object.assign(tip.style, {
      display: 'block',
      left: `${Math.min(r.left, innerWidth - tip.offsetWidth - 4)}px`,
      top: `${Math.max(2, r.top - 22)}px`,
    });
  }

  function clear() {
    hovering = null;
    outline.style.display = 'none';
    tip.style.display = 'none';
  }

  function hideMarker() {
    markerEl = null;
    marker.style.display = 'none';
  }

  function placeMarker() {
    if (!markerEl || !markerEl.isConnected) { hideMarker(); return; }
    const r = markerEl.getBoundingClientRect();
    Object.assign(marker.style, {
      left: `${r.x + scrollX}px`, top: `${r.y + scrollY}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  function showMarker(el) {
    markerEl = el;
    placeMarker();
    markerTag.textContent = `picked \u00b7 ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`;
    marker.style.display = 'block';
  }

  function makePin(n, el) {
    const pin = document.createElement('div');
    pin.textContent = String(n);
    Object.assign(pin.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: 2147483645,
      font: '11px/1.5 ui-monospace, monospace', background: ACCENT, color: PAPER,
      padding: '1px 6px', borderRadius: '999px',
    });
    document.body.append(pin);
    placePin(pin, el);
    return pin;
  }

  function placePin(pin, el) {
    const r = el.getBoundingClientRect();
    pin.style.left = `${Math.round(r.x + scrollX - 10)}px`;
    pin.style.top = `${Math.round(r.y + scrollY - 10)}px`;
  }

  window.addEventListener('resize', () => {
    if (markerEl) placeMarker();
    pins.forEach(({ pin, el }) => placePin(pin, el));
  });

  // ---- edit box ----------------------------------------------------------

  function showEditBox(el) {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    editBox.style.display = 'block';
    editBox.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 280))}px`;
    editBox.style.top = `${Math.max(8, Math.min(r.bottom + 8, innerHeight - 130))}px`;
    editInput.value = '';
    editInput.focus();
  }

  function hideEditBox() {
    editBox.style.display = 'none';
  }

  async function applyStyle(el, prop, value) {
    let prior = null;
    try { prior = el.style.getPropertyValue(prop) || null; } catch { /* unset */ }
    if (value) el.style.setProperty(prop, value);
    else el.style.removeProperty(prop);
    const payload = {
      selector: selectorFor(el).selector, prop, value: value || '', prior,
      tag: el.tagName.toLowerCase(), url: location.href, ts: Date.now(),
    };
    try {
      await fetch('/__edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // no endpoint: the change is still live in the page, log it for recovery
      console.log('[picker:edit]', JSON.stringify(payload));
    }
    return payload;
  }

  async function applyEdit() {
    const raw = editInput.value.trim();
    if (!raw || !markerEl) return;
    const i = raw.indexOf(':');
    if (i < 1) {
      editInput.style.borderBottom = `2px solid ${ACCENT}`;
      setTimeout(() => { editInput.style.borderBottom = '1px solid #55524b'; }, 900);
      return;
    }
    const prop = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    await applyStyle(markerEl, prop, value);
    editInput.value = '';
    editInput.style.borderBottom = `2px solid ${ACCENT}`;
    setTimeout(() => { editInput.style.borderBottom = '1px solid #55524b'; }, 600);
  }

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyEdit();
    }
  });

  editClose.addEventListener('click', () => {
    hideEditBox();
    hideMarker();
  });

  // ---- queue -------------------------------------------------------------

  function setQueueBase() {
    badgeQueue.textContent = queueMode ? 'queue \u00b7 on' : 'queue';
  }

  async function commitQueuePick() {
    if (!pendingQueue) return;
    const { data, pin, n } = pendingQueue;
    const note = noteInput.value.trim() || null;
    pendingQueue = null;
    noteBox.style.display = 'none';
    data.note = note;
    try {
      const res = await fetch('/__picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick: data, note }),
      });
      const j = await res.json().catch(() => ({}));
      badgeQueue.textContent = `queued ${(j && j.index) || n} \u2713`;
    } catch {
      console.log('[picker:queue]', JSON.stringify(data));
      badgeQueue.textContent = 'logged \u2192';
    }
    setTimeout(setQueueBase, 1400);
  }

  function cancelQueuePick() {
    if (!pendingQueue) return;
    const { pin } = pendingQueue;
    pin.remove();
    const i = pins.findIndex((p) => p.pin === pin);
    if (i >= 0) pins.splice(i, 1);
    queueSerial = Math.max(0, queueSerial - 1);
    pendingQueue = null;
    noteBox.style.display = 'none';
  }

  function queuePick(el, ev) {
    if (pendingQueue) commitQueuePick(); // a new click commits the previous note
    const data = describe(el, ev);
    queueSerial += 1;
    const pin = makePin(queueSerial, el);
    pins.push({ pin, el });
    pendingQueue = { data, pin, n: queueSerial };
    const r = el.getBoundingClientRect();
    noteLabel.textContent = `note \u00b7 pick ${queueSerial}`;
    noteBox.style.display = 'block';
    noteBox.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 260))}px`;
    noteBox.style.top = `${Math.max(8, Math.min(r.bottom + 8, innerHeight - 110))}px`;
    noteInput.value = '';
    noteInput.focus();
  }

  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitQueuePick();
    }
  });

  // ---- mode switches -----------------------------------------------------

  function setOn(next) {
    on = next;
    if (next) setQueue(false);
    badge.style.opacity = on ? '1' : '0.35';
    badge.style.background = on ? '#8f8d85' : PAPER;
    if (!on) clear();
  }

  function setQueue(next) {
    if (next) setOn(false);
    queueMode = next;
    if (!next && pendingQueue) cancelQueuePick();
    badgeQueue.style.opacity = queueMode ? '1' : '0.35';
    badgeQueue.style.background = queueMode ? '#8f8d85' : PAPER;
    setQueueBase();
    if (!queueMode) clear();
  }

  // ---- picking -----------------------------------------------------------

  async function pick(el, ev) {
    const data = describe(el, ev);
    try {
      await fetch('/__pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      badge.textContent = 'picked \u2713';
    } catch {
      // no endpoint (script dropped into a dev server by hand): fall back to
      // the console and the clipboard so the pick is still recoverable
      console.log('[picker]', JSON.stringify(data, null, 2));
      try {
        await navigator.clipboard.writeText(data.selector);
        badge.textContent = 'copied \u2713';
      } catch {
        badge.textContent = 'logged \u2192';
      }
    }
    setTimeout(() => { badge.textContent = 'pick'; }, 1400);
    showMarker(el);
    showEditBox(el);
  }

  // ---- drag sweeping ------------------------------------------------------
  // While picking, mousedown is swallowed (that is what stops native text
  // selection); the click after a press-drag-release still fires — on the
  // nearest common ancestor — so sweeping across several divs captures the div
  // that contains them. Mid-drag the outline expands to that ancestor instead
  // of letting the browser highlight text.

  let dragEl = null;

  function chainOf(el) {
    const list = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      list.push(n);
      n = n.parentElement;
    }
    return list;
  }

  function commonAncestor(a, b) {
    if (a === b) return a;
    const chain = chainOf(a);
    let n = b;
    while (n && n.nodeType === 1) {
      if (chain.includes(n)) return n;
      n = n.parentElement;
    }
    return document.documentElement;
  }

  document.addEventListener('mousedown', (e) => {
    if (!on && !queueMode) return;
    if (e.button !== 0) return;
    const el = targetOf(e);
    if (!el || isOurUi(el)) return;
    e.preventDefault();
    e.stopPropagation();
    dragEl = el;
  }, true);

  document.addEventListener('mouseup', () => { dragEl = null; }, true);

  document.addEventListener('dragstart', (e) => {
    if (!on && !queueMode) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('selectstart', (e) => {
    if (!on && !queueMode) return;
    if (isOurUi(e.target)) return;
    e.preventDefault();
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!on && !queueMode) return;
    const el = targetOf(e);
    if (!el || isOurUi(el)) return;
    if (dragEl && el !== dragEl) {
      // mid-drag: the outline expands around everything swept so far — the
      // ancestor the release will actually capture
      place(commonAncestor(dragEl, el));
      return;
    }
    if (el === hovering) return;
    hovering = el;
    place(el);
  }, true);

  document.addEventListener('click', (e) => {
    if (!on && !queueMode) return;
    const el = targetOf(e);
    if (!el || isOurUi(el)) return;
    e.preventDefault();
    e.stopPropagation();
    if (queueMode) queuePick(el, e);
    else pick(el, e).then(() => setOn(false));
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (pendingQueue) { cancelQueuePick(); return; }
      if (editBox.style.display === 'block') { hideEditBox(); hideMarker(); return; }
      setOn(false);
      setQueue(false);
      hideMarker();
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      setOn(!on);
    }
    if (e.altKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      setQueue(!queueMode);
    }
  }, true);

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOn(!on);
  });

  badgeQueue.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setQueue(!queueMode);
  });

  function mount() {
    document.body.append(outline, tip, badge, badgeQueue, marker, editBox, noteBox);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // scriptable handle: lets a driver (or another agent) pick without the mouse
  window.__picker = {
    on: () => setOn(true),
    off: () => { setOn(false); setQueue(false); },
    queue: (v) => setQueue(v !== false),
    describe: (target) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      return el ? describe(el, null) : null;
    },
    pick: async (target) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) return null;
      await pick(el, null);
      setOn(false);
      return el;
    },
    edit: async (target, prop, value) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el || !prop) return null;
      return applyStyle(el, prop, value || '');
    },
  };
})();
