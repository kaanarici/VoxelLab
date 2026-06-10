// Toggles .controls--ready on the bottom toolbar when a series is interactive
// (hides MR window presets + overlay opacity until loading finishes).
import { state } from '../core/state.js';
import { MR_PRESETS } from '../core/constants.js';

/** Mirrors CSS skeleton gate (#slice-tot:empty) for assistive tech. */
export function syncSliceCountAriaBusy() {
  if (typeof document === 'undefined') return;
  const ctr = document.querySelector('.ctr-count');
  const tot = document.getElementById('slice-tot');
  if (!ctr || !tot) return;
  const busy = tot.textContent === '';
  ctr.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** MR W/L row + overlay opacity share .tool-group--wl (no .icon-btn); hide when both rows are hidden. */
export function syncWlToolGroupVisibility() {
  if (typeof document === 'undefined') return;
  const wl = document.querySelector('.tool-group--wl');
  if (!wl) return;
  const mr = document.getElementById('mr-presets');
  const op = document.getElementById('overlay-opacity-wrap');
  const mrHidden = !mr || mr.hidden;
  const opHidden = !op || op.hidden;
  wl.classList.toggle('hidden', mrHidden && opHidden);
}

export function syncMrPresetActiveState() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('#mr-presets [data-mrpreset]').forEach((btn) => {
    const preset = MR_PRESETS[btn.dataset.mrpreset];
    btn.classList.toggle(
      'active',
      !!preset && state.window === preset.window && state.level === preset.level,
    );
  });
}

export function syncDisplayControlAvailability() {
  if (typeof document === 'undefined') return;
  const disabled = state.mode === '3d';
  for (const id of ['btn-auto', 'btn-invert', 'cmap-trigger']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = disabled;
    el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
  if (disabled) {
    const dropdown = document.getElementById('cmap-dropdown');
    const trigger = document.getElementById('cmap-trigger');
    dropdown?.classList.remove('open');
    trigger?.setAttribute('aria-expanded', 'false');
  }
}

export function syncToolbarReadyState() {
  if (typeof document === 'undefined') return;
  const controls = document.querySelector('.controls');
  if (!controls) return;
  const ready = !!state.loaded && (state.manifest?.series?.length ?? 0) > 0;
  controls.classList.toggle('controls--ready', ready);
  syncSliceCountAriaBusy();
  syncWlToolGroupVisibility();
  syncMrPresetActiveState();
  syncDisplayControlAvailability();
}
