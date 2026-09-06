import { state, batch } from '../state.js';
import { clampSlabThicknessMm, clampClipPlaneDepth, clampObliquePitch, clampObliqueYaw, normalizeMprProjectionMode } from '../view-limits.js';
import { geometryFromSeries } from '../geometry.js';
import { is3dActive } from '../mode-flags.js';
import { seriesIdentityKey } from '../series-identity.js';
import { volumeProjectionSamplingSupport } from '../volume-limits.js';
import { normalizeRegionMeta } from '../region-meta.js';
import {
  applyOverlayEnableSnapshot,
  OVERLAY_ENABLE_KINDS,
  overlayEnableSnapshot,
  RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE,
  RUNTIME_OVERLAY_KIND_BY_TYPE,
} from '../viewer-session-shape.js';
import { rememberSeriesViewState, viewStateForSeries } from './series-view-memory.js';
import { setLastActiveSeries } from './session-persistence.js';
import { clampSliceIndex, currentSeriesSlug, getCurrentSeries } from './viewer-selectors.js';

const OVERLAY_ENABLE_KIND_SET = new Set(OVERLAY_ENABLE_KINDS);

function clipMaxZForSlice(sliceIdx, slices) {
  const count = Math.max(1, Number(slices) || 1);
  const index = Math.max(0, Math.min(Math.floor(Number(sliceIdx) || 0), count - 1));
  return (index + 1) / count;
}

function sliceIndexForClipMaxZ(clipZ, slices) {
  const count = Math.max(1, Number(slices) || 1);
  return Math.max(0, Math.min(count - 1, Math.ceil(Number(clipZ) * count) - 1));
}

function syncThreeClipToSlice(series = getCurrentSeries()) {
  if (!is3dActive() || !series) return;
  const nextZ = clipMaxZForSlice(state.sliceIdx, series.slices);
  if (Math.abs(state.three.clipMax[2] - nextZ) <= 1e-9) return;
  const nextMin = state.three.clipMin.slice();
  const nextMax = state.three.clipMax.slice();
  nextMax[2] = Math.max(nextZ, nextMin[2] + 0.01);
  setClipRange(nextMin, nextMax);
}

export function setManifest(manifest) {
  state.manifest = manifest;
  return manifest;
}

export function setManifestCollections({ series, projectionSets } = {}) {
  if (!state.manifest) return null;
  batch(() => {
    if (series !== undefined) state.manifest.series = series;
    if (projectionSets !== undefined) state.manifest.projectionSets = projectionSets;
  });
  return state.manifest;
}

function isPlainRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function mergeSeriesRecordPatch(current, patch) {
  if (!isPlainRecord(current) || !isPlainRecord(patch)) return current;
  const next = { ...current, ...patch };
  if (isPlainRecord(current.microscopy) || isPlainRecord(patch.microscopy)) {
    const currentMicroscopy = isPlainRecord(current.microscopy) ? current.microscopy : {};
    const patchMicroscopy = isPlainRecord(patch.microscopy) ? patch.microscopy : {};
    const microscopy = { ...currentMicroscopy, ...patchMicroscopy };
    if (isPlainRecord(currentMicroscopy.composite) || isPlainRecord(patchMicroscopy.composite)) {
      const currentComposite = isPlainRecord(currentMicroscopy.composite) ? currentMicroscopy.composite : {};
      const patchComposite = isPlainRecord(patchMicroscopy.composite) ? patchMicroscopy.composite : {};
      microscopy.composite = { ...currentComposite, ...patchComposite };
      if (Array.isArray(patchComposite.channels)) {
        microscopy.composite.channels = patchComposite.channels.slice();
      } else if (Array.isArray(currentComposite.channels)) {
        microscopy.composite.channels = currentComposite.channels.slice();
      }
    }
    next.microscopy = microscopy;
  }
  return next;
}

export function findManifestSeriesIndex(seriesOrIndex, list = state.manifest?.series, manifest = state.manifest) {
  if (!Array.isArray(list)) return -1;
  if (Number.isInteger(seriesOrIndex)) {
    return seriesOrIndex >= 0 && seriesOrIndex < list.length ? seriesOrIndex : -1;
  }
  if (!isPlainRecord(seriesOrIndex)) return -1;
  const direct = list.indexOf(seriesOrIndex);
  if (direct >= 0) return direct;
  const key = seriesIdentityKey(seriesOrIndex, manifest);
  if (!key) return -1;
  return list.findIndex((item) => seriesIdentityKey(item, manifest) === key);
}

