import { loadShellLayout, patchShellLayout } from './shell-layout-toggles.js';

const MIN_RATIO = 0.5;
const MIN_TOOL_RAIL_PX = 48;
const DRAG_THRESHOLD_PX = 2;
const KEY_STEP_PX = 8;
const KEY_SHIFT_STEP_PX = 32;
const NARROW_MQ = '(max-width: 640px)';

export function clampScrubberWidthPx(widthPx, minPx, maxPx) {
  const min = Number.isFinite(minPx) ? minPx : 0;
  const max = Number.isFinite(maxPx) ? Math.max(min, maxPx) : min;
  if (!Number.isFinite(widthPx)) return Math.round(min);
  return Math.round(Math.min(max, Math.max(min, widthPx)));
}

export function scrubberWidthBounds(defaultWidthPx, maxWidthPx) {
  const defaultWidth = Number.isFinite(defaultWidthPx) && defaultWidthPx > 0 ? defaultWidthPx : 0;
  const rawMax = Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? maxWidthPx : defaultWidth;
  const min = Math.min(defaultWidth * MIN_RATIO, rawMax);
  return {
    min,
    max: Math.max(min, rawMax),
    defaultWidth,
  };
}

function isNarrowToolbar() {
  return window.matchMedia(NARROW_MQ).matches;
}

export function initToolbarScrubberResize() {
  const controls = document.querySelector('.controls');
  const scrubber = controls?.querySelector('.scrubber');
  const handle = document.getElementById('scrubber-resize-handle');
  if (!controls || !scrubber || !handle) return;

  let defaultWidth = 0;
  let committedWidth = null;
  let drag = null;
  let lastClickAt = 0;

  const measureScrubberWidth = () => scrubber.getBoundingClientRect().width;

  const captureDefaultWidth = () => {
    if (controls.classList.contains('controls--scrubber-sized')) return defaultWidth;
    const width = measureScrubberWidth();
    if (width > 0) defaultWidth = width;
    return defaultWidth;
  };

  const measureMaxWidth = () => {
    const wrap = document.getElementById('tool-rail-wrap');
    const wrapWidth = wrap ? wrap.getBoundingClientRect().width : 0;
    return measureScrubberWidth() + Math.max(0, wrapWidth - MIN_TOOL_RAIL_PX);
  };

  const currentBounds = () => scrubberWidthBounds(captureDefaultWidth(), measureMaxWidth());

  const syncAria = (widthPx, bounds) => {
    handle.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(widthPx)));
  };

  const render = () => {
    captureDefaultWidth();
    if (defaultWidth <= 0) return;
    const bounds = currentBounds();
    if (committedWidth == null || isNarrowToolbar()) {
      controls.classList.remove('controls--scrubber-sized');
      controls.style.removeProperty('--scrubber-w');
      syncAria(bounds.defaultWidth || measureScrubberWidth(), bounds);
      return;
    }
    const width = clampScrubberWidthPx(committedWidth, bounds.min, bounds.max);
    controls.style.setProperty('--scrubber-w', `${width}px`);
    controls.classList.add('controls--scrubber-sized');
    syncAria(width, bounds);
  };

  const commit = (widthPx) => {
    if (!Number.isFinite(widthPx)) {
      committedWidth = null;
      render();
      patchShellLayout({ scrubberWidth: null });
      return;
    }
    const bounds = currentBounds();
    committedWidth = clampScrubberWidthPx(widthPx, bounds.min, bounds.max);
    render();
    patchShellLayout({ scrubberWidth: committedWidth });
  };

  const reset = () => {
    defaultWidth = 0;
    committedWidth = null;
    controls.classList.remove('controls--scrubber-sized');
    controls.style.removeProperty('--scrubber-w');
    patchShellLayout({ scrubberWidth: null });
    requestAnimationFrame(() => {
      captureDefaultWidth();
      render();
    });
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (handle.classList.contains('hidden') || isNarrowToolbar()) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    captureDefaultWidth();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: measureScrubberWidth(),
      moved: false,
    };
    document.documentElement.classList.add('is-scrubber-resizing');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    lastClickAt = 0;
    const bounds = currentBounds();
    committedWidth = clampScrubberWidthPx(drag.startWidth + delta, bounds.min, bounds.max);
    render();
  });

  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const moved = drag.moved;
    drag = null;
    document.documentElement.classList.remove('is-scrubber-resizing');
    if (moved) {
      commit(committedWidth);
      return;
    }
    if (event?.type === 'pointercancel') return;
    const now = performance.now();
    if (now - lastClickAt < 400) {
      lastClickAt = 0;
      reset();
      return;
    }
    lastClickAt = now;
  };

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('dblclick', (event) => {
    if (handle.classList.contains('hidden') || isNarrowToolbar()) return;
    event.preventDefault();
    reset();
  });

  handle.addEventListener('keydown', (event) => {
    if (handle.classList.contains('hidden') || isNarrowToolbar()) return;
    captureDefaultWidth();
    const bounds = currentBounds();
    const current = committedWidth == null
      ? (bounds.defaultWidth || measureScrubberWidth())
      : clampScrubberWidthPx(committedWidth, bounds.min, bounds.max);
    const step = event.shiftKey ? KEY_SHIFT_STEP_PX : KEY_STEP_PX;
    const next = {
      ArrowLeft: current - step,
      ArrowRight: current + step,
      Home: bounds.min,
      End: bounds.max,
    }[event.key];
    if (next == null) return;
    event.preventDefault();
    commit(next);
  });

  const saved = loadShellLayout();
  if (Number.isFinite(saved?.scrubberWidth)) committedWidth = saved.scrubberWidth;

  const Observer = globalThis.ResizeObserver;
  if (Observer) {
    new Observer(() => {
      captureDefaultWidth();
      render();
    }).observe(controls);
  }
  window.addEventListener('resize', () => {
    captureDefaultWidth();
    render();
  });
  requestAnimationFrame(() => {
    captureDefaultWidth();
    render();
  });
}
