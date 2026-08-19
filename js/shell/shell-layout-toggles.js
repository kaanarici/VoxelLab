import { SHELL_TIP } from './shell-constants.js';

const SHELL_LAYOUT_KEY = 'mri-viewer/shellLayout/v1';
const DESKTOP_MQ = '(min-width: 1101px)';
const RAIL_LEFT_MIN_FALLBACK = 208;
const RAIL_RIGHT_FALLBACK = 312;

function isShellLayoutRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

export function parseShellLayout(raw) {
  if (raw == null || raw === '') return null;
  try {
    const o = String(raw) === raw ? JSON.parse(raw) : raw;
    if (!isShellLayoutRecord(o)
      || (o.leftCollapsed !== true && o.leftCollapsed !== false)
      || (o.rightCollapsed !== true && o.rightCollapsed !== false)) {
      return null;
    }
    const layout = {
      leftCollapsed: o.leftCollapsed,
      rightCollapsed: o.rightCollapsed,
    };
    if (Number.isFinite(o.leftWidth)) {
      layout.leftWidth = o.leftWidth;
    }
    if (Number.isFinite(o.scrubberWidth)) {
      layout.scrubberWidth = o.scrubberWidth;
    }
    return layout;
  } catch {
    return null;
  }
}

export function clampLeftRailWidthPx(widthPx, minPx, maxPx) {
  const min = Number.isFinite(minPx) ? minPx : RAIL_LEFT_MIN_FALLBACK;
  const max = Number.isFinite(maxPx) ? Math.max(min, maxPx) : min;
  if (!Number.isFinite(widthPx)) return Math.round(min);
  return Math.round(Math.min(max, Math.max(min, widthPx)));
}

export function loadShellLayout() {
  try {
    return parseShellLayout(localStorage.getItem(SHELL_LAYOUT_KEY));
  } catch {
    return null;
  }
}

