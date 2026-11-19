/* Element picker for the local preview.
 *
 * Loaded only by dev/serve.py — never deployed. Click the badge (bottom left)
 * or press Alt+I, hover to outline, click to pick. The pick is POSTed to the
 * dev server, which writes dev/last-pick.json so the agent can read exactly
 * which node was pointed at.
 */
(() => {
  if (window.__pickerLoaded) return;
  window.__pickerLoaded = true;

  const keysOfInterest = [
    'display', 'position', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-transform', 'color', 'background-color', 'padding',
    'margin', 'gap', 'border-top', 'opacity', 'transform', 'grid-template-columns',
  ];

  let on = false;
  let hovering = null;

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.textContent = 'pick';
  Object.assign(badge.style, {
    position: 'fixed', left: '10px', bottom: '10px', zIndex: 2147483647,
    font: '11px/1.4 ui-monospace, monospace', letterSpacing: '0.12em',
    textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
    color: '#050505', background: '#f2f0ea', border: '0', borderRadius: '0',
    opacity: '0.35', transition: 'opacity .15s ease',
  });
  badge.title = 'Pick an element (Alt+I)';

  const outline = document.createElement('div');
  Object.assign(outline.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
    outline: '1px solid #f2f0ea', background: 'rgba(242,240,234,0.08)',
    display: 'none',
  });

  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: 2147483647,
    font: '10px/1.5 ui-monospace, monospace', letterSpacing: '0.08em',
    padding: '3px 7px', background: '#f2f0ea', color: '#050505', display: 'none',
    whiteSpace: 'nowrap',
  });

  function selectorFor(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.id) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      let s = n.tagName.toLowerCase();
      if (n.classList.length) s += '.' + [...n.classList].map((c) => CSS.escape(c)).join('.');
      else {
        const sibs = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    const sel = parts.join(' > ');
    try {
      const n2 = document.querySelectorAll(sel).length;
      return n2 === 1 ? sel : sel + `  /* ${n2} matches */`;
    } catch {
      return sel;
    }
  }

  function describe(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const chain = [];
    let p = el.parentElement;
    for (let i = 0; p && i < 4; i += 1, p = p.parentElement) {
      chain.push({
        tag: p.tagName.toLowerCase(),
        classes: [...p.classList],
        selector: selectorFor(p),
      });
    }
    const styles = {};
    keysOfInterest.forEach((k) => { styles[k] = cs.getPropertyValue(k); });
    return {
      ts: Date.now(),
      url: location.href,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList],
      text: (el.textContent || '').trim().slice(0, 160),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      styles,
      parents: chain,
    };
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, {
      display: 'block', left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
    const label = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList][0] : ''} · ${Math.round(r.width)}×${Math.round(r.height)}`;
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

  function setOn(next) {
    on = next;
    badge.style.opacity = on ? '1' : '0.35';
    badge.style.background = on ? '#8f8d85' : '#f2f0ea';
    if (!on) clear();
  }

  async function pick(el) {
    const data = describe(el);
    try {
      await fetch('/__pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      badge.textContent = 'picked ✓';
    } catch {
      // no endpoint (script dropped into a dev server by hand): fall back to
      // the console and the clipboard so the pick is still recoverable
      console.log('[picker]', JSON.stringify(data, null, 2));
      try {
        await navigator.clipboard.writeText(data.selector);
        badge.textContent = 'copied ✓';
      } catch {
        badge.textContent = 'logged →';
      }
    }
    setTimeout(() => { badge.textContent = 'pick'; }, 1400);
  }

  document.addEventListener('mousemove', (e) => {
    if (!on) return;
    const el = e.target;
    if (!(el instanceof Element) || el === badge) return;
    if (el === hovering) return;
    hovering = el;
    place(el);
  }, true);

  document.addEventListener('click', (e) => {
    if (!on) return;
    const el = e.target;
    if (el === badge) return;
    e.preventDefault();
    e.stopPropagation();
    pick(el).then(() => setOn(false));
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      setOn(!on);
    }
    if (e.key === 'Escape') setOn(false);
  }, true);

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOn(!on);
  });

  function mount() {
    document.body.append(outline, tip, badge);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // scriptable handle: lets a driver (or another agent) pick without the mouse
  window.__picker = {
    on: () => setOn(true),
    off: () => setOn(false),
    describe: (target) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      return el ? describe(el) : null;
    },
    pick: async (target) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) return null;
      await pick(el);
      setOn(false);
      return el;
    },
  };
})();
