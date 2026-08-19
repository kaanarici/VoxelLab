// Orthogonal MPR cells (ax / coronal / sagittal), oblique reslice, hover, crosshair clicks.
// Depends on `ensureHRVoxels` / `state.voxels` from the shared volume path (volume-voxels-ensure, volume-hr-voxels).

import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { SEG_PALETTE } from '../core/constants.js';
import { drawingEntriesForSeries } from '../overlay/annotation-graph.js';
import { renderInspectionReadout, resolveVoxelInspection } from '../inspection-readout.js';
import { geometryFromSeries } from '../core/geometry.js';
import { mprPaneLabels } from '../core/view-orientation.js';
import { COLORMAPS, getFusedWLLut, getFusedWLU32 } from '../colormap.js';
import { ensureActiveOverlayVolumes } from '../overlay/overlay-volumes.js';
import { drawCompositeSlice } from '../slice-compositor.js';
import { setMprPosition, setMprProjection, setMprQuality } from '../core/state/viewer-commands.js';
import { beginPerfTrace, endPerfTrace, hasPendingPerfTrace } from '../core/perf-trace.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_KIND, overlayBytesFromCaches, overlayBytesPresent } from '../runtime/overlay-cache-keys.js';
import { selectionRegionColors } from '../runtime/region-color-isolation.js';
import { overlaySessionForSeries, reviewReadinessForSeries } from '../runtime/review-readiness.js';
import { updateMprOrientationMarkers } from '../shell/viewport.js';
import { sampleTrilinear } from './mpr-sampling.js';
import {
  obliqueBasis,
  drawObliqueMPR,
  fitObliqueCanvas,
  obliquePlaneExtentMm,
  obliqueRasterSize,
  obliqueSamplingCenterVoxel,
} from './mpr-oblique.js';
import {
  createMprProjection,
  planeForAxis,
  planeForOblique,
  projectDiscreteSlabLabel,
  projectVolumeSample,
  projectionCacheToken,
  maximumAccurateSlabThicknessMm,
} from './mpr-projection.js';
import { mprPlaneSizes, mprVoxelForPixel } from './mpr-geometry.js';

let _ensureVoxels = () => false;
let _isMprActive = () => false;
let _resizeInvalidatorWired = false;
let _mprResizeFrame = 0;
let _obliqueInteractionTimer = 0;
let _mprInteractiveAxis = '';
let _mprGpuApi = {
  canUseGpuMpr: () => false,
  drawGpuMprSlice: () => false,
  releaseGpuMprVolumeTextures: () => {},
};
let _mprGpuLoading = null;

function ensureMprGpuApi({ redraw = false } = {}) {
  if (_mprGpuLoading || !globalThis.document) return _mprGpuLoading;
  _mprGpuLoading = import('./mpr-gpu.js')
    .then((mod) => {
      _mprGpuApi = mod;
      if (redraw && _isMprActive()) requestAnimationFrame(() => drawMPR());
      return mod;
    })
    .catch(() => _mprGpuApi);
  return _mprGpuLoading;
}

export function initMprView(deps) {
  if (deps.ensureVoxels instanceof Function) _ensureVoxels = deps.ensureVoxels;
  if (deps.isMprActive instanceof Function) _isMprActive = deps.isMprActive;
  if (!_resizeInvalidatorWired) {
    window.addEventListener('resize', () => {
      for (const id of ['mpr-ax-cross', 'mpr-co-cross', 'mpr-sa-cross']) {
        const el = $(id);
        if (el) el._mprBoundsReady = false;
      }
      if (_mprResizeFrame || !_isMprActive()) return;
      _mprResizeFrame = requestAnimationFrame(() => {
        _mprResizeFrame = 0;
        if (_isMprActive()) drawMPR();
      });
    });
    _resizeInvalidatorWired = true;
  }
}

// Shape: true when the active series already has a full base volume in either
// `state.hrVoxels` (Float32 cloud/local raw) or `state.voxels` (Uint8 PNG stack).
export function hasMprBaseVolume(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series) return false;
  const voxelCount = series.width * series.height * series.slices;
  return !!(
    (state.hrVoxels && state.hrVoxels.length === voxelCount)
    || (state.voxels && state.voxels.length === voxelCount)
  );
}

