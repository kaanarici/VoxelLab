import { seriesPersistenceKey, seriesVariantKey } from '../core/series-identity.js';
import { batch, deletePassthroughRootEntry, setPassthroughRootEntry, state } from '../core/state.js';
import { patchManifestSeries, setColormap, setInvertDisplay, setSliceIndex, setWindowLevel } from '../core/state/viewer-commands.js';
import { overlayImgsResetValue } from '../core/viewer-session-shape.js';
import { OVERLAY_CACHE_BY_TYPE, overlayVoxelsKey } from './overlay-cache-keys.js';
import { clearSeriesOverlayHints } from './overlay-kinds.js';
import { resetViewerRuntimeSession } from './viewer-session.js';

const WARM_VOLUME_CACHE_MAX_BYTES = 256 * 1024 * 1024;

function volumeEntryByteLength(entry) {
  const values = new Set([
    entry?.voxels,
    entry?.hrVoxels,
    ...Object.values(OVERLAY_CACHE_BY_TYPE).map((cache) => entry?.[cache.voxels]),
  ].filter(Boolean));
  return [...values].reduce((bytes, value) => bytes + (Number(value?.byteLength) || 0), 0);
}

function currentSeries() {
  return state.manifest?.series?.[state.seriesIdx] || null;
}

function volumeVariant(series = currentSeries(), useBrain = state.overlays.useBrain) {
  return useBrain && series?.hasBrain ? 'brain' : 'base';
}

function volumeEntryKey(series = currentSeries(), variant = volumeVariant(series)) {
  return seriesVariantKey(series, variant, state.manifest);
}

export function getThreeRuntime() {
  return state.threeRuntime;
}

export function resetThreeRuntimeSession() {
  batch(() => {
    state.threeRuntime.seriesIdx = -1;
    state.threeRuntime.variant = '';
    state.threeRuntime.dataKey = '';
    state.threeRuntime.previewShown = false;
  });
}

export function setThreeRuntimeShell({ renderer, scene, camera, controls, startLoop }) {
  batch(() => {
    state.threeRuntime.renderer = renderer;
    state.threeRuntime.scene = scene;
    state.threeRuntime.camera = camera;
    state.threeRuntime.controls = controls;
    state.threeRuntime.startLoop = startLoop;
    state.threeRuntime.stopLoop = null;
    state.threeRuntime.requestRender = null;
    state.threeRuntime.renderNow = null;
    state.threeRuntime.mesh = null;
  });
}

export function setThreeRuntimeRenderFns({ startLoop = null, stopLoop = null, requestRender = null, renderNow = null } = {}) {
  batch(() => {
    state.threeRuntime.startLoop = startLoop;
    state.threeRuntime.stopLoop = stopLoop;
    state.threeRuntime.requestRender = requestRender;
    state.threeRuntime.renderNow = renderNow;
  });
}

export function setThreeRuntimeMesh(mesh, { seriesIdx, variant, dataKey }) {
  batch(() => {
    state.threeRuntime.mesh = mesh;
    state.threeRuntime.seriesIdx = seriesIdx;
    state.threeRuntime.variant = variant;
    state.threeRuntime.dataKey = dataKey;
  });
}

export function setThreePreviewShown(shown) {
  state.threeRuntime.previewShown = !!shown;
}

export function setOverlayStack(key, imgs) {
  if (!key) return null;
  state[key] = imgs;
  return state[key];
}

export function clearRuntimeSelectionCaches({ resetViewerSessionState = true } = {}) {
  batch(() => {
    state.voxels = null;
    state.voxelsKey = '';
    state.hrVoxels = null;
    state.hrKey = '';
    state.hrLoading = null;
    state.hrLoadingKey = '';
    state.hrAbortController = null;
    for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
      state[cache.imgs] = overlayImgsResetValue(cache);
      state[cache.voxels] = null;
    }
  });
  resetThreeRuntimeSession();
  if (resetViewerSessionState) resetViewerRuntimeSession();
}

