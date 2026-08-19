// Centralized UI sync after state mutations.
//
// Every slice-navigation site was assembling its own redraw list,
// and most missed mode-specific updates (MPR crosshair, compare grid,
// 3D clip plane, sparkline, measurements). This module replaces those
// scattered lists with two functions:
//
//   syncSlice()    — call after any state.sliceIdx change
//   syncOverlays() — call after toggling tissue/labels/heatmap/colormap

import { $ } from './dom.js';
import { state, subscribe } from './core/state.js';
import { updateScrubFill } from './cine.js';
import { updateScrubMarkers } from './scrubber-markers.js';
import { syncMprSliceIndex } from './core/state/viewer-commands.js';
import {
  updateSliceDisplay,
  drawSlice,
  drawMPR,
  drawMPRInteractive,
  drawMPRZScrub,
  clearMprCellCache,
  releaseMprGpuVolumes,
} from './slice-view.js';
import { OVERLAY_ENABLE_KINDS } from './core/viewer-session-shape.js';
import { drawCompare, loadComparePeers } from './series/compare.js';
import { drawSparkline } from './sparkline.js';
import { drawMeasurements } from './roi/measure.js';
import { is3dActive, isMprActive } from './core/mode-flags.js';
import { ensureActiveOverlayVolumes } from './overlay/overlay-volumes.js';
import { initOverlayStack } from './overlay/overlay-stack.js';
import { updateUniforms, updateLabelTexture, syncThreeSurfaceState } from './volume/volume-3d.js';
import { updateClipReadouts } from './clip-readouts.js';
import { syncPanelRangeFills } from './panel-range-fills.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { OVERLAY_CACHE_BY_KIND, OVERLAY_CACHE_BY_TYPE } from './runtime/overlay-cache-keys.js';
import { renderStructuresPanel } from './atlas/structures-panel.js';
import { syncViewerRuntimeSession } from './runtime/viewer-session.js';
import { syncDisplayControlAvailability, syncMrPresetActiveState } from './shell/toolbar-chrome.js';
import { renderQuantificationPanel } from './metadata.js';

let _wired = false;
const SLICE_WINDOW_RADIUS = 5;

function scrubWindowRadius(series = state.manifest?.series?.[state.seriesIdx]) {
  return series?.sliceUrlBase ? 0 : SLICE_WINDOW_RADIUS;
}

function redrawActiveViews({ fullMpr = false, interactiveMpr = false } = {}) {
  if (state.mode === '2d') drawSlice();
  if (isMprActive()) {
    if (fullMpr && interactiveMpr) drawMPRInteractive();
    else if (fullMpr) drawMPR();
    else drawMPRZScrub();
  }
  if (state.mode === 'cmp') drawCompare();
}

// rAF coalescer: multiple `state.sliceIdx` writes inside one task
// (e.g. a wheel burst, a `batch()` block, or sliceIdx + mode toggles) collapse
// into a single redraw on the next animation frame. The coalescer also folds
// `fullMpr=true` requests so a same-tick mode change correctly upgrades the
// scheduled redraw to a full MPR pass.
//
// Skips the redraw entirely when `(sliceIdx, mode)` is unchanged AND no
// fullMpr request is pending — no-op writes do not waste a frame.
//
// Always runs the final redraw if `sliceIdx` changed since the last fired
// frame (regression anchor: never get stuck on the penultimate slice).
let _rafScheduled = false;
let _rafFullMpr = false;
let _rafInteractiveMpr = false;
let _rafForced = false;
let _rafLastSliceIdx = -1;
let _rafLastMode = '';

function scheduleRedraw({ fullMpr = false, interactiveMpr = false, force = false } = {}) {
  if (fullMpr) _rafFullMpr = true;
  if (interactiveMpr) _rafInteractiveMpr = true;
  if (force) _rafForced = true;
  if (_rafScheduled) return;
  _rafScheduled = true;
  const raf = globalThis.requestAnimationFrame instanceof Function
    ? globalThis.requestAnimationFrame
    : ((fn) => setTimeout(fn, 16));
  raf(() => {
    _rafScheduled = false;
    const fm = _rafFullMpr;
    const im = _rafInteractiveMpr;
    const forced = _rafForced;
    _rafFullMpr = false;
    _rafInteractiveMpr = false;
    _rafForced = false;
    if (state.sliceIdx === _rafLastSliceIdx && state.mode === _rafLastMode && !fm && !im && !forced) {
      return;
    }
    _rafLastSliceIdx = state.sliceIdx;
    _rafLastMode = state.mode;
    redrawActiveViews({ fullMpr: fm, interactiveMpr: im });
  });
}