export function patchManifestSeries(seriesOrIndex, patch = {}) {
  const list = state.manifest?.series;
  const index = findManifestSeriesIndex(seriesOrIndex, list, state.manifest);
  if (index < 0) return null;
  if (!isPlainRecord(patch) || !Object.keys(patch).length) return list[index];
  const next = mergeSeriesRecordPatch(list[index], patch);
  const series = list.slice();
  series[index] = next;
  setManifestCollections({ series });
  return state.manifest.series[index];
}

export function setAnalysis(analysis) {
  state.overlays.analysis = analysis;
  return state.overlays.analysis;
}

export function setAnalysisBusy(busy) {
  state.overlays.analysisBusy = !!busy;
  return state.overlays.analysisBusy;
}

export function setRegionMeta(regionMeta) {
  state.overlays.regionMeta = normalizeRegionMeta(regionMeta);
  return state.overlays.regionMeta;
}

export function setStats(stats) {
  state.overlays.stats = stats || null;
  return state.overlays.stats;
}

export function setFusionSelection(slug) {
  state.overlays.fusionSlug = slug || null;
  return state.overlays.fusionSlug;
}

export function setSliceIndex(next, series = getCurrentSeries()) {
  const clamped = clampSliceIndex(next, series);
  state.sliceIdx = clamped;
  syncThreeClipToSlice(series);
  return clamped;
}

export function stepSlice(delta, series = getCurrentSeries()) {
  return setSliceIndex(state.sliceIdx + delta, series);
}

export function setWindowLevel(windowValue, levelValue) {
  batch(() => {
    state.window = Math.max(1, Math.min(512, windowValue));
    state.level = Math.max(0, Math.min(255, levelValue));
  });
  return { window: state.window, level: state.level };
}

export function setLoaded(loaded) {
  state.loaded = !!loaded;
  return state.loaded;
}

export function setInvertDisplay(enabled) {
  state.invertDisplay = !!enabled;
  return state.invertDisplay;
}

export function setComparePeers(slugs) {
  const next = Array.isArray(slugs) ? slugs.filter(Boolean) : [];
  state.cmpManualSlugs = next.length >= 2 ? next : null;
  return state.cmpManualSlugs;
}

export function bumpSelectRequest() {
  state.selectRequestId += 1;
  return state.selectRequestId;
}

export function setSeriesIndex(index) {
  state.seriesIdx = index;
  return state.seriesIdx;
}

export function forgetSeriesViewMemory(viewKey) {
  if (viewKey && state.seriesViewMemory) delete state.seriesViewMemory[viewKey];
}

export function emptyViewer() {
  batch(() => {
    state.seriesIdx = -1;
    state.sliceIdx = 0;
    state.mode = '2d';
    state.loaded = false;
  });
}

export function setZoomTransform({ zoom = state.zoom, tx = state.tx, ty = state.ty } = {}) {
  batch(() => {
    state.zoom = Math.max(0.5, Math.min(10, zoom));
    state.tx = tx;
    state.ty = ty;
  });
  return { zoom: state.zoom, tx: state.tx, ty: state.ty };
}

export function setFitZoom(scale) {
  batch(() => {
    state.zoom = Math.max(0.25, Math.min(10, scale));
    state.tx = 0;
    state.ty = 0;
  });
  return { zoom: state.zoom, tx: state.tx, ty: state.ty };
}

function ensureCompareViewportState() {
  state.compare ||= {};

  state.compare.viewport ||= { zoom: 1, tx: 0, ty: 0 };
  return state.compare.viewport;
}

export function setCompareViewport({
  zoom = ensureCompareViewportState()?.zoom,
  tx = ensureCompareViewportState()?.tx,
  ty = ensureCompareViewportState()?.ty,
} = {}) {
  const view = ensureCompareViewportState();
  batch(() => {
    view.zoom = Math.max(1, Math.min(8, Number(zoom) || 1));
    view.tx = Number.isFinite(+tx) ? +tx : 0;
    view.ty = Number.isFinite(+ty) ? +ty : 0;
  });
  return { zoom: view.zoom, tx: view.tx, ty: view.ty };
}

export function resetCompareViewport() {
  return setCompareViewport({ zoom: 1, tx: 0, ty: 0 });
}

export function setViewMode(mode) {
  state.mode = mode;
  return mode;
}

export function setCineFps(fps) {
  state.cineFps = Number(fps) || 0;
  return state.cineFps;
}

export function setOverlayOpacity(opacity) {
  state.overlays.overlayOpacity = +opacity;
  return state.overlays.overlayOpacity;
}

export function setFusionOpacity(opacity) {
  state.overlays.fusionOpacity = +opacity;
  return state.overlays.fusionOpacity;
}