export function showMprHover(canvas, ev, axis) {
  if (!_isMprActive()) return;
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const r = canvas.getBoundingClientRect();
  const cx = (ev.clientX - r.left) / r.width * canvas.width;
  const cy = (ev.clientY - r.top) / r.height * canvas.height;

  let vx, vy, vz;
  [vx, vy, vz] = mprVoxelForPixel(axis, cx, cy, canvas.width, canvas.height, series, {
    x: state.mpr.x,
    y: state.mpr.y,
    z: state.mpr.z,
  }).map(Math.round);
  vx = Math.max(0, Math.min(W - 1, vx));
  vy = Math.max(0, Math.min(H - 1, vy));
  vz = Math.max(0, Math.min(D - 1, vz));

  const inspection = resolveVoxelInspection(series, vx, vy, vz);

  const hov = $('hover-readout');
  hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'vx', includeSlice: true });
  hov.classList.add('visible');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  let x = ev.clientX - wrap.left + 14;
  let y = ev.clientY - wrap.top + 14;
  const hw = hov.offsetWidth, hh = hov.offsetHeight;
  if (x + hw > wrap.width - 8) x = ev.clientX - wrap.left - hw - 10;
  if (y + hh > wrap.height - 8) y = ev.clientY - wrap.top - hh - 10;
  hov.style.left = `${x}px`;
  hov.style.top = `${y}px`;
}

const _cellSampleCache = new Map();
let _mprQualityTimer = 0;
const OBLIQUE_SETTLE_MS = 140;
// Shape: ~24 MiB of cached sampled planes across recent coronal/sagittal views.
const CELL_CACHE_BUDGET_BYTES = 24 * 1024 * 1024;
let _cellSampleCacheBytes = 0;

function cellSampleBytes(entry) {
  return (entry?.base?.byteLength || 0)
    + (entry?.seg?.byteLength || 0)
    + (entry?.regions?.byteLength || 0)
    + (entry?.sym?.byteLength || 0)
    + (entry?.fusion?.byteLength || 0);
}

function trimCellSampleCache() {
  while (_cellSampleCacheBytes > CELL_CACHE_BUDGET_BYTES && _cellSampleCache.size > 1) {
    const oldestKey = _cellSampleCache.keys().next().value;
    const oldest = _cellSampleCache.get(oldestKey);
    _cellSampleCache.delete(oldestKey);
    _cellSampleCacheBytes -= oldest?._bytes || cellSampleBytes(oldest);
  }
}

function rememberCellSamples(key, entry) {
  const current = _cellSampleCache.get(key);
  if (current) {
    _cellSampleCache.delete(key);
    _cellSampleCacheBytes -= current._bytes || cellSampleBytes(current);
  }
  entry._bytes = cellSampleBytes(entry);
  _cellSampleCache.set(key, entry);
  _cellSampleCacheBytes += entry._bytes;
  trimCellSampleCache();
}

function readCellSamples(key) {
  const entry = _cellSampleCache.get(key);
  if (!entry) return null;
  _cellSampleCache.delete(key);
  _cellSampleCache.set(key, entry);
  return entry;
}

function sampleByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function activeMprGpu() {
  if (!state.mpr.gpuEnabled) return false;
  if (_mprGpuApi.canUseGpuMpr()) return true;
  ensureMprGpuApi({ redraw: true });
  return false;
}

function syncMprRendererStatus(renderer) {
  const note = $('mpr-gpu-note');
  if (!note) return;
  note.textContent = renderer === 'gpu' ? 'GPU' : renderer === 'cpu' ? 'CPU' : 'CPU fallback';
  note.dataset.renderer = renderer;
  const reason = renderer === 'fallback' ? _mprGpuApi.gpuMprFailureReason?.() : '';
  note.title = reason || '';
}

function fitCanvasDisplay(canvas, width, height, maxWidth, maxHeight) {
  if (!canvas?.style) return;
  const scale = Math.min(
    Math.max(0.01, maxWidth / Math.max(1, width)),
    Math.max(0.01, maxHeight / Math.max(1, height)),
  );
  canvas.style.width = `${Math.max(1, Math.round(width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(height * scale))}px`;
}

function scaledAxisPixel(value, sourceSize, targetSize) {
  if (!(sourceSize > 1) || !(targetSize > 1)) return 0;
  return value * (targetSize - 1) / (sourceSize - 1);
}

function applyMprViewportStyle(canvas) {
  const pane = {
    'mpr-ax': 'ax',
    'mpr-co': 'co',
    'mpr-sa': 'sa',
    'mpr-ob': 'ob',
  }[canvas?.id] || '';
  const view = pane ? state.mpr.viewports?.[pane] : null;
  if (!canvas?.style || !view) return;
  canvas.style.transformOrigin = '50% 50%';
  canvas.style.transform = `translate(${view.tx || 0}px, ${view.ty || 0}px) scale(${view.zoom || 1})`;
}

