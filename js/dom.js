// Tiny DOM helpers shared across every viewer module, plus app-level modal
// orchestration. Kept minimal — a `$('foo')` shortcut, an HTML-escaper, a
// reusable focus-trap, a coordinate helper, and the modal open/close logic
// that names concrete element ids (confirm-modal, *-modal, .ask-close/.hc-close).

/** @param {string} id @returns {HTMLElement|null} */
export const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** Inline SVG swatch markup for a rounded RGB color chip. */
export function colorSwatchSvg(className, rgb, size = 10) {
  const [r, g, b] = Array.isArray(rgb) && rgb.length === 3 ? rgb : [85, 85, 85];
  const radius = Math.max(2, Math.round(size / 5));
  return `<svg class="${className}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><rect width="${size}" height="${size}" rx="${radius}" fill="rgb(${r},${g},${b})"></rect></svg>`;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const _focusStack = [];

const focusableIn = (el) =>
  [...el.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.getClientRects().length > 0);

/** Trap Tab focus within `el` and remember the previously-focused node. */
export function trapFocus(el) {
  if (_focusStack[_focusStack.length - 1]?.el === el) return;
  const prev = document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusableIn(el);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !el.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  el.addEventListener('keydown', onKey);
  _focusStack.push({ el, onKey, prev });
  if (!el.contains(document.activeElement)) focusableIn(el)[0]?.focus();
}

/** The element of the topmost active focus trap, or null. */
export function topTrappedElement() {
  return _focusStack[_focusStack.length - 1]?.el ?? null;
}

/** Release the focus trap for `el` and restore prior focus. */
export function releaseFocus(el) {
  let idx = -1;
  for (let i = _focusStack.length - 1; i >= 0; i -= 1) {
    if (_focusStack[i].el === el) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return;
  const [trap] = _focusStack.splice(idx, 1);
  trap.el.removeEventListener('keydown', trap.onKey);
  if (typeof trap.prev?.focus === 'function') trap.prev.focus();
}

// Convert a client (mouse) X/Y to canvas-internal pixel coords. The CSS
// transform on the canvas wrapper is already baked into getBoundingClientRect,
// so this works correctly even when the user has panned and zoomed the 2D view.
export function clientToCanvasPx(canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return [
    (clientX - r.left) / r.width  * canvas.width,
    (clientY - r.top)  / r.height * canvas.height,
  ];
}

export function openModal(id) {
  const el = $(id);
  el.classList.add('visible');
  trapFocus(el);
}

export function closeModal(id) {
  const el = $(id);
  el.classList.remove('visible');
  releaseFocus(el);
}

function modalCloseBlocked(el) {
  if (el?.dataset?.closeBlocked !== 'true') return false;
  el.dispatchEvent(new CustomEvent('voxellab:modal-close-blocked', { bubbles: true }));
  return true;
}

export function closeTopModal() {
  const open = topTrappedElement() || document.querySelector('[id$="-modal"].visible');
  if (open) {
    if (modalCloseBlocked(open)) return true;
    open.classList.remove('visible');
    releaseFocus(open);
    return true;
  }
  return false;
}

export function initModals() {
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.ask-close, .hc-close');
    if (closeBtn) {
      const modal = closeBtn.closest('[id$="-modal"]');
      if (modal) {
        if (modalCloseBlocked(modal)) return;
        modal.classList.remove('visible');
        releaseFocus(modal);
      }
      return;
    }
    if (e.target.id?.endsWith('-modal') && e.target.classList.contains('visible')) {
      if (modalCloseBlocked(e.target)) return;
      e.target.classList.remove('visible');
      releaseFocus(e.target);
    }
  });
}

// confirm-modal: returns a dismiss function.
export function showDialog(title, bodyHTML) {
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = bodyHTML;
  openModal('confirm-modal');
  return () => closeModal('confirm-modal');
}