export function setRenderMode(mode) {
  const requested = mode === 'mip' || mode === 'minip' ? mode : 'alpha';
  const series = getCurrentSeries();
  if (!renderModeSupportedForSeries(requested, series)) return state.three.renderMode;
  state.three.renderMode = requested;
  return state.three.renderMode;
}

function renderModeSupportedForSeries(mode, series) {
  if (mode !== 'mip' && mode !== 'minip') return true;
  if (!series) return false;
  return volumeProjectionSamplingSupport({
    width: series.width,
    height: series.height,
    depth: series.slices,
  }).supported;
}

export function setColormap(name) {
  if (!name) return state.colormap;
  state.colormap = name;
  return state.colormap;
}

export function setVolumeTransfer({ lowT = state.three.lowT, highT = state.three.highT, intensity = state.three.intensity } = {}) {
  batch(() => {
    state.three.lowT = lowT;
    state.three.highT = highT;
    state.three.intensity = intensity;
  });
  return { lowT: state.three.lowT, highT: state.three.highT, intensity: state.three.intensity };
}

export function applyViewerPreset(preset = {}) {
  batch(() => {
    if (preset.lowT !== undefined) state.three.lowT = preset.lowT;
    if (preset.highT !== undefined) state.three.highT = preset.highT;
    if (preset.intensity !== undefined) state.three.intensity = preset.intensity;
    if (preset.clipMin) state.three.clipMin = preset.clipMin.slice();
    if (preset.clipMax) state.three.clipMax = preset.clipMax.slice();
    if (preset.clipPlaneEnabled !== undefined) state.three.clipPlaneEnabled = !!preset.clipPlaneEnabled;
    if (preset.mode) {
      const requestedMode = preset.mode === 'mip' || preset.mode === 'minip' ? preset.mode : 'alpha';
      if (renderModeSupportedForSeries(requestedMode, getCurrentSeries())) state.three.renderMode = requestedMode;
    }
  });
  return {
    lowT: state.three.lowT,
    highT: state.three.highT,
    intensity: state.three.intensity,
    clipMin: state.three.clipMin.slice(),
    clipMax: state.three.clipMax.slice(),
    mode: state.three.renderMode,
    clipPlaneEnabled: state.three.clipPlaneEnabled,
  };
}

export function setClipRange(min, max) {
  batch(() => {
    if (min) state.three.clipMin = min.slice();
    if (max) state.three.clipMax = max.slice();
  });
  return { clipMin: state.three.clipMin.slice(), clipMax: state.three.clipMax.slice() };
}

export function setSeriesDesktopImportId(seriesIndex, importId) {
  const next = patchManifestSeries(seriesIndex, { _desktopImportId: String(importId || '') });
  return next?._desktopImportId || '';
}

export function setClipAxis(bound, axisIndex, value) {
  const nextMin = state.three.clipMin.slice();
  const nextMax = state.three.clipMax.slice();
  if (bound === 'min') nextMin[axisIndex] = Math.min(value, nextMax[axisIndex] - 0.01);
  if (bound === 'max') nextMax[axisIndex] = Math.max(value, nextMin[axisIndex] + 0.01);
  const result = setClipRange(nextMin, nextMax);
  if (is3dActive() && bound === 'max' && axisIndex === 2) {
    const slice = sliceIndexForClipMaxZ(state.three.clipMax[2], getCurrentSeries()?.slices);
    if (slice !== state.sliceIdx) state.sliceIdx = slice;
  }
  return result;
}

export function setObliqueClip({
  enabled = state.three.clipPlaneEnabled,
  depth = state.three.clipPlaneDepth,
  invert = state.three.clipPlaneInvert,
} = {}) {
  batch(() => {
    state.three.clipPlaneEnabled = !!enabled;
    state.three.clipPlaneDepth = clampClipPlaneDepth(depth);
    state.three.clipPlaneInvert = !!invert;
  });
  return {
    enabled: state.three.clipPlaneEnabled,
    depth: state.three.clipPlaneDepth,
    invert: state.three.clipPlaneInvert,
  };
}

export function syncSeriesIdxForActiveSlug(manifest, activeSlug = currentSeriesSlug()) {
  if (!activeSlug) return -1;
  const nextIdx = manifest.series.findIndex((series) => series.slug === activeSlug);
  if (nextIdx >= 0) state.seriesIdx = nextIdx;
  return nextIdx;
}

