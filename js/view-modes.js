// Display mode: 2D / MPR / 3D / MPR+3D / Compare + CT 3D presets.
import { state } from './core/state.js';
import { $ } from './dom.js';
import { THREE_D_PRESETS, CT_WINDOWS } from './core/constants.js';
import { isMprActive } from './core/mode-flags.js';
import { drawMPR } from './slice-view.js';
import {
  sync3DScrubber,
  updateUniforms,
  ensureThree,
  setThreeDView,
  ensureVoxels,
  ensureHRVoxels,
  buildVolume,
  syncThreeSurfaceState,
} from './volume/volume-3d.js';
import {
  getGroupPeers,
  buildCompareGrid,
  loadComparePeers,
  drawCompare,
} from './series/compare.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { canUseMpr3D, capabilityBlockReason } from './series/series-capabilities.js';
import { seriesIdentityKey } from './series/series-identity.js';
import { notify } from './notify.js';
import { syncAskModeAfterViewChange } from './ask-mode.js';
import { syncHistogramPanel } from './sparkline.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { beginPerfTrace, endPerfTrace } from './core/perf-trace.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { updateScaleBar } from './overlay/scale-bar.js';
import { deactivate2dAuthoringTools } from './roi/two-d-tools.js';
import { setSpinnerPending } from './spinner.js';
import {
  applyViewerPreset,
  setClipRange,
  syncMprSliceIndex,
  setSliceIndex,
  setViewMode as applyViewModeState,
} from './core/state/viewer-commands.js';

export function setMode(mode) {
  applyViewModeState(mode);
  if (mode !== '2d') deactivate2dAuthoringTools();
  const wrap = $('canvas-wrap');
  const is3d = mode === '3d' || mode === 'mpr3d';
  const isMpr = mode === 'mpr' || mode === 'mpr3d';
  const three = getThreeRuntime();
  wrap.classList.toggle('threeD', mode === '3d');
  wrap.classList.toggle('mpr', mode === 'mpr');
  wrap.classList.toggle('cmp', mode === 'cmp');
  wrap.classList.toggle('mpr3d', mode === 'mpr3d');
  $('three-container').classList.toggle('active', is3d);
  $('btn-3d').classList.toggle('active', is3d);
  $('btn-mpr').classList.toggle('active', isMpr);
  $('btn-compare').classList.toggle('active', mode === 'cmp');
  $('panel-3d').hidden = !is3d;
  if (!is3d) setSpinnerPending('three-surface', false);
  else syncThreeSurfaceState();
  if (is3d) {
    three.requestRender?.('mode-change', 180);
    if (three.renderer) void ensureThree();
  } else {
    three.stopLoop?.();
  }
  updateScaleBar();
  syncAskModeAfterViewChange();
  syncHistogramPanel();
}

function normalizeSeriesForPreset(seriesOrSlug) {
  if (typeof seriesOrSlug === 'string') return { slug: seriesOrSlug };
  return seriesOrSlug || {};
}

function presetForSeries(series) {
  return THREE_D_PRESETS[series.slug] || (series.modality === 'CT'
    ? { ...CT_WINDOWS.full, mode: 'alpha' }
    : null);
}

export function applyThreeDPresetForSeries(seriesOrSlug) {
  const series = normalizeSeriesForPreset(seriesOrSlug);
  const p = presetForSeries(series);
  const isCT = series.modality === 'CT' || series.slug?.startsWith('ct_');
  if (!p) {
    const ctTitle = $('ct-window-title');
    const ctRow = $('ct-window');
    if (ctTitle && ctRow) {
      ctTitle.hidden = !isCT;
      ctRow.hidden = !isCT;
    }
    return;
  }
  applyViewerPreset(p);
  const s = $('s-low');
  if (s) s.value = p.lowT;
  const h = $('s-high');
  if (h) h.value = p.highT;
  const g = $('s-gain');
  if (g) g.value = p.intensity;
  document.querySelectorAll('#render-mode .pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.mode === p.mode);
  });
  syncPanelRangeFills();

  const ctTitle = $('ct-window-title');
  const ctRow = $('ct-window');
  if (ctTitle && ctRow) {
    ctTitle.hidden = !isCT;
    ctRow.hidden = !isCT;
    if (isCT) {
      const active = detectCTWindow(p.lowT, p.highT) || 'soft';
      document.querySelectorAll('#ct-window .pill').forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.window === active);
      });
    }
  }
}