function drawMprNotePins(ctx, axis, outW, outH, series) {
  const notes = drawingEntriesForSeries(state, series).filter((entry) => entry.kind === 'note');
  if (!notes.length) return;
  const Dm1 = Math.max(1, series.slices - 1);
  const Wm1 = Math.max(1, series.width - 1);
  const Hm1 = Math.max(1, series.height - 1);
  const r = Math.max(4, Math.round(Math.min(outW, outH) * 0.02));
  ctx.save();
  for (const { sliceIdx, data } of notes) {
    let px = null;
    let py = null;
    if (axis === 'ax' && sliceIdx === state.mpr.z) {
      px = data.x * (outW - 1) / Wm1;
      py = data.y * (outH - 1) / Hm1;
    } else if (axis === 'co' && Math.round(data.y) === state.mpr.y) {
      px = data.x * (outW - 1) / Wm1;
      py = (1 - sliceIdx / Dm1) * (outH - 1);
    } else if (axis === 'sa' && Math.round(data.x) === state.mpr.x) {
      px = data.y * (outW - 1) / Hm1;
      py = (1 - sliceIdx / Dm1) * (outH - 1);
    }
    if (px == null || py == null) continue;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.stroke();
  }
  ctx.restore();
}

// Shape: Uint8Array(width * height) reused for one axial plane on a canvas.
function axialBaseBytes(canvas, width, height, zBase, vox, voxScale) {
  const planeSize = width * height;
  const source = voxScale === 1 ? vox.subarray(zBase, zBase + planeSize) : null;
  if (source) return source;
  if (!canvas._mprAxBaseBytes || canvas._mprAxBaseBytes.length !== planeSize) {
    canvas._mprAxBaseBytes = new Uint8Array(planeSize);
  }
  const baseBytes = canvas._mprAxBaseBytes;
  for (let i = 0; i < planeSize; i++) baseBytes[i] = sampleByte(vox[zBase + i] * voxScale);
  return baseBytes;
}

function mprImageDataForAxis(canvas, axis, ctx, width, height) {
  const cacheProp = `_mprImageData_${axis}`;
  let image = canvas[cacheProp];
  if (!image || image.width !== width || image.height !== height) {
    image = ctx.createImageData(width, height);
    canvas[cacheProp] = image;
  }
  return image;
}

function cellCacheKey(axis, outW, outH, series, useHR, overlayBytes, projection) {
  const plane = axis === 'ax' ? state.mpr.z : axis === 'co' ? state.mpr.y : state.mpr.x;
  const overlayToken = Object.values(OVERLAY_CACHE_BY_KIND)
    .map((cache) => `${cache.type}=${overlayBytes?.[cache.bytes] ? 1 : 0}`)
    .join(',');
  return [
    axis, series.slug, state.seriesIdx, `${outW}x${outH}`, `${series.width}x${series.height}x${series.slices}`,
    `plane=${plane}`,
    `quality=${state.mpr.quality}`,
    `projection=${projectionCacheToken(projection)}`,
    `src=${useHR ? 'hr' : 'lo'}`,
    overlayToken,
    `fusion=${state.overlays.fusionSlug || ''}`,
  ].join('|');
}

function clampMpr(series) {
  setMprPosition({ x: state.mpr.x, y: state.mpr.y, z: state.mpr.z }, series);
}

export function beginMprInteraction({ axis = 'z', reason = 'scrub' } = {}) {
  clearTimeout(_mprQualityTimer);
  _mprInteractiveAxis = axis;
  if (!hasPendingPerfTrace('mpr-axis-interaction')) {
    beginPerfTrace('mpr-axis-interaction', { axis, reason });
  }
  if (!hasPendingPerfTrace('mpr-quality-settle')) {
    beginPerfTrace('mpr-quality-settle', { axis, reason });
  }
  setMprQuality('fast');
  _mprQualityTimer = setTimeout(() => {
    _mprInteractiveAxis = '';
    setMprQuality('quality');
    if (_isMprActive()) drawMPR();
  }, 140);
}

export function beginObliqueInteraction(reason = 'slider') {
  clearTimeout(_obliqueInteractionTimer);
  if (state.mpr.quality !== 'fast') setMprQuality('fast');
  _obliqueInteractionTimer = setTimeout(() => {
    setMprQuality('quality');
    if (_isMprActive()) drawObliqueCell();
  }, OBLIQUE_SETTLE_MS);
  return reason;
}