export function patchShellLayout(patch) {
  const current = loadShellLayout() || {
    leftCollapsed: false,
    rightCollapsed: false,
  };
  const next = { ...current };
  if (patch.leftCollapsed === true || patch.leftCollapsed === false) {
    next.leftCollapsed = patch.leftCollapsed;
  }
  if (patch.rightCollapsed === true || patch.rightCollapsed === false) {
    next.rightCollapsed = patch.rightCollapsed;
  }
  if ('leftWidth' in patch) {
    if (Number.isFinite(patch.leftWidth)) next.leftWidth = patch.leftWidth;
    else delete next.leftWidth;
  }
  if ('scrubberWidth' in patch) {
    if (Number.isFinite(patch.scrubberWidth)) next.scrubberWidth = patch.scrubberWidth;
    else delete next.scrubberWidth;
  }
  try {
    const payload = {
      leftCollapsed: next.leftCollapsed,
      rightCollapsed: next.rightCollapsed,
    };
    if (Number.isFinite(next.leftWidth)) payload.leftWidth = next.leftWidth;
    if (Number.isFinite(next.scrubberWidth)) payload.scrubberWidth = next.scrubberWidth;
    localStorage.setItem(SHELL_LAYOUT_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
  return next;
}

function readCssPx(name, fallback) {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

function leftRailBounds() {
  return {
    min: readCssPx('--rail-left-min', RAIL_LEFT_MIN_FALLBACK),
    max: readCssPx('--rail-right-w', RAIL_RIGHT_FALLBACK),
  };
}

function applyLeftRailWidth(widthPx) {
  const { min, max } = leftRailBounds();
  const width = clampLeftRailWidthPx(widthPx, min, max);
  document.documentElement.style.setProperty('--rail-left-w', `${width}px`);
  const handle = document.getElementById('sidebar-resize-handle');
  if (handle) {
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(width));
  }
  return width;
}

export function initDesktopSidebarToggles() {
  const app = document.querySelector('.app');
  const btnToggleLeft = document.getElementById('btn-toggle-left');
  const btnToggleRight = document.getElementById('btn-toggle-right');
  const btnShowLeft = document.getElementById('btn-show-left');
  const btnShowRight = document.getElementById('btn-show-right');
  const btnTheme = document.getElementById('btn-theme');
  const rightPanelActions = document.querySelector('.sidebar-header-right .sidebar-actions');
  const viewerHeaderRightActions = document.getElementById('viewer-header-right-actions');
  if (!app) return;

  const saved = loadShellLayout();
  if (saved) {
    app.classList.toggle('left-collapsed', saved.leftCollapsed);
    app.classList.toggle('right-collapsed', saved.rightCollapsed);
    if (Number.isFinite(saved.leftWidth)) applyLeftRailWidth(saved.leftWidth);
  }
  const root = document.documentElement;
  root.removeAttribute('data-shell-left-collapsed');
  root.removeAttribute('data-shell-right-collapsed');

  // ≤1100px the right panel is an off-screen slide-in overlay (see responsive.css +
  // shell-mobile.js), so its in-panel header is hidden. The theme button must then
  // live in the always-visible viewer header instead of being trapped in the overlay.
  const isMobileShell = () => window.matchMedia('(max-width: 1100px)').matches;
  const isDesktopShell = () => window.matchMedia(DESKTOP_MQ).matches;

  const persistLayout = () => {
    patchShellLayout({
      leftCollapsed: app.classList.contains('left-collapsed'),
      rightCollapsed: app.classList.contains('right-collapsed'),
      leftWidth: applyLeftRailWidth(readCssPx('--rail-left-w', RAIL_LEFT_MIN_FALLBACK)),
    });
  };

  // Sidebar toggles are app-local layout changes. A synthetic window resize
  // also wakes unrelated render listeners and can blank the 3D canvas mid-toggle.
  let relayoutPending = false;
  const scheduleViewerRefit = () => {
    if (relayoutPending) return;
    relayoutPending = true;
    requestAnimationFrame(() => {
      relayoutPending = false;
      window.dispatchEvent(new CustomEvent('voxellab:relayout'));
    });
  };

  // Button hosts: { rightPanelActions, viewerHeaderRightActions }.
  // Theme lives in the viewer header whenever the panel header isn't visible —
  // i.e. on the mobile/tablet overlay, or on desktop when the panel is collapsed.
  // Otherwise it sits in the panel's own header. Moves are idempotent so a resize
  // re-sync doesn't thrash the DOM.
  const syncThemeButtonHost = () => {
    if (!btnTheme) return;
    const inHeader = isMobileShell() || app.classList.contains('right-collapsed');
    if (inHeader) {
      if (viewerHeaderRightActions && btnTheme.parentElement !== viewerHeaderRightActions) {
        viewerHeaderRightActions.insertBefore(btnTheme, btnShowRight || null);
      }
      // Default placement (centered below, viewport-clamped) keeps the tip readable without forcing it into a corner.
      delete btnTheme.dataset.tipPos;
      return;
    }
    if (rightPanelActions && btnTheme.parentElement !== rightPanelActions) {
      rightPanelActions.insertBefore(btnTheme, btnToggleRight || null);
    }
    // Inside the right panel, keep the legacy left placement so the tooltip floats over the canvas.
    btnTheme.dataset.tipPos = 'left';
  };

  const syncShowButtons = () => {
    const leftCollapsed = app.classList.contains('left-collapsed');
    const rightCollapsed = app.classList.contains('right-collapsed');
    if (btnShowLeft) {
      btnShowLeft.hidden = !leftCollapsed;
      btnShowLeft.dataset.tip = SHELL_TIP.SHOW_SIDEBAR;
      btnShowLeft.setAttribute('aria-label', SHELL_TIP.SHOW_SIDEBAR);
    }
    if (btnShowRight) {
      btnShowRight.hidden = !rightCollapsed;
      btnShowRight.dataset.tip = SHELL_TIP.SHOW_PANEL;
      btnShowRight.setAttribute('aria-label', SHELL_TIP.SHOW_PANEL);
    }
    if (btnToggleLeft) {
      const tip = leftCollapsed ? SHELL_TIP.SHOW_SIDEBAR : SHELL_TIP.HIDE_SIDEBAR;
      btnToggleLeft.dataset.tip = tip;
      btnToggleLeft.setAttribute('aria-label', tip);
    }
    if (btnToggleRight) {
      const tip = rightCollapsed ? SHELL_TIP.SHOW_PANEL : SHELL_TIP.HIDE_PANEL;
      btnToggleRight.dataset.tip = tip;
      btnToggleRight.setAttribute('aria-label', tip);
    }
    syncThemeButtonHost();
  };

  btnToggleLeft?.addEventListener('click', () => {
    if (isMobileShell()) return;
    app.classList.toggle('left-collapsed');
    syncShowButtons();
    persistLayout();
    scheduleViewerRefit();
  });
  // On the overlay, the panel is toggled by shell-mobile.js via .mobile-open — the
  // desktop right-collapsed grid state must stay untouched so the theme host and
  // show/hide chrome don't desync (the bug where the header theme button vanished).
  btnToggleRight?.addEventListener('click', () => {
    if (isMobileShell()) return;
    app.classList.toggle('right-collapsed');
    syncShowButtons();
    persistLayout();
    scheduleViewerRefit();
  });
  btnShowLeft?.addEventListener('click', () => {
    if (isMobileShell()) return;
    app.classList.remove('left-collapsed');
    syncShowButtons();
    persistLayout();
    scheduleViewerRefit();
  });
  btnShowRight?.addEventListener('click', () => {
    if (isMobileShell()) return;
    app.classList.remove('right-collapsed');
    syncShowButtons();
    persistLayout();
    scheduleViewerRefit();
  });
  // Crossing the overlay breakpoint changes where the theme button belongs.
  window.addEventListener('resize', syncShowButtons);
  syncShowButtons();

  const handle = document.getElementById('sidebar-resize-handle');
  const left = document.querySelector('aside.left');
  if (!handle || !left) return;

  applyLeftRailWidth(readCssPx('--rail-left-w', RAIL_LEFT_MIN_FALLBACK));

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (!isDesktopShell() || app.classList.contains('left-collapsed')) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startW = left.getBoundingClientRect().width;
    document.documentElement.classList.add('is-left-resizing');

    const onMove = (moveEvent) => {
      applyLeftRailWidth(startW + (moveEvent.clientX - startX));
      scheduleViewerRefit();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.documentElement.classList.remove('is-left-resizing');
      persistLayout();
      scheduleViewerRefit();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  handle.addEventListener('keydown', (event) => {
    if (!isDesktopShell() || app.classList.contains('left-collapsed')) return;
    const { min, max } = leftRailBounds();
    const current = readCssPx('--rail-left-w', min);
    const step = event.shiftKey ? 32 : 8;
    const next = {
      ArrowLeft: current - step,
      ArrowRight: current + step,
      Home: min,
      End: max,
    }[event.key];
    if (next == null) return;
    event.preventDefault();
    applyLeftRailWidth(next);
    persistLayout();
    scheduleViewerRefit();
  });
}
