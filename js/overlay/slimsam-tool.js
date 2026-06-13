import { state } from '../core/state.js';
import { $ } from '../dom.js';
import { notify, dismissNotify } from '../notify.js';
import { overlayMask } from './slimsam-overlay.js';

let _active = false;
let _drawSlice = () => {};
let _lastMask = null;
let _slimsam = null;
let _slimsamLoading = null;

async function loadSlimSAM() {
  if (_slimsam) return _slimsam;
  if (!_slimsamLoading) {
    _slimsamLoading = import('./slimsam.js').then((mod) => {
      _slimsam = mod;
      if (state.manifest) mod.initSlimSAM(state.manifest);
      return mod;
    }).catch((error) => {
      _slimsamLoading = null;
      throw error;
    });
  }
  return _slimsamLoading;
}

export function initSlimSAMTool({ drawSlice }) {
  _drawSlice = drawSlice;
}

export function isSlimSAMMode() { return _active; }

export function setSlimSAMMode(active) {
  _active = !!active;
  const btn = $('btn-slimsam');
  if (btn) btn.classList.toggle('active', _active);
  if (!_active) {
    _lastMask = null;
    _drawSlice(); // clear mask overlay
  }
  return _active;
}

export function toggleSlimSAM() {
  if (state.mode !== '2d' && !_active) return false;
  const active = setSlimSAMMode(!_active);
  if (active) void loadSlimSAM().catch(() => null);
  return active;
}

export async function onSlimSAMClick(ev, clientToCanvasPx) {
  if (!_active || state.mode !== '2d') return;

  const [px, py] = clientToCanvasPx(ev.clientX, ev.clientY);
  const series = state.manifest.series[state.seriesIdx];

  // Check if embeddings exist
  let slimsam;
  try {
    slimsam = await loadSlimSAM();
  } catch {
    notify('SlimSAM tool could not load.', { duration: 5000 });
    return;
  }
  const available = await slimsam.isSlimSAMAvailable(state.seriesIdx);
  if (!available) {
    notify('No SlimSAM embeddings for this series.', {
      command: `python3 slimsam_embed.py ${series.slug}`,
      duration: 8000,
    });
    return;
  }

  notify('SlimSAM segmenting...', { id: 'slimsam', progress: true });

  try {
    const result = await slimsam.runSlimSAMClick(px, py, state.sliceIdx, state.seriesIdx);
    if (!result || !result.mask) {
      dismissNotify('slimsam');
      notify('No mask returned — try a different area', { duration: 3000 });
      return;
    }

    _lastMask = result;
    _drawSlice();
    drawSlimSAMMask();
    dismissNotify('slimsam');
    notify(`SlimSAM segmented (${result.width}×${result.height})`, { duration: 2000 });
  } catch (e) {
    dismissNotify('slimsam');
    notify('SlimSAM error: ' + e.message, { duration: 5000 });
  }
}

function drawSlimSAMMask() {
  if (!_lastMask || !_active) return;
  const canvas = $('view');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  overlayMask(ctx, _lastMask, {
    color: [64, 180, 255], // cyan-blue
    opacity: 0.35,
  });
}