function compositorOverlayVoxels(overlays) {
  const payload = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    const overlay = overlays[cache.kind];
    payload[cache.voxels] = overlay?.enabled ? overlay.voxels : null;
  }
  return payload;
}

function compositorOverlayVolumes(overlays, overlayVolumes) {
  return overlayBytesFromCaches((cache) => {
    const volume = overlayVolumes[cache.voxels];
    if (!volume) return null;
    if (cache.needsRegionMeta && !overlays[cache.kind]?.meta) return null;
    return volume;
  });
}

function compositorGpuOverlayVolumes(overlayVolumes) {
  const payload = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    payload[cache.voxels] = overlayVolumes[cache.bytes] || null;
  }
  return payload;
}

function syncMprOverlayStatus(series) {
  const overlays = activeOverlayStateForSeries(series);
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('mpr-pill-tissue', overlays.tissue.enabled);
  show('mpr-pill-regions', overlays.labels.enabled);
  show('mpr-pill-sym', overlays.heatmap.enabled);
  show('mpr-pill-fusion', overlays.fusion.enabled);
}

function updateMprLabels(series) {
  const labels = mprPaneLabels(series);
  for (const [axis, canvasId] of [['ax', 'mpr-ax'], ['co', 'mpr-co'], ['sa', 'mpr-sa'], ['ob', 'mpr-ob']]) {
    const label = $(`${canvasId}-label`);
    const canvas = $(canvasId);
    if (label) label.textContent = labels[axis];
    canvas?.setAttribute?.('aria-label', `${labels[axis]} slice`);
  }
  $('mpr-ax-idx').textContent = `Z ${state.mpr.z + 1}/${series.slices}`;
  $('mpr-co-idx').textContent = `Y ${state.mpr.y + 1}/${series.height}`;
  $('mpr-sa-idx').textContent = `X ${state.mpr.x + 1}/${series.width}`;
  updateMprOrientationMarkers(series);
  syncMprOverlayStatus(series);
}

function formatSlabThickness(value) {
  if (value >= 10) return `${Number(value.toFixed(1))} mm`;
  if (value >= 1) return `${Number(value.toFixed(2))} mm`;
  return `${Number(value.toFixed(3))} mm`;
}

function syncMprSlabLimit(series) {
  const geo = geometryFromSeries(series);
  const spacing = { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing };
  const maximum = Math.min(40, maximumAccurateSlabThicknessMm(spacing));
  if (state.mpr.slabThicknessMm > maximum) {
    setMprProjection({ slabThicknessMm: maximum });
  }
  const slider = $('mpr-slab');
  if (slider) {
    slider.max = String(maximum);
    slider.step = maximum >= 10 ? '1' : maximum >= 1 ? '0.1' : maximum >= 0.1 ? '0.01' : '0.001';
    if (slider !== document.activeElement) slider.value = String(state.mpr.slabThicknessMm);
  }
  const value = $('mpr-slab-val');
  if (value) value.textContent = formatSlabThickness(state.mpr.slabThicknessMm);
  return spacing;
}

// Shape: { interactive: true } for wheel-driven x/y scrub.
function drawMprFrame({ interactive = false } = {}) {
  if (!interactive) {
    clearTimeout(_mprQualityTimer);
    if (state.mpr.quality !== 'quality') setMprQuality('quality');
  } else if (state.mpr.quality !== 'fast') {
    setMprQuality('fast');
  }
  const series = state.manifest.series[state.seriesIdx];
  syncMprSlabLimit(series);
  if (!hasMprBaseVolume(series) && !_ensureVoxels()) return;
  ensureActiveOverlayVolumes();
  clampMpr(series);
  const { axW, axH, coW, coH, saW, saH } = mprPlaneSizes(series);
  const interactiveAxis = interactive ? _mprInteractiveAxis : '';

  if (interactiveAxis === 'x') {
    drawMPRCell($('mpr-sa'), 'sa', saW, saH);
  } else if (interactiveAxis === 'y') {
    drawMPRCell($('mpr-co'), 'co', coW, coH);
  } else {
    drawMPRCell($('mpr-ax'), 'ax', axW, axH);
    drawMPRCell($('mpr-co'), 'co', coW, coH);
    drawMPRCell($('mpr-sa'), 'sa', saW, saH);
  }
  updateMprCrosshairs(series, !interactive);
  updateMprLabels(series);
  drawObliqueCell();
  if (hasPendingPerfTrace('enter-mpr')) {
    endPerfTrace('enter-mpr', { slug: series.slug, mprZ: state.mpr.z });
  }
  if (interactive && hasPendingPerfTrace('mpr-axis-interaction')) {
    endPerfTrace('mpr-axis-interaction', { slug: series.slug, axis: 'orthogonal' });
  }
  if (!interactive && hasPendingPerfTrace('mpr-quality-settle')) {
    endPerfTrace('mpr-quality-settle', { slug: series.slug, axis: 'settle' });
  }
}

