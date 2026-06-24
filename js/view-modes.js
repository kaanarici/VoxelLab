// Display mode: 2D / MPR / 3D / MPR+3D / Compare + CT 3D presets.
import { state } from './core/state.js';
import { $ } from './dom.js';
import { THREE_D_PRESETS, CT_WINDOWS } from './core/constants.js';
import { isMprActive, is3dActive } from './core/mode-flags.js';
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
import { zoomToFit } from './shell/viewport.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { canUseMpr3D, capabilityBlockReason } from './series/series-capabilities.js';
import { showAnatomyLabels, setShowAnatomyLabels } from './atlas/atlas-prefs.js';
import { setAtlas2DActive } from './atlas/atlas-2d.js';
import { ensureOverlayStack } from './overlay/overlay-stack.js';
import { subscribe } from './core/state.js';
import { seriesIdentityKey } from './series/series-identity.js';
import { notify } from './notify.js';
import { syncAskModeAfterViewChange } from './ask-mode.js';
import { syncHistogramPanel } from './sparkline.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { beginPerfTrace, endPerfTrace } from './core/perf-trace.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { updateScaleBar } from './overlay/scale-bar.js';
import { updateThreeDViewLabels } from './shell/viewport.js';
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
  // Entering a volume mode needs the FULL overlay stack (the dense 3D/MPR volume
  // can't build from a partial 2D prefetch). Re-ensure active overlays so they
  // load all slices promptly instead of trickling in.
  if (is3d || isMpr) {
    if (state.useSeg) ensureOverlayStack('seg');
    if (state.useRegions) ensureOverlayStack('regions');
    if (state.useSym) ensureOverlayStack('sym');
  }
  $('panel-3d').hidden = !is3d;
  if (is3d) {
    // Volume controls sit at the bottom of the right panel; surface them when 3D
    // activates so the mode switch visibly brings up its own controls.
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

// ── Anatomy labels (3D). The 3D Anatomy overlay can also draw floating region
// labels. This is a 3D feature gated by a remembered "Show labels" toggle
// (default on) — it NEVER writes overlay/anatomy state, so it can't fight the
// Anatomy toggle. Labels appear iff (3D mode) && (Anatomy on) && (toggle on).
// The overlay module is lazy-loaded so Three isn't pulled in at startup / for 2D.
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
  // Labels are independent of the colour overlay — available whenever the series
  // has region data, not only when Anatomy is enabled.
  const series = state.manifest?.series?.[state.seriesIdx];
  btn.hidden = !series?.hasRegions;
  btn.classList.toggle('active', showAnatomyLabels());
}

// Region labels are an overlay (never a mode) AND independent of the colour
// overlay: they float over the 2D slice / 3D volume whenever the Labels toggle is
// on and the series has region data — with or without the Anatomy colour on. They
// load their own region data and never touch the Anatomy (useRegions) state.
function syncAtlasLabels() {
  const series = state.manifest?.series?.[state.seriesIdx];
  const on = showAnatomyLabels() && !!series?.hasRegions;
  if (on) ensureOverlayStack('regions'); // labels need region masks/meta even if the colour overlay is off
  setAtlas2DActive(state.mode === '2d' && on);
  set3DLabels(is3dActive() && on);
  syncAnatomyLabelsToggle();
}

/** Toggle the "Labels" anatomy sub-option (remembered) — affects 2D and 3D. */
export function toggleAnatomyLabels() {
  setShowAnatomyLabels(!showAnatomyLabels());
  syncAtlasLabels();
}

/** Wire the anatomy-labels coupling: labels follow (Anatomy on && toggle on). */
export function initAnatomyLabels() {
  subscribe('useRegions', syncAtlasLabels);
  // Relabel the 3D view presets to the new series' true anatomy on every series
  // switch (the volume-rebuild path doesn't reliably re-run setMode in 3D).
  subscribe('seriesIdx', () => {
    if (is3dActive()) updateThreeDViewLabels(state.manifest?.series?.[state.seriesIdx]);
  });
  syncAnatomyLabelsToggle();
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
  const active = detectCTWindow(state.lowT, state.highT);
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

// The viewer area resized (a sidebar collapsed/expanded). Re-fit the active mode
// so the image fills the new space instead of staying at its old fit. The 2D
// transform and MPR/compare canvases are JS-sized, so CSS reflow alone can't do
// it; the 3D pane self-resizes via its #three-container ResizeObserver.
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