export function stashRuntimeVolumeCache(series = currentSeries(), {
  variant = volumeVariant(series),
  maxBytes = WARM_VOLUME_CACHE_MAX_BYTES,
} = {}) {
  if (!series) return false;
  const key = volumeEntryKey(series, variant);
  if (!key) return false;
  if (
    !state.voxels
    && !state.hrVoxels
    && !Object.values(OVERLAY_CACHE_BY_TYPE).some((cache) => state[cache.voxels])
  ) {
    return false;
  }

  const overlayVoxels = {};
  const peerSlugs = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
    overlayVoxels[cache.voxels] = state[cache.voxels] || null;
    if (cache.peerSlugField) peerSlugs[cache.peerSlugField] = state.overlays[cache.peerSlugField] || '';
  }
  const entry = {
    key,
    slug: series.slug,
    variant,
    voxels: state.hrVoxels ? null : state.voxels,
    hrVoxels: state.hrVoxels || null,
    ...overlayVoxels,
    ...peerSlugs,
    byteLength: 0,
  };
  entry.byteLength = volumeEntryByteLength(entry);
  batch(() => {
    const next = (state._seriesVolumeCacheEntries || []).filter((item) => item?.key !== key);
    next.unshift(entry);
    let retainedBytes = 0;
    state._seriesVolumeCacheEntries = next.filter((item) => {
      const itemBytes = volumeEntryByteLength(item);
      if (itemBytes > maxBytes || retainedBytes + itemBytes > maxBytes) return false;
      retainedBytes += itemBytes;
      return true;
    });
  });
  return true;
}

export function restoreRuntimeVolumeCache(series = currentSeries(), { variant = volumeVariant(series) } = {}) {
  if (!series) return false;
  const key = volumeEntryKey(series, variant);
  const entries = state._seriesVolumeCacheEntries || [];
  const index = entries.findIndex((item) => item?.key === key);
  if (index < 0) return false;
  const entry = entries[index];
  batch(() => {
    if (index > 0) {
      const next = entries.slice();
      next.splice(index, 1);
      next.unshift(entry);
      state._seriesVolumeCacheEntries = next;
    }
    state.voxels = entry.voxels || null;
    state.voxelsKey = entry.voxels ? key : '';
    state.hrVoxels = entry.hrVoxels || null;
    state.hrKey = entry.hrVoxels ? `${state.seriesIdx}:${series.slug}:${series.rawUrl || ''}` : '';
    for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
      if (cache.peerSlugField) {
        const slug = entry[cache.peerSlugField];
        state[cache.voxels] = slug && slug === state.overlays[cache.peerSlugField]
          ? (entry[cache.voxels] || null)
          : null;
        continue;
      }
      state[cache.voxels] = entry[cache.voxels] || null;
    }
  });
  return true;
}

export function setVoxelCache(voxels, key) {
  batch(() => {
    state.voxels = voxels;
    state.voxelsKey = key;
  });
}

export function invalidateVoxelCache({ dropData = false } = {}) {
  batch(() => {
    state.voxelsKey = '';
    if (dropData) state.voxels = null;
  });
}

export function clearFusionRuntime() {
  const cache = OVERLAY_CACHE_BY_TYPE.fusion;
  batch(() => {
    setOverlayStack(cache.imgs, null);
    setOverlayVoxels(cache.type, null);
  });
}

export function setFusionRuntime({ imgs, voxels } = {}) {
  const cache = OVERLAY_CACHE_BY_TYPE.fusion;
  const nextImgs = imgs !== undefined ? imgs : state[cache.imgs];
  const nextVoxels = voxels !== undefined ? voxels : state[cache.voxels];
  batch(() => {
    setOverlayStack(cache.imgs, nextImgs);
    setOverlayVoxels(cache.type, nextVoxels);
  });
}

export function setOverlayVoxels(type, voxels) {
  const key = overlayVoxelsKey(type);
  if (!key) return null;
  state[key] = voxels;
  return state[key];
}

export function setHrLoadingState({ key = '', controller = null, promise = null } = {}) {
  batch(() => {
    state.hrLoadingKey = key;
    state.hrAbortController = controller;
    state.hrLoading = promise;
  });
}