export function drawMPR() {
  drawMprFrame();
}

export function drawMPRInteractive() {
  drawMprFrame({ interactive: true });
}

export function drawMPRZScrub() {
  beginMprInteraction();
  const series = state.manifest.series[state.seriesIdx];
  if (!hasMprBaseVolume(series) && !_ensureVoxels()) return;
  ensureActiveOverlayVolumes();
  clampMpr(series);
  const { axW, axH } = mprPlaneSizes(series);
  drawMPRCell($('mpr-ax'), 'ax', axW, axH);
  updateMprCrosshairs(series, false);
  updateMprLabels(series);
  // Oblique is expensive and physically larger than the axial fast path; keep it
  // stable while scrubbing and let beginMprInteraction's settle redraw refresh it.
  if (hasPendingPerfTrace('enter-mpr')) {
    endPerfTrace('enter-mpr', { slug: series.slug, mprZ: state.mpr.z, partial: true });
  }
  if (hasPendingPerfTrace('mpr-axis-interaction')) {
    endPerfTrace('mpr-axis-interaction', { slug: series.slug, axis: 'z', partial: true });
  }
}

export function syncMprCrosshairBounds() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (series) updateMprCrosshairs(series, true);
}

function updateMprCrosshairs(series, syncBounds) {
  const Dm1 = Math.max(1, series.slices - 1);
  positionMprCrosshair(
    'mpr-ax-cross',
    $('mpr-ax'),
    scaledAxisPixel(state.mpr.x, series.width, $('mpr-ax')?.width || 0),
    scaledAxisPixel(state.mpr.y, series.height, $('mpr-ax')?.height || 0),
    syncBounds,
  );
  positionMprCrosshair(
    'mpr-co-cross',
    $('mpr-co'),
    scaledAxisPixel(state.mpr.x, series.width, $('mpr-co')?.width || 0),
    (1 - state.mpr.z / Dm1) * (($('mpr-co')?.height || 1) - 1),
    syncBounds,
  );
  positionMprCrosshair(
    'mpr-sa-cross',
    $('mpr-sa'),
    scaledAxisPixel(state.mpr.y, series.height, $('mpr-sa')?.width || 0),
    (1 - state.mpr.z / Dm1) * (($('mpr-sa')?.height || 1) - 1),
    syncBounds,
  );
}

function positionMprCrosshair(id, canvas, x, y, syncBounds) {
  const overlay = $(id);
  if (!overlay || !canvas) return;
  if (syncBounds || !overlay._mprBoundsReady) {
    const cell = canvas.parentElement;
    const cr = canvas.getBoundingClientRect();
    const pr = cell.getBoundingClientRect();
    overlay.style.left = `${cr.left - pr.left}px`;
    overlay.style.top = `${cr.top - pr.top}px`;
    overlay.style.width = `${cr.width}px`;
    overlay.style.height = `${cr.height}px`;
    overlay._mprBoundsReady = true;
  }
  const xp = Math.max(0, Math.min(1, canvas.width > 1 ? x / (canvas.width - 1) : x));
  const yp = Math.max(0, Math.min(1, canvas.height > 1 ? y / (canvas.height - 1) : y));
  overlay.style.setProperty('--x', `${xp * 100}%`);
  overlay.style.setProperty('--y', `${yp * 100}%`);
}

