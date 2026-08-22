// Right sidebar sections: toggle `.collapsed` on title click; persist in localStorage.
const COLLAPSE_KEY = 'mri-viewer/collapsed/v1';

// Set<panelName> — panels that were open on last visit and should animate open once content is ready.
const _pendingExpand = new Set();
const ASYNC_READY_PANELS = new Set([
  'metadata',
  'microscopy-stack',
  'microscopy-analysis',
  'structures',
  'quantification',
  'region-volumes',
]);

function syncSectionState(section, title) {
  const collapsed = section.classList.contains('collapsed');
  title.setAttribute('aria-expanded', String(!collapsed));
  const body = section.querySelector('.rp-body');
  if (body) body.inert = collapsed;
  const useEl = title.querySelector('.rp-collapse-ico use');
  if (useEl) useEl.setAttribute('href', collapsed ? 'icons.svg#i-plus' : 'icons.svg#i-minus');
}

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCollapsed(obj) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Call when a panel's content is fully rendered. If the user had that panel
 * open on their last visit, it will animate open from the collapsed start state.
 * Double-rAF lets the browser paint one collapsed frame so the CSS transition fires.
 */
export function signalPanelReady(name) {
  if (!_pendingExpand.has(name)) return;
  _pendingExpand.delete(name);
  const section = document.querySelector(`.rp-section[data-panel="${name}"]`);
  if (!section || !section.classList.contains('collapsed')) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      section.classList.remove('collapsed');
      const title = section.querySelector('.sec-title');
      if (!title) return;
      syncSectionState(section, title);
    });
  });
}

export function wireCollapsiblePanels() {
  const saved = loadCollapsed();
  document.querySelectorAll('.rp-section.collapsible').forEach((section) => {
    if (section.dataset.collapseWired === '1') return;
    section.dataset.collapseWired = '1';

    const name = section.dataset.panel;
    const alwaysCollapsed = section.dataset.alwaysCollapsed === 'true';
    const defaultOpen = section.dataset.defaultOpen === 'true';
    const userState = saved[name];
    // Always start collapsed to prevent flash of empty content on reload.
    // data-always-collapsed="true" ignores saved state entirely.
    // Otherwise queue an animated re-expand (fired by signalPanelReady) when the
    // user left the panel open, or — for data-default-open panels with no saved
    // choice yet — on first visit. A saved collapsed choice always wins.
    section.classList.add('collapsed');
    const wantOpen = userState === false || (defaultOpen && userState === undefined);
    if (!alwaysCollapsed && wantOpen && name) {
      _pendingExpand.add(name);
    }

    const title = section.querySelector('.sec-title');
    if (!title) return;
    // Template should include the icon (instant paint). Fallback for dynamic panels.
    if (!title.querySelector('.rp-collapse-ico')) {
      const wrap = document.createElement('span');
      wrap.className = 'rp-collapse-ico';
      wrap.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'rp-collapse-svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', 'icons.svg#i-plus');
      svg.appendChild(use);
      wrap.appendChild(svg);
      title.appendChild(wrap);
    }
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    syncSectionState(section, title);
    const toggle = (event) => {
      if (event?.target?.closest?.('.info-tip')) return;
      section.classList.toggle('collapsed');
      syncSectionState(section, title);
      const cur = loadCollapsed();
      cur[name] = section.classList.contains('collapsed');
      saveCollapsed(cur);
    };
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (e) => {
      if (e.target.closest?.('.info-tip')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });
    if (_pendingExpand.has(name) && !ASYNC_READY_PANELS.has(name)) {
      signalPanelReady(name);
    }
  });
}
