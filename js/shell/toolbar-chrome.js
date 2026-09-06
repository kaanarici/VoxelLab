import { state } from '../core/state.js';
import { MR_PRESETS, CT_WINDOWS, ctWindowToWL } from '../core/constants.js';

function isCtSeries() {
  return state.manifest?.series?.[state.seriesIdx]?.modality === 'CT';
}

function hasActiveStack() {
  return (state.manifest?.series?.length ?? 0) > 0 && (state.imgs?.length ?? 0) > 0;
}

let _ctPresetsWired = false;
function wireCtPresetsOnce() {
  if (_ctPresetsWired) return;
  const el = document.getElementById('ct-presets');
  if (!el) return;
  _ctPresetsWired = true;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctpreset]');
    const win = btn && CT_WINDOWS[btn.dataset.ctpreset];
    if (!win) return;
    const wl = ctWindowToWL(win);

    void import('../core/state/viewer-commands.js').then((m) => m.setWindowLevel(wl.window, wl.level));
  });
}

export function syncCtPresets() {
  if (!globalThis.document) return;
  const el = document.getElementById('ct-presets');
  if (!el) return;
  const show = hasActiveStack() && isCtSeries() && (state.mode === '2d' || state.mode === 'cmp');
  el.hidden = !show;
  if (!show) return;
  el.querySelectorAll('[data-ctpreset]').forEach((btn) => {
    const wl = ctWindowToWL(CT_WINDOWS[btn.dataset.ctpreset]);
    btn.classList.toggle('active', Math.round(state.window) === wl.window && Math.round(state.level) === wl.level);
  });
}

export function syncSliceCountAriaBusy() {
  if (!globalThis.document) return;
  const ctr = document.querySelector('.ctr-count');
  const tot = document.getElementById('slice-tot');
  if (!ctr || !tot) return;
  const busy = tot.textContent === '';
  ctr.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function syncWlToolGroupVisibility() {
  if (!globalThis.document) return;
  const wl = document.querySelector('.tool-group--wl');
  if (!wl) return;

  const wlc = document.getElementById('wl-control');
  if (wlc) wlc.hidden = !(hasActiveStack() && (state.mode === '2d' || state.mode === 'cmp'));
  const mr = document.getElementById('mr-presets');
  const op = document.getElementById('overlay-opacity-wrap');
  const mrHidden = !mr || mr.hidden;
  const opHidden = !op || op.hidden;
  const wlcHidden = !wlc || wlc.hidden;
  wl.classList.toggle('hidden', mrHidden && opHidden && wlcHidden);
}

export function syncMrPresetActiveState() {
  if (!globalThis.document) return;
  document.querySelectorAll('#mr-presets [data-mrpreset]').forEach((btn) => {
    const preset = MR_PRESETS[btn.dataset.mrpreset];
    btn.classList.toggle(
      'active',
      !!preset && state.window === preset.window && state.level === preset.level,
    );
  });
  syncCtPresets();
}

export function syncDisplayControlAvailability() {
  if (!globalThis.document) return;
  const disabled = state.mode === '3d';
  for (const id of ['btn-auto', 'btn-invert', 'cmap-trigger']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = disabled;
    el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  const zoomable = state.mode === '2d' || state.mode === 'cmp';
  for (const id of ['btn-zoom-in', 'btn-zoom-out']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = !zoomable;
    el.setAttribute('aria-disabled', zoomable ? 'false' : 'true');
  }
  syncWlToolGroupVisibility();
  if (disabled) {
    const dropdown = document.getElementById('cmap-dropdown');
    const trigger = document.getElementById('cmap-trigger');
    dropdown?.classList.remove('open');
    trigger?.setAttribute('aria-expanded', 'false');
  }
}

export function syncToolbarReadyState() {
  if (!globalThis.document) return;
  const controls = document.querySelector('.controls');
  if (!controls) return;
  controls.classList.toggle('controls--ready', hasActiveStack());
  wireCtPresetsOnce();
  syncSliceCountAriaBusy();
  syncWlToolGroupVisibility();
  syncMrPresetActiveState();
  syncDisplayControlAvailability();
}
