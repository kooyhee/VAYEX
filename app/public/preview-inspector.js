/**
 * Design-mode element inspector for the live preview frame.
 *
 * Loaded into a same-origin preview page (`/preview/*`) by the workspace, never
 * into this page's own shell. It communicates only through postMessage: the
 * parent toggles it with `{ type:'omp:design-mode', enabled }` and receives
 * `{ type:'omp:element-selected', selector, tag, text, styles }` on a click.
 * Nothing is sent to a model, and the overlay never intercepts the preview's own
 * pointer events (it is `pointer-events:none`).
 */
(function () {
  if (window.__ompInspector) return;
  window.__ompInspector = true;

  let active = false;
  // Element under the pointer at the last pointerdown. Only a pointer press arms the
  // click interception below; a keyboard-generated click has no pointerdown before it.
  let pressed = null;

  const overlay = document.createElement('div');
  overlay.id = 'omp-inspector-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = [
    'position:fixed', 'pointer-events:none', 'z-index:2147483647',
    'border:2px solid #3b82f6', 'background:rgba(59,130,246,.18)',
    'border-radius:3px', 'display:none', 'box-sizing:border-box'
  ].join(';');
  (document.body || document.documentElement).appendChild(overlay);

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return (el?.tagName || '').toLowerCase();
    if (el.id) return `#${el.id}`;
    let name = el.tagName.toLowerCase();
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(c => c && !c.includes('omp-inspector')).slice(0, 2)
      : [];
    if (classes.length) name += `.${classes.join('.')}`;
    const parent = el.parentElement;
    if (parent && parent !== document.body) {
      const same = Array.from(parent.children).filter(node => node.tagName === el.tagName);
      if (same.length > 1) name += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return name;
  }

  function hide() {
    overlay.style.display = 'none';
  }

  function highlight(el) {
    if (!active || !el) return hide();
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  const ATTR_KEYS = ['id', 'role', 'aria-label', 'name', 'type', 'href', 'src', 'placeholder', 'title'];

  function attributesOf(el) {
    const out = {};
    for (const name of ATTR_KEYS) {
      const value = el.getAttribute(name);
      if (value) out[name] = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    const className = typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, ' ') : '';
    if (className) out.class = className.slice(0, 80);
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith('data-')) continue;
      if (out[attr.name]) continue;
      out[attr.name] = attr.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    return out;
  }

  function capture(el) {
    const computed = window.getComputedStyle(el);
    const pick = ['display', 'color', 'background-color', 'font-size', 'font-weight', 'padding', 'margin', 'border-radius'];
    const styles = {};
    for (const key of pick) {
      const value = computed.getPropertyValue(key);
      if (value) styles[key] = value;
    }
    const rect = el.getBoundingClientRect();
    styles.width = `${Math.round(rect.width)}px`;
    styles.height = `${Math.round(rect.height)}px`;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    window.parent.postMessage({
      type: 'omp:element-selected',
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text,
      attributes: attributesOf(el),
      styles
    }, window.location.origin);
  }

  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'omp:design-mode') return;
    active = Boolean(event.data.enabled);
    if (!active) hide();
  });

  const inspectable = el => el && el !== overlay && el !== document.body && el !== document.documentElement;
  const underPointer = event => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    return inspectable(target) ? target : null;
  };

  document.addEventListener('pointermove', event => {
    if (!active) return;
    const target = underPointer(event);
    if (!target) return hide();
    highlight(target);
  }, true);

  document.addEventListener('pointerleave', hide, true);

  /* Guides `accessibility` (keyboard reachability: every pointer action needs a keyboard
     one, and focus must be visible) — inspection was pointer-only, so a keyboard user
     could not inspect anything. Focus highlights the same way hover does, and Alt+Enter
     performs the explicit inspect action. Neither hijacks ordinary activation: Tab, Enter,
     Space and arrow keys on the preview's own controls behave exactly as before.
     Pointer and keyboard targets are kept apart: the keyboard action always inspects the
     element that has focus (the keydown target), never whatever the pointer last crossed. */
  document.addEventListener('focusin', event => {
    if (!active) return;
    if (!inspectable(event.target)) return hide();
    highlight(event.target);
  }, true);

  document.addEventListener('focusout', () => { if (active) hide(); }, true);

  window.addEventListener('keydown', event => {
    // Any key press means a click that follows without a new pointerdown came from the
    // keyboard (Enter/Space on a button), so it must stay a native activation.
    pressed = null;
    if (!active || event.key !== 'Enter' || !event.altKey) return;
    const focused = event.target;
    if (!inspectable(focused)) return;
    event.preventDefault();
    event.stopPropagation();
    highlight(focused);
    capture(focused);
  }, true);

  document.addEventListener('pointerdown', event => {
    pressed = active ? underPointer(event) : null;
  }, true);
  document.addEventListener('pointercancel', () => { pressed = null; }, true);

  document.addEventListener('click', event => {
    const target = pressed;
    pressed = null;
    // No pointerdown armed this click: it is keyboard- or script-generated, so the
    // preview's own control receives it untouched.
    if (!active || !target) return;
    event.preventDefault();
    event.stopPropagation();
    capture(target);
  }, true);

  window.addEventListener('keydown', event => {
    if (!active || event.key !== 'Escape') return;
    active = false;
    hide();
    window.parent.postMessage({ type: 'omp:design-mode-off' }, window.location.origin);
  }, true);

  window.parent.postMessage({ type: 'omp:inspector-ready' }, window.location.origin);
})();