export function syncZScrubberSlider(series = state.manifest?.series?.[state.seriesIdx]) {
  const el = $('s-zscrub');
  if (!el || !series) return;
  const max0 = Math.max(0, (series.slices | 0) - 1);
  el.max = String(max0);
  el.value = String(Math.min(max0, Math.max(0, Math.ceil(state.three.clipMax[2] * series.slices) - 1)));
  el.disabled = max0 <= 0;
  syncPanelRangeFills();
}

function syncSliceUI({ scrub = true } = {}) {
  if (scrub && $('scrub')) $('scrub').value = state.sliceIdx;
  updateScrubFill();
  updateScrubMarkers(state.sliceIdx);
  updateSliceDisplay(state.sliceIdx + 1);
  drawSparkline();
  drawMeasurements();
  syncZScrubberSlider();
}

function canRenderMprFromVolumes() {
  const session = syncViewerRuntimeSession();
  return !!session?.readiness?.mprReady;
}

function ensureVisibleStackWindow() {
  if (isMprActive() && canRenderMprFromVolumes()) return;
  const radius = scrubWindowRadius();
  const currentIdx = state.sliceIdx;
  const currentImgs = state.imgs;
  const redrawWhenReady = (imgs, promise, getCurrent) => promise?.then(() => {
    if (state.sliceIdx !== currentIdx || getCurrent() !== imgs) return;
    scheduleRedraw({ fullMpr: isMprActive(), force: true });
  });
  const ensureCurrentSlice = (imgs) => imgs?.ensureIndex?.(currentIdx);
  const warmNearbySlices = (imgs) => {
    if (radius > 0) imgs?.ensureWindow?.(currentIdx, radius);
  };
  redrawWhenReady(currentImgs, ensureCurrentSlice(currentImgs), () => state.imgs);
  warmNearbySlices(currentImgs);
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    const imgs = state[cache.imgs];
    redrawWhenReady(imgs, ensureCurrentSlice(imgs), () => state[cache.imgs]);
    warmNearbySlices(imgs);
  }
}