export function clearHrLoadingState(key = '') {
  batch(() => {
    if (!key || state.hrLoadingKey === key) {
      state.hrLoading = null;
      state.hrLoadingKey = '';
    }
    if (!key || !state.hrLoadingKey) state.hrAbortController = null;
  });
}

export function setHrVoxelCache(voxels, key) {
  batch(() => {
    state.hrVoxels = voxels;
    state.hrKey = key;
  });
}

export function transitionVolumeCaches(previousSeries, mutate, {
  resetViewerSessionState = true,
} = {}) {
  stashRuntimeVolumeCache(previousSeries, { variant: volumeVariant(previousSeries) });
  const result = mutate();
  const nextSeries = currentSeries();
  clearRuntimeSelectionCaches({ resetViewerSessionState });
  restoreRuntimeVolumeCache(nextSeries, { variant: volumeVariant(nextSeries) });
  return result;
}

const LOCAL_SERIES_MAPS = [
  '_localStacks',
  '_localMicroscopyStacks',
  '_localMicroscopyPlanes',
  '_localRegionMetaBySlug',
  '_localRegionLabelSlicesBySlug',
  '_localDerivedObjects',
  '_localRtDoseBySlug',
];
const LOCAL_ANALYSIS_MAPS = [
  '_microscopyAnalysisLog',
  '_microscopyAnalysisResults',
];

export function getLocalRuntimeMap(mapKey) {
  return state[mapKey];
}

export function setLocalRuntimeMapEntry(mapKey, entryKey, value) {
  if (!LOCAL_SERIES_MAPS.includes(mapKey) && !LOCAL_ANALYSIS_MAPS.includes(mapKey) && mapKey !== '_localRawVolumes') {
    throw new Error(`Unknown local runtime map: ${mapKey}`);
  }
  const key = String(entryKey || '');
  if (!key) return false;
  if (value === undefined) return deletePassthroughRootEntry(mapKey, key);
  if (!state[mapKey] || Object.getPrototypeOf(state[mapKey]) !== Object.prototype) state[mapKey] = {};
  return setPassthroughRootEntry(mapKey, key, value);
}

export function deleteLocalRuntimeMapEntry(mapKey, entryKey) {
  return setLocalRuntimeMapEntry(mapKey, entryKey, undefined);
}

export function ensureLocalDerivedBucket(slug) {
  const key = String(slug || '');
  if (!key) return {};
  const current = state._localDerivedObjects?.[key];
  if (current && Object.getPrototypeOf(current) === Object.prototype) return current;
  setLocalRuntimeMapEntry('_localDerivedObjects', key, {});
  return state._localDerivedObjects[key];
}

export function replaceLocalDerivedBucket(slug, next = {}) {
  const key = String(slug || '');
  if (!key) return {};
  const value = next && Object.getPrototypeOf(next) === Object.prototype ? next : {};
  setLocalRuntimeMapEntry('_localDerivedObjects', key, value);
  return state._localDerivedObjects[key];
}

export function setLocalDerivedObject(slug, objectUID, value) {
  const uid = String(objectUID || '');
  if (!uid) return null;
  const bucket = { ...ensureLocalDerivedBucket(slug) };
  if (value === undefined) delete bucket[uid];
  else bucket[uid] = value;
  return replaceLocalDerivedBucket(slug, bucket);
}

export function appendLocalRtDose(slug, entry) {
  const key = String(slug || '');
  if (!key || !entry) return [];
  const current = Array.isArray(state._localRtDoseBySlug?.[key]) ? state._localRtDoseBySlug[key] : [];
  const next = current.concat(entry);
  setLocalRuntimeMapEntry('_localRtDoseBySlug', key, next);
  return next;
}

export function getPendingDerivedObjects() {
  return Array.isArray(state._pendingDerivedObjects) ? state._pendingDerivedObjects : [];
}

export function setPendingDerivedObjects(list) {
  state._pendingDerivedObjects = Array.isArray(list) ? list : [];
  return state._pendingDerivedObjects;
}

