import { SHELL_TIP } from './shell-constants.js';

const SHELL_LAYOUT_KEY = 'mri-viewer/shellLayout/v1';

function loadShellLayout() {
  try {
    const raw = localStorage.getItem(SHELL_LAYOUT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o.leftCollapsed !== 'boolean' || typeof o.rightCollapsed !== 'boolean') return null;
    return o;
  } catch {
    return null;
  }
}

function saveShellLayout(leftCollapsed, rightCollapsed) {
  try {
    localStorage.setItem(
      SHELL_LAYOUT_KEY,
      JSON.stringify({ leftCollapsed, rightCollapsed }),
    );
  } catch {
    /* quota / private mode */
  }
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
  }
  const root = document.documentElement;
  root.removeAttribute('data-shell-left-collapsed');
  root.removeAttribute('data-shell-right-collapsed');

  // ≤1100px the right panel is an off-screen slide-in overlay (see responsive.css +
  // shell-mobile.js), so its in-panel header is hidden. The theme button must then
  // live in the always-visible viewer header instead of being trapped in the overlay.
  const isMobileShell = () => window.matchMedia('(max-width: 1100px)').matches;

  const persistLayout = () => {
    saveShellLayout(
      app.classList.contains('left-collapsed'),
      app.classList.contains('right-collapsed'),
    );
  };

  // Sidebar toggles are app-local layout changes. A synthetic window resize
  // also wakes unrelated render listeners and can blank the 3D canvas mid-toggle.
  const scheduleViewerRefit = () => {
    requestAnimationFrame(() => {
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
}