export function initReactiveSync({
  syncOverlayOpacityUI = () => {},
  renderVolumes = () => {},
  renderFusionPicker = () => {},
  renderRegionLegend = () => {},
  renderVolumeTable = () => {},
  renderRoiResults = () => {},
  renderMicroscopyHyperstackControls = () => {},
} = {}) {
  if (_wired) return;
  _wired = true;
  initOverlayStack({ onReady: syncOverlays });

  subscribe('sliceIdx', () => {
    ensureVisibleStackWindow();
    syncSliceUI();
    renderRoiResults();
    renderMicroscopyHyperstackControls();
    if (isMprActive() && state.mpr.z !== state.sliceIdx) syncMprSliceIndex();
    scheduleRedraw();
  });

  subscribe('mode', () => {
    syncSliceUI({ scrub: false });
    syncDisplayControlAvailability();
    renderRoiResults();
    renderMicroscopyHyperstackControls();
    if (isMprActive() && state.mpr.z !== state.sliceIdx) syncMprSliceIndex();
    scheduleRedraw({ fullMpr: true });
  });

  // Anatomy-label isolate/lock selection. Repaint the 2D/MPR/compare colored
  // mask and rebuild the 3D label LUT so isolation tracks hover and lock changes
  // (regionColors are filtered per-frame at draw time; no cache clear needed).
  // lockedLabels also flips the Structures checkbox state, so re-render the list.
  for (const key of ['lockedLabels', 'previewLabel']) {
    subscribe(key, () => {
      const three = getThreeRuntime();
      scheduleRedraw({ fullMpr: true });
      if (three.mesh) void updateLabelTexture();
      if (key === 'lockedLabels') renderStructuresPanel();
    });
  }
  // hiddenLabels (the Structures checkboxes' single source of truth): a toggle
  // repaints the 2D mask + 3D LUT and re-renders the list from effective state.
  subscribe('hiddenLabels', () => {
    const three = getThreeRuntime();
    scheduleRedraw({ fullMpr: true });
    if (three.mesh) void updateLabelTexture();
    renderStructuresPanel();
  });

  for (const key of ['window', 'level', 'colormap', 'invertDisplay', 'imgs', 'loaded']) {
    subscribe(key, () => {
      if (key === 'window' || key === 'level') syncMrPresetActiveState();
      if (key === 'imgs') {
        clearMprCellCache();
        releaseMprGpuVolumes();
      }
      syncViewerRuntimeSession();
      scheduleRedraw({ fullMpr: true });
    });
  }

  const overlayCacheKeys = Object.values(OVERLAY_CACHE_BY_TYPE).flatMap((cache) => [cache.imgs, cache.voxels]);
  const overlayEnableSubscribeKeys = OVERLAY_ENABLE_KINDS.map((kind) => `overlays.${kind}`);
  const overlayEnableSubscribeKeySet = new Set(overlayEnableSubscribeKeys);
  for (const key of [
    'overlays.useBrain',
    ...overlayEnableSubscribeKeys,
    ...overlayCacheKeys,
    'overlays.regionMeta',
    'overlays.fusionSlug',
    'overlays.stats',
  ]) {
    subscribe(key, () => {
      const three = getThreeRuntime();
      if (
        key === 'overlays.useBrain'
        || overlayEnableSubscribeKeySet.has(key)
        || key === 'overlays.fusionSlug'
      ) {
        clearMprCellCache();
      }
      syncViewerRuntimeSession();
      ensureActiveOverlayVolumes();
      ensureVisibleStackWindow();
      scheduleRedraw({ fullMpr: true });
      syncOverlayOpacityUI();
      renderFusionPicker();
      renderRegionLegend();
      renderQuantificationPanel();
      renderVolumeTable();
      renderStructuresPanel();
      renderVolumes();
      if (state.mode === 'cmp' && overlayEnableSubscribeKeySet.has(key)) {
        loadComparePeers().then(() => drawCompare());
      }
      if (three.mesh) {
        void updateLabelTexture();
      }
      syncThreeSurfaceState();
    });
  }

  for (const key of ['overlays.overlayOpacity', 'overlays.fusionOpacity']) {
    subscribe(key, () => {
      const three = getThreeRuntime();
      scheduleRedraw({ fullMpr: true });
      syncOverlayOpacityUI();
      if (three.mesh) {
        void updateLabelTexture();
      }
      syncThreeSurfaceState();
    });
  }

  for (const key of ['mpr.x', 'mpr.y']) {
    subscribe(key, () => {
      if (isMprActive()) scheduleRedraw({ fullMpr: true, interactiveMpr: true });
    });
  }

  for (const key of ['mpr.obYaw', 'mpr.obPitch']) {
    subscribe(key, () => {
      const yaw = $('ob-yaw-val');
      const pitch = $('ob-pitch-val');
      const yawSlider = $('ob-yaw');
      const pitchSlider = $('ob-pitch');
      if (yaw && yaw !== document.activeElement) yaw.value = state.mpr.obYaw;
      if (pitch && pitch !== document.activeElement) pitch.value = state.mpr.obPitch;
      if (yawSlider) yawSlider.value = state.mpr.obYaw;
      if (pitchSlider) pitchSlider.value = state.mpr.obPitch;
      const clipYaw = $('s-clip-plane-yaw');
      const clipPitch = $('s-clip-plane-pitch');
      if (clipYaw && clipYaw !== document.activeElement) clipYaw.value = state.mpr.obYaw;
      if (clipPitch && clipPitch !== document.activeElement) clipPitch.value = state.mpr.obPitch;
      if (is3dActive()) updateUniforms();
    });
  }

  subscribe('mpr.gpuEnabled', () => {
    if (!state.mpr.gpuEnabled) releaseMprGpuVolumes();
    if (isMprActive()) scheduleRedraw({ fullMpr: true, force: true });
  });

  for (const key of [
    'three.lowT',
    'three.highT',
    'three.intensity',
    'three.clipMin',
    'three.clipMax',
    'three.clipPlaneEnabled',
    'three.clipPlaneDepth',
    'three.clipPlaneInvert',
    'three.renderMode',
  ]) {
    subscribe(key, () => {
      updateClipReadouts();
      if (key === 'three.clipMax') syncZScrubberSlider();
      updateUniforms();
    });
  }
}

/**
 * Sync all UI after state.sliceIdx changed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.scrub=true]      Update scrub slider position
 * @param {boolean} [opts.fullMpr=false]   Full MPR redraw vs Z-plane only
 */
export function syncSlice({ scrub = true, fullMpr = false } = {}) {
  syncSliceUI({ scrub });
  redrawActiveViews({ fullMpr });
}

/**
 * Redraw all mode-appropriate canvases after an overlay or display change
 * (brain toggle, seg toggle, colormap change, window/level, invert, etc.).
 * Does NOT touch the scrub slider or slice counter — only redraws pixels.
 */
export function syncOverlays() {
  redrawActiveViews({ fullMpr: true });
  if (is3dActive() || isMprActive()) ensureActiveOverlayVolumes();
  if (is3dActive()) getThreeRuntime().requestRender?.('overlay-sync', 160);
}