export function detectCTWindow(lowT, highT) {
  for (const [name, w] of Object.entries(CT_WINDOWS)) {
    if (Math.abs(w.lowT - lowT) < 0.02 && Math.abs(w.highT - highT) < 0.02) {
      return name;
    }
  }
  return null;
}

export function setCTWindow(name) {
  const w = CT_WINDOWS[name];
  if (!w) return;
  applyViewerPreset(w);
  const s = $('s-low');
  if (s) s.value = w.lowT;
  const h = $('s-high');
  if (h) h.value = w.highT;
  const g = $('s-gain');
  if (g) g.value = w.intensity;
  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.window === name);
  });
  syncPanelRangeFills();
}

export async function enter3D() {
  beginPerfTrace('enter-3d', {
    slug: state.manifest.series[state.seriesIdx]?.slug || '',
  });
  const three = getThreeRuntime();
  const series = state.manifest.series[state.seriesIdx];
  const requestId = state.selectRequestId;
  const seriesKey = seriesIdentityKey(series, state.manifest);
  const maxSlice = series.slices - 1;
  setSliceIndex(maxSlice, series);
  setClipRange([0, 0, 0], [1, 1, 1]);

  applyThreeDPresetForSeries(series);
  await ensureThree();
  const currentSeries = state.manifest.series[state.seriesIdx];
  if (
    state.selectRequestId !== requestId
    || seriesIdentityKey(currentSeries, state.manifest) !== seriesKey
    || (state.mode !== '3d' && state.mode !== 'mpr3d')
  ) {
    endPerfTrace('enter-3d', { cancelled: true });
    return;
  }
  await setThreeDView('coronal');

  syncThreeSurfaceState(series);

  const hasVoxels = ensureVoxels();
  syncViewerRuntimeSession(series);
  if (hasVoxels) {
    buildVolume().then(() => {
      syncThreeSurfaceState(series);
    });
  }
  sync3DScrubber();
  updateUniforms();
  updateClipReadouts();

  requestAnimationFrame(() => {
    if (three.renderer) void ensureThree();
    syncThreeSurfaceState(series);
  });
}

export function enterMPR() {
  beginPerfTrace('enter-mpr', {
    slug: state.manifest.series[state.seriesIdx]?.slug || '',
  });
  const series = state.manifest.series[state.seriesIdx];
  const requestId = state.selectRequestId;
  const seriesKey = seriesIdentityKey(series, state.manifest);
  syncMprSliceIndex();
  const hasBaseVolume = ensureVoxels();
  syncViewerRuntimeSession(series);
  if (hasBaseVolume) drawMPR();
  ensureHRVoxels().then(() => {
    const currentSeries = state.manifest.series[state.seriesIdx];
    if (state.selectRequestId !== requestId || seriesIdentityKey(currentSeries, state.manifest) !== seriesKey) return;
    syncViewerRuntimeSession(series);
    if (isMprActive()) drawMPR();
  });
}

export function toggle3D() {
  const cur = state.manifest.series[state.seriesIdx];
  if (!canUseMpr3D(cur)) {
    notify(capabilityBlockReason(cur));
    return;
  }

  if (state.mode === 'mpr3d') {
    setMode('mpr');
  } else if (state.mode === 'mpr') {
    setMode('mpr3d');
    void enter3D();
  } else if (state.mode === '3d') {
    setMode('2d');
  } else {
    setMode('3d');
    void enter3D();
  }
}

export function toggleMPR() {
  const cur = state.manifest.series[state.seriesIdx];
  if (!canUseMpr3D(cur)) {
    notify(capabilityBlockReason(cur));
    return;
  }

  if (state.mode === 'mpr3d') {
    setMode('3d');
  } else if (state.mode === '3d') {
    setMode('mpr3d');
    enterMPR();
  } else if (state.mode === 'mpr') {
    setMode('2d');
  } else if (isMprActive()) {
    setMode('2d');
  } else {
    setMode('mpr');
    enterMPR();
  }
}

export async function toggleCompare() {
  if (state.mode === 'cmp') { setMode('2d'); return; }
  const peers = getGroupPeers();
  if (peers.length < 2) return;
  setMode('cmp');
  buildCompareGrid();
  await loadComparePeers();
  drawCompare();
}