export function drawObliqueCell() {
  const canvas = $('mpr-ob');
  if (!canvas) return;
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const useHR = state.hrVoxels && state.hrVoxels.length === W * H * D;
  const vox = useHR ? state.hrVoxels : state.voxels;
  if (!vox) return;
  const voxScale = useHR ? 255 : 1;
  ensureActiveOverlayVolumes();
  const overlays = activeOverlayStateForSeries(series);

  // Parent cell rect = available canvas area (toolbar is outside the grid cells).
  const rect = canvas.parentElement?.getBoundingClientRect?.() || canvas.getBoundingClientRect();
  const geo = geometryFromSeries(series);
  const spacing = { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing };
  const extentMm = obliquePlaneExtentMm(
    { W, H, D },
    spacing,
    [state.mpr.x, state.mpr.y, state.mpr.z],
    state.mpr.obYaw,
    state.mpr.obPitch,
  );
  const availableWidth = Math.max(160, Math.round((rect.width || 512) - 16));
  const availableHeight = Math.max(120, Math.round((rect.height || 512) - 16));
  const fitted = fitObliqueCanvas(availableWidth, availableHeight, extentMm);
  const raster = obliqueRasterSize(fitted, 1024);
  const targetWidth = raster.width;
  const targetHeight = raster.height;
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  fitCanvasDisplay(canvas, targetWidth, targetHeight, fitted.width, fitted.height);
  applyMprViewportStyle(canvas);

  const lo = state.level - state.window / 2;
  const hi = state.level + state.window / 2;
  const sampleVolume = sampleTrilinear;
  const basis = obliqueBasis(state.mpr.obYaw, state.mpr.obPitch);
  const stepUMm = extentMm.widthMm / Math.max(1, targetWidth - 1);
  const stepVMm = extentMm.heightMm / Math.max(1, targetHeight - 1);
  const du = [
    basis.u[0] * stepUMm / spacing.col,
    basis.u[1] * stepUMm / spacing.row,
    basis.u[2] * stepUMm / spacing.slice,
  ];
  const dv = [
    basis.v[0] * stepVMm / spacing.col,
    basis.v[1] * stepVMm / spacing.row,
    basis.v[2] * stepVMm / spacing.slice,
  ];
  const crosshair = [state.mpr.x, state.mpr.y, state.mpr.z];
  const samplingCenter = obliqueSamplingCenterVoxel(
    crosshair,
    spacing,
    state.mpr.obYaw,
    state.mpr.obPitch,
    extentMm,
  );
  const plane = planeForOblique(targetWidth, targetHeight, samplingCenter, du, dv);
  const projection = createMprProjection({
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  }, spacing, plane);
  const overlayOptions = {
    ...compositorOverlayVoxels(overlays),
    segPalette: SEG_PALETTE,
    regionColors: selectionRegionColors(overlays.labels.meta?.colors || null, state),
    regionAlpha: state.overlays.overlayOpacity,
    fusionAlpha: state.overlays.fusionOpacity,
    hotLut: COLORMAPS.hot.lut,
  };

  if (activeMprGpu()) {
    const rendered = _mprGpuApi.drawGpuMprSlice(canvas, {
      plane,
      projection,
      dims: { W, H, D },
      vox,
      wlLut: getFusedWLLut(),
      regionColors: overlayOptions.regionColors,
      regionAlpha: overlayOptions.regionAlpha,
      fusionAlpha: overlayOptions.fusionAlpha,
      ...compositorOverlayVoxels(overlays),
      hotLut: overlayOptions.hotLut,
    });
    if (rendered) {
      syncMprRendererStatus('gpu');
      const lab = $('mpr-ob-idx');
      if (lab) lab.textContent = `grid yaw ${state.mpr.obYaw}° · pitch ${state.mpr.obPitch}°`;
      updateMprOrientationMarkers(series);
      if (hasPendingPerfTrace('mpr-oblique-paint')) {
        endPerfTrace('mpr-oblique-paint', { slug: series.slug, yaw: state.mpr.obYaw, pitch: state.mpr.obPitch, renderer: 'gpu' });
      }
      return;
    }
  }

  syncMprRendererStatus(state.mpr.gpuEnabled ? 'fallback' : 'cpu');

  drawObliqueMPR(
    canvas, vox, voxScale,
    { W, H, D },
    spacing,
    crosshair,
    state.mpr.obYaw, state.mpr.obPitch,
    extentMm, lo, hi,
    overlayOptions,
    sampleVolume,
    projection,
  );

  const lab = $('mpr-ob-idx');
  if (lab) lab.textContent = `grid yaw ${state.mpr.obYaw}° · pitch ${state.mpr.obPitch}°`;
  updateMprOrientationMarkers(series);
  if (hasPendingPerfTrace('mpr-oblique-paint')) {
    endPerfTrace('mpr-oblique-paint', { slug: series.slug, yaw: state.mpr.obYaw, pitch: state.mpr.obPitch, renderer: 'cpu' });
  }
}

