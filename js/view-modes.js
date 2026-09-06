import { state } from './core/state.js';
import { $ } from './dom.js';
import { THREE_D_PRESETS, CT_WINDOWS } from './core/constants.js';
import { isMprActive, is3dActive } from './core/mode-flags.js';
import { drawMPR } from './slice-view.js';
import {
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
import { zoomToFit } from './shell/viewport.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { OVERLAY_CACHE_BY_KIND } from './runtime/overlay-cache-keys.js';
import { canUseMpr3D } from './core/series-capabilities.js';
import { showAnatomyLabels, setShowAnatomyLabels } from './atlas/atlas-prefs.js';
import { setAtlas2DActive } from './atlas/atlas-2d.js';
import { ensureOverlayStack } from './overlay/overlay-stack.js';
import { subscribe } from './core/state.js';
import { seriesIdentityKey } from './core/series-identity.js';
import { syncAskModeAfterViewChange } from './ask-mode.js';
import { syncHistogramPanel } from './sparkline.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { beginPerfTrace, endPerfTrace } from './core/perf-trace.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { updateScaleBar } from './overlay/scale-bar.js';
import { updateThreeDViewLabels } from './shell/viewport.js';
import { deactivate2dAuthoringTools } from './roi/two-d-tools.js';
import { setSpinnerPending } from './spinner.js';
import { notify } from './notify.js';
import {
  applyViewerPreset,
  setClipRange,
  syncMprSliceIndex,
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

  if (is3d || isMpr) {
    for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
      if (state.overlays[cache.kind]) ensureOverlayStack(cache.type);
    }
  }
  $('panel-3d').hidden = !is3d;
  if (is3d) {

    requestAnimationFrame(() => $('panel-3d')?.scrollIntoView({ block: 'start' }));
    updateThreeDViewLabels(state.manifest?.series?.[state.seriesIdx]);
  }
  if (!is3d) setSpinnerPending('three-surface', false);
  else syncThreeSurfaceState();
  if (is3d) {
    three.requestRender?.('mode-change', 180);
    if (three.renderer) void ensureThree();
  } else {
    three.stopLoop?.();
  }
  syncAtlasLabels();
  updateScaleBar();
  syncAskModeAfterViewChange();
  syncHistogramPanel();
}

let _atlas3dMod = null;

function set3DLabels(on) {
  if (on) {
    if (!_atlas3dMod) _atlas3dMod = import('./atlas/atlas-3d.js');
    _atlas3dMod.then((m) => m.setAtlas3DActive(true)).catch(() => {});
  } else if (_atlas3dMod) {
    _atlas3dMod.then((m) => m.setAtlas3DActive(false)).catch(() => {});
  }
}

function syncAnatomyLabelsToggle() {
  const btn = $('btn-anatomy-labels');
  if (!btn) return;

  const series = state.manifest?.series?.[state.seriesIdx];
  btn.hidden = !series?.hasRegions;
  btn.classList.toggle('active', showAnatomyLabels());
}

function syncAtlasLabels() {
  const series = state.manifest?.series?.[state.seriesIdx];
  const on = showAnatomyLabels() && !!series?.hasRegions;
  if (on) ensureOverlayStack(OVERLAY_CACHE_BY_KIND.labels.type);
  setAtlas2DActive(state.mode === '2d' && on);
  set3DLabels(is3dActive() && on);
  syncAnatomyLabelsToggle();
}

export function toggleAnatomyLabels() {
  setShowAnatomyLabels(!showAnatomyLabels());
  syncAtlasLabels();
}

export function initAnatomyLabels() {
  subscribe('overlays.labels', syncAtlasLabels);

  subscribe('seriesIdx', () => {
    if (is3dActive()) updateThreeDViewLabels(state.manifest?.series?.[state.seriesIdx]);
  });
  syncAnatomyLabelsToggle();
}

function normalizeSeriesForPreset(seriesOrSlug) {
  if (seriesOrSlug?.constructor === String) return { slug: seriesOrSlug };
  return seriesOrSlug || {};
}

function presetForSeries(series) {
  return THREE_D_PRESETS[series.slug] || (series.modality === 'CT'
    ? { ...CT_WINDOWS.full, mode: 'alpha' }
    : null);
}

function isCTSeries(series) {
  return String(series?.modality || '').toUpperCase() === 'CT';
}

function formatHu(hu) {
  return `${hu > 0 ? '+' : ''}${Math.round(hu)}`;
}

function ctTransferTip(preset) {
  if (preset.width === CT_WINDOWS.full.width && preset.level === CT_WINDOWS.full.level) {
    return `Full calibrated CT texture span (HU ${formatHu(preset.lowHu)} to ${formatHu(preset.highHu)}); not a diagnostic window`;
  }
  return `3D HU transfer range from CT WW/WL ${Math.round(preset.width)}/${formatHu(preset.level)} (HU ${formatHu(preset.lowHu)} to ${formatHu(preset.highHu)})`;
}

export function hydrateCTWindowPills() {
  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    const preset = CT_WINDOWS[pill.dataset.window];
    if (!preset) return;
    pill.textContent = preset.label;
    pill.dataset.tip = ctTransferTip(preset);
    pill.setAttribute('aria-label', `${preset.label} CT HU transfer range`);
  });
}

export function syncCTWindowActive() {
  const active = detectCTWindow(state.three.lowT, state.three.highT);
  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    pill.classList.toggle('active', !!active && pill.dataset.window === active);
  });
}

export function applyThreeDPresetForSeries(seriesOrSlug) {
  const series = normalizeSeriesForPreset(seriesOrSlug);
  const p = presetForSeries(series);
  const isCT = isCTSeries(series);
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
    if (isCT) syncCTWindowActive();
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
  syncCTWindowActive();
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
  setClipRange([0, 0, 0], [1, 1, 1]);

  applyThreeDPresetForSeries(series);
  try {
    await ensureThree();
  } catch {
    const currentSeries = state.manifest.series[state.seriesIdx];
    const requestStillCurrent = state.selectRequestId === requestId
      && seriesIdentityKey(currentSeries, state.manifest) === seriesKey;
    if (requestStillCurrent && (state.mode === '3d' || state.mode === 'mpr3d')) {
      setMode(state.mode === 'mpr3d' ? 'mpr' : '2d');
      notify('3D rendering is unavailable on this system. Returned to a supported view.', {
        id: 'three-renderer-unavailable',
        kind: 'warning',
      });
    }
    endPerfTrace('enter-3d', { failed: true });
    return;
  }
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

export function refitViewerLayout() {
  switch (state.mode) {
    case 'mpr':
    case 'mpr3d':
      drawMPR();
      break;
    case 'cmp':
      drawCompare();
      break;
    case '3d':
      break;
    default:
      zoomToFit();
  }
}
window.addEventListener('voxellab:relayout', refitViewerLayout);

export function toggle3D() {
  const cur = state.manifest.series[state.seriesIdx];
  if (!canUseMpr3D(cur)) return;

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
  if (!canUseMpr3D(cur)) return;

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