function writeAppMapEntry(bucketName, key, list) {
  const mapKey = String(key || '');
  if (!mapKey) return;
  const value = Array.isArray(list) && list.length ? list.map((entry) => ({ ...entry })) : undefined;
  batch(() => {
    if (!state[bucketName] || Object.getPrototypeOf(state[bucketName]) !== Object.prototype) {
      state[bucketName] = {};
    }
    if (value === undefined) delete state[bucketName][mapKey];
    else state[bucketName][mapKey] = value;
  });
}

export function setMeasurementMapEntry(key, list) {
  writeAppMapEntry('measurements', key, list);
}

export function setAngleMeasurementMapEntry(key, list) {
  writeAppMapEntry('angleMeasurements', key, list);
}

export function setRoiMapEntry(key, list) {
  writeAppMapEntry('rois', key, list);
}

export function setNoteMapEntry(key, list) {
  writeAppMapEntry('notes', key, list);
}

export function setOverlayEnabled(kind, enabled, exclusive = []) {
  if (!OVERLAY_ENABLE_KIND_SET.has(kind)) return false;
  batch(() => {
    state.overlays[kind] = !!enabled;
    if (enabled) {
      for (const other of exclusive) {
        if (OVERLAY_ENABLE_KIND_SET.has(other)) state.overlays[other] = false;
      }
    }
  });
  return !!state.overlays[kind];
}

export function enableRegionsIfAvailable(series = getCurrentSeries()) {
  const flag = RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.regions?.availableFlag;
  if (flag && series?.[flag]) state.overlays.labels = true;
  return state.overlays.labels;
}

export function initializeSeriesViewState(series = getCurrentSeries()) {
  if (!series) return null;
  batch(() => {
    state.mpr.x = Math.floor(series.width / 2);
    state.mpr.y = Math.floor(series.height / 2);
    state.mpr.z = Math.floor(series.slices / 2);
    state.mpr.viewports = {
      ax: { zoom: 1, tx: 0, ty: 0 },
      co: { zoom: 1, tx: 0, ty: 0 },
      sa: { zoom: 1, tx: 0, ty: 0 },
      ob: { zoom: 1, tx: 0, ty: 0 },
    };
    if (!series.hasBrain) state.overlays.useBrain = false;
    for (const [type, cache] of Object.entries(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)) {
      const flag = cache.availableFlag;
      const kind = RUNTIME_OVERLAY_KIND_BY_TYPE[type];
      if (!flag || !kind) continue;
      if (!series[flag]) state.overlays[kind] = false;
    }
  });
  return {
    mprX: state.mpr.x,
    mprY: state.mpr.y,
    mprZ: state.mpr.z,
    ...overlayEnableSnapshot(state.overlays),
  };
}

export function setMprPosition(
  { x = state.mpr.x, y = state.mpr.y, z = state.mpr.z } = {},
  series = getCurrentSeries(),
  { syncSlice = false } = {},
) {
  if (!series) return null;
  const nextX = Math.max(0, Math.min(series.width - 1, Math.round(x)));
  const nextY = Math.max(0, Math.min(series.height - 1, Math.round(y)));
  const nextZ = clampSliceIndex(Math.round(z), series);
  batch(() => {
    state.mpr.x = nextX;
    state.mpr.y = nextY;
    state.mpr.z = nextZ;
    if (syncSlice) state.sliceIdx = nextZ;
  });
  return { mprX: state.mpr.x, mprY: state.mpr.y, mprZ: state.mpr.z, sliceIdx: state.sliceIdx };
}

export function nudgeMprAxis(axis, delta, series = getCurrentSeries()) {
  if (axis === 'x') return setMprPosition({ x: state.mpr.x + delta }, series);
  if (axis === 'y') return setMprPosition({ y: state.mpr.y + delta }, series);
  return setMprPosition({ z: state.mpr.z + delta }, series, { syncSlice: true });
}

export function syncMprSliceIndex(series = getCurrentSeries()) {
  return setMprPosition({ z: state.sliceIdx }, series);
}

export function setMprQuality(quality) {
  state.mpr.quality = quality;
  return state.mpr.quality;
}

export function setMprGpuEnabled(enabled) {
  state.mpr.gpuEnabled = !!enabled;
  return state.mpr.gpuEnabled;
}

function mprViewportPane(pane) {
  return pane === 'ax' || pane === 'co' || pane === 'sa' || pane === 'ob' ? pane : '';
}

function ensureMprViewportState(pane) {
  const key = mprViewportPane(pane);
  if (!key) return null;
  state.mpr.viewports ||= {};

  const current = state.mpr.viewports[key];
  if (current && Number.isFinite(+current.zoom)) return current;
  state.mpr.viewports[key] = { zoom: 1, tx: 0, ty: 0 };
  return state.mpr.viewports[key];
}