function drawMPRCell(canvas, axis, outW, outH) {
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  if (canvas.width !== outW) canvas.width = outW;
  if (canvas.height !== outH) canvas.height = outH;
  const cellRect = canvas.parentElement?.getBoundingClientRect?.();
  const availableWidth = Math.max(1, Math.round((cellRect?.width || outW) - 12));
  const availableHeight = Math.max(1, Math.round((cellRect?.height || outH) - 12));
  fitCanvasDisplay(
    canvas,
    outW,
    outH,
    availableWidth,
    availableHeight,
  );
  applyMprViewportStyle(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const useHR = state.hrVoxels && state.hrVoxels.length === W * H * D;
  const vox = useHR ? state.hrVoxels : state.voxels;
  const voxScale = useHR ? 255 : 1;
  const overlays = activeOverlayStateForSeries(series);
  const overlayVolumes = compositorOverlayVolumes(overlays, compositorOverlayVoxels(overlays));
  const regionColors = overlayVolumes.regionBytes
    ? selectionRegionColors(overlays.labels.meta.colors, state)
    : null;
  const regionAlpha = state.overlays.overlayOpacity;
  const fusionAlpha = state.overlays.fusionOpacity;
  const hotLut = overlayVolumes.fusionBytes ? COLORMAPS.hot.lut : null;
  const WH = W * H;
  const hasOverlays = overlayBytesPresent(overlayVolumes);
  const geo = geometryFromSeries(series);
  const spacing = { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing };
  const plane = planeForAxis(axis, outW, outH, series, { x: state.mpr.x, y: state.mpr.y, z: state.mpr.z }, mprVoxelForPixel);
  const projection = createMprProjection({
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  }, spacing, plane);
  const dims = { W, H, D };
  if (activeMprGpu()) {
    const rendered = _mprGpuApi.drawGpuMprSlice(canvas, {
      plane,
      projection,
      dims,
      vox,
      wlLut: getFusedWLLut(),
      regionColors,
      regionAlpha,
      fusionAlpha,
      ...compositorGpuOverlayVolumes(overlayVolumes),
      hotLut,
    });
    if (rendered) {
      syncMprRendererStatus('gpu');
      drawMprNotePins(ctx, axis, outW, outH, series);
      return;
    }
  }

  syncMprRendererStatus(state.mpr.gpuEnabled ? 'fallback' : 'cpu');

  const sampleGray = (volume, x, y, z) => sampleTrilinear(volume, x, y, z, W, H, D);
  const isThinProjection = projection.sampleCount <= 1 || projection.mode === 'thin';
  const sampleProjectedBase = isThinProjection
    ? (x, y, z) => sampleGray(vox, x, y, z)
    : (x, y, z) => projectVolumeSample(vox, x, y, z, dims, sampleGray, projection);

  // Native-plane fast path: only valid when canvas pixel dims match the source
  // WxH. When rowSpacing != colSpacing, mprPlaneSizes stretches axH for aspect
  // correction, so outH != H — fall through to the generic resampling path
  // below to avoid writing a WxH plane into an outWxoutH buffer.
  // Shape: outW=W=512, outH=665 when rowSpacing/colSpacing=1.3 (anisotropic).
  if (axis === 'ax' && projection.sampleCount <= 1 && outW === W && outH === H) {
    const zBase = state.mpr.z * WH;
    if (!hasOverlays) {
      const img = mprImageDataForAxis(canvas, axis, ctx, outW, outH);
      const out32 = new Uint32Array(img.data.buffer);
      const fusedU32 = getFusedWLU32();
      for (let i = 0; i < WH; i++) {
        const raw = sampleByte(vox[zBase + i] * voxScale);
        out32[i] = fusedU32[raw];
      }
      ctx.putImageData(img, 0, 0);
      drawMprNotePins(ctx, axis, outW, outH, series);
      return;
    }
    drawCompositeSlice(ctx, outW, outH, {
      baseBytes: axialBaseBytes(canvas, W, H, zBase, vox, voxScale),
      overlayBytes: overlayBytesFromCaches((cache) => {
        const volume = overlayVolumes[cache.bytes];
        return volume ? volume.subarray(zBase, zBase + WH) : null;
      }),
      wlLut: getFusedWLLut(),
      regionColors,
      regionAlpha,
      fusionAlpha,
      hotLut,
      forceTextureUploads: { base: voxScale !== 1 },
    });
    drawMprNotePins(ctx, axis, outW, outH, series);
    return;
  }
  const cacheKey = cellCacheKey(axis, outW, outH, series, useHR, overlayVolumes, projection);
  let cached = readCellSamples(cacheKey);
  const sampleOverlay = (vol, x, y, z) => sampleTrilinear(vol, x, y, z, W, H, D);
  const sampleProjectedOverlay = isThinProjection
    ? (vol, x, y, z) => sampleOverlay(vol, x, y, z)
    : (vol, x, y, z) => projectVolumeSample(vol, x, y, z, dims, sampleOverlay, projection);
  if (!cached) {
    cached = {
      base: new Uint8Array(outW * outH),
      overlayBytes: overlayBytesFromCaches((cache) => (
        overlayVolumes[cache.bytes] ? new Uint8Array(outW * outH) : null
      )),
    };
    // Shape: current orthogonal crosshair reused across every pixel sample in this draw.
    const crosshair = { x: state.mpr.x, y: state.mpr.y, z: state.mpr.z };
    let sampleIndex = 0;
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++, sampleIndex++) {
        const [vx, vy, vz] = mprVoxelForPixel(axis, ox, oy, outW, outH, series, crosshair);
        cached.base[sampleIndex] = sampleByte(sampleProjectedBase(vx, vy, vz) * voxScale);
        for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
          const dest = cached.overlayBytes[cache.bytes];
          if (!dest) continue;
          const volume = overlayVolumes[cache.bytes];
          dest[sampleIndex] = cache.sample === 'nearest'
            ? projectDiscreteSlabLabel(volume, vox, vx, vy, vz, dims, sampleOverlay, projection)
            : sampleByte(sampleProjectedOverlay(volume, vx, vy, vz));
        }
      }
    }
    rememberCellSamples(cacheKey, cached);
  }
  if (!hasOverlays) {
    const img = mprImageDataForAxis(canvas, axis, ctx, outW, outH);
    const fusedU32 = getFusedWLU32();
    const out32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < cached.base.length; i++) out32[i] = fusedU32[cached.base[i]];
    ctx.putImageData(img, 0, 0);
    drawMprNotePins(ctx, axis, outW, outH, series);
    return;
  }
  drawCompositeSlice(ctx, outW, outH, {
    baseBytes: cached.base,
    overlayBytes: cached.overlayBytes,
    wlLut: getFusedWLLut(),
    regionColors,
    regionAlpha,
    fusionAlpha,
    hotLut,
  });
  drawMprNotePins(ctx, axis, outW, outH, series);
}