export function getLocalRawVolumeOrder() {
  if (!Array.isArray(state._localRawVolumeOrder)) state._localRawVolumeOrder = [];
  return state._localRawVolumeOrder;
}

export function setLocalRawVolumeOrder(order) {
  state._localRawVolumeOrder = Array.isArray(order) ? order : [];
  return state._localRawVolumeOrder;
}

export function setSeriesImageStacks(payload = {}) {
  const { imgs, cmpStacks } = payload;
  batch(() => {
    if (imgs !== undefined) state.imgs = imgs;
    for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
      if (payload[cache.imgs] !== undefined) setOverlayStack(cache.imgs, payload[cache.imgs]);
    }
    if (cmpStacks !== undefined) state.cmpStacks = cmpStacks;
  });
}

export function clearRuntimeImageStacks() {
  setSeriesImageStacks({ imgs: [], cmpStacks: {} });
}

export function forgetLocalSeriesRuntime(series, manifest) {
  const slug = series?.slug;
  if (!slug) return;
  batch(() => {
    for (const key of LOCAL_SERIES_MAPS) {
      deletePassthroughRootEntry(key, slug);
    }
    deletePassthroughRootEntry('_localStacks', `${slug}_regions`);
    const analysisKey = seriesPersistenceKey(series, manifest);
    if (analysisKey) {
      deletePassthroughRootEntry('_microscopyAnalysisLog', analysisKey);
      deletePassthroughRootEntry('_microscopyAnalysisResults', analysisKey);
    }
    clearSeriesOverlayHints(series);
  });
}

export function dropRuntimeVolumeCachesForSlugs(slugs) {
  const requested = slugs instanceof Set ? slugs : new Set(slugs);
  state._seriesVolumeCacheEntries = (state._seriesVolumeCacheEntries || [])
    .filter((entry) => !requested.has(entry?.slug));
}

const LOCAL_MAP_KEYS = [...LOCAL_SERIES_MAPS, ...LOCAL_ANALYSIS_MAPS, '_localRawVolumes'];

function assertLocalMapKey(mapKey) {
  if (!LOCAL_MAP_KEYS.includes(mapKey)) throw new Error(`Unknown local runtime map: ${mapKey}`);
}

export function isLiveViewerHost(host) {
  return host === state;
}

export function replaceLocalRuntimeMap(mapKey, next = {}) {
  assertLocalMapKey(mapKey);
  const value = next && Object.getPrototypeOf(next) === Object.prototype ? next : {};
  batch(() => { state[mapKey] = value; });
  return state[mapKey];
}

export const LIVE_HOST_WRITES = {
  patchSeries(_host, series, patch) {
    return patchManifestSeries(series, patch);
  },
  sliceIndex(_host, sliceIdx, series) {
    return setSliceIndex(sliceIdx, series);
  },
  invertDisplay(_host, enabled) {
    return setInvertDisplay(enabled);
  },
  windowLevel(_host, windowValue, levelValue) {
    return setWindowLevel(windowValue, levelValue);
  },
  colormap(_host, name) {
    return setColormap(name);
  },
  displayStack(_host, slug, stack, sliceIdx) {
    const images = Array.isArray(stack) ? stack : [];
    const max = Math.max(0, images.length - 1);
    const nextSlice = Math.max(0, Math.min(Math.floor(Number(sliceIdx) || 0), max));
    if (slug) setLocalRuntimeMapEntry('_localStacks', slug, images);
    setSeriesImageStacks({ imgs: images });
    setSliceIndex(nextSlice);
    return true;
  },
  runtimeMapEntry(_host, mapKey, entryKey, value) {
    return setLocalRuntimeMapEntry(mapKey, entryKey, value);
  },
  replaceRuntimeMap(_host, mapKey, next) {
    return replaceLocalRuntimeMap(mapKey, next);
  },
};

export function hostWritesFor(host, writes) {
  if (isLiveViewerHost(host)) return LIVE_HOST_WRITES;
  if (writes) return writes;
  return null;
}