export function getMprViewport(pane) {
  const view = ensureMprViewportState(pane);
  if (!view) return null;
  return { zoom: view.zoom, tx: view.tx, ty: view.ty };
}

export function setMprProjection({
  mode = state.mpr.projectionMode,
  slabThicknessMm = state.mpr.slabThicknessMm,
} = {}) {
  const series = getCurrentSeries();
  const geometry = series ? geometryFromSeries(series) : null;
  const spacing = geometry ? {
    row: geometry.rowSpacing,
    col: geometry.colSpacing,
    slice: geometry.sliceSpacing,
  } : null;
  batch(() => {
    state.mpr.projectionMode = normalizeMprProjectionMode(mode);
    state.mpr.slabThicknessMm = clampSlabThicknessMm(slabThicknessMm, spacing);
  });
  return {
    mode: state.mpr.projectionMode,
    slabThicknessMm: state.mpr.slabThicknessMm,
  };
}

export function setMprViewport(pane, {
  zoom = ensureMprViewportState(pane)?.zoom,
  tx = ensureMprViewportState(pane)?.tx,
  ty = ensureMprViewportState(pane)?.ty,
} = {}) {
  const key = mprViewportPane(pane);
  if (!key) return null;
  const next = {
    zoom: Math.max(1, Math.min(8, Number(zoom) || 1)),
    tx: Number.isFinite(+tx) ? +tx : 0,
    ty: Number.isFinite(+ty) ? +ty : 0,
  };
  batch(() => {
    state.mpr.viewports ||= {};
    state.mpr.viewports[key] = next;
  });
  return { zoom: next.zoom, tx: next.tx, ty: next.ty };
}

export function resetMprViewport(pane) {
  return setMprViewport(pane, { zoom: 1, tx: 0, ty: 0 });
}

export function setObliqueAngles({ yaw = state.mpr.obYaw, pitch = state.mpr.obPitch } = {}) {
  batch(() => {
    state.mpr.obYaw = clampObliqueYaw(yaw);
    state.mpr.obPitch = clampObliquePitch(pitch);
  });
  return { obYaw: state.mpr.obYaw, obPitch: state.mpr.obPitch };
}

export function beginSeriesSelection(index, { preserveSlice = false } = {}) {
  const previousSeries = getCurrentSeries();
  const series = state.manifest.series[index];
  if (state.loaded || state.selectRequestId > 0) rememberSeriesViewState(previousSeries);
  const nextView = viewStateForSeries(series, { preserveSlice });
  let requestId = 0;
  batch(() => {
    requestId = ++state.selectRequestId;
    state.seriesIdx = index;
    if (!renderModeSupportedForSeries(state.three.renderMode, series)) state.three.renderMode = 'alpha';
    state.mode = nextView.mode;
    state.sliceIdx = nextView.sliceIdx;
    if (nextView.window != null) state.window = nextView.window;
    if (nextView.level != null) state.level = nextView.level;

    if (nextView.restored) {
      if (nextView.overlays) applyOverlayEnableSnapshot(state.overlays, nextView.overlays);
    }
    state.lockedLabels = new Set((nextView.lockedLabels || []).map(Number).filter(Number.isFinite));
    state.loaded = false;
    state.overlays.analysis = null;
    state.overlays.regionMeta = null;
    state.overlays.stats = null;
    state.overlays.fusionSlug = null;
    state.three.clipMin = [0, 0, 0];
    state.three.clipMax = [1, 1, 1];
    state.three.clipPlaneEnabled = false;
    state.three.clipPlaneDepth = 0.5;
    state.three.clipPlaneInvert = false;
  });
  setLastActiveSeries(series);
  return {
    requestId,
    series,
    sliceIdx: state.sliceIdx,
    mode: state.mode,
    restoredView: nextView.restored,
  };
}

export function isSeriesSelectionCurrent(requestId, seriesSlug) {
  return state.selectRequestId === requestId && currentSeriesSlug() === seriesSlug;
}

export function hydrateSeriesSidecars({ analysis, regionMeta, stats } = {}) {
  batch(() => {
    if (analysis) state.overlays.analysis = analysis;
    if (regionMeta) setRegionMeta(regionMeta);
    if (stats) setStats(stats);
  });
}

export function finishSeriesSelection() {
  batch(() => {
    state.loaded = true;
  });
}

export function setBrainStack({ nextUseBrain }) {
  batch(() => {
    state.overlays.useBrain = nextUseBrain;
    state.loaded = false;
  });
  return state.overlays.useBrain;
}