export function clearMprCellCache() {
  _cellSampleCache.clear();
  _cellSampleCacheBytes = 0;
}

export function releaseMprGpuVolumes() {
  _mprGpuApi.releaseGpuMprVolumeTextures?.();
}

// Shape: { entries: 6, bytes: 7340032 } for devtools/tests.
export function getMprCellCacheStats() {
  return {
    entries: _cellSampleCache.size,
    bytes: _cellSampleCacheBytes,
  };
}

// Shape: { baseReady: true, overlaysReady: { tissue: false, labels: true, heatmap: false, fusion: false } }.
export function getMprVolumeReadiness(series = state.manifest?.series?.[state.seriesIdx]) {
  const overlays = activeOverlayStateForSeries(series);
  const overlaysReady = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    const overlay = overlays[cache.kind];
    overlaysReady[cache.kind] = !overlay.enabled || overlay.ready;
  }
  const overlaySession = overlaySessionForSeries(series);
  const readiness = reviewReadinessForSeries(series, { overlaySession });
  return {
    baseReady: readiness.baseVolume,
    overlaysReady,
  };
}

export function __setMprGpuApiForTests(api) {
  _mprGpuApi = api || {
    canUseGpuMpr: () => false,
    drawGpuMprSlice: () => false,
    releaseGpuMprVolumeTextures: () => {},
  };
}

export function mprClickToVoxel(canvas, ev, axis) {
  const r = canvas.getBoundingClientRect();
  const cx = Math.floor((ev.clientX - r.left) / r.width * canvas.width);
  const cy = Math.floor((ev.clientY - r.top) / r.height * canvas.height);
  const series = state.manifest.series[state.seriesIdx];
  const [vx, vy, vz] = mprVoxelForPixel(axis, cx, cy, canvas.width, canvas.height, series, {
    x: state.mpr.x,
    y: state.mpr.y,
    z: state.mpr.z,
  }).map(Math.round);
  setMprPosition({ x: vx, y: vy, z: vz }, series, { syncSlice: true });
}
