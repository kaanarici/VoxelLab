import { state } from '../core/state.js';
import { createImageBitmapBatch } from '../image-bitmap-batch.js';
import { readImageByteData } from '../overlay/overlay-data.js';
import { ensureActiveOverlayVolumes } from '../overlay/overlay-volumes.js';
import { OVERLAY_CACHE_BY_TYPE } from '../runtime/overlay-cache-keys.js';
import { setVoxelCache } from '../runtime/viewer-runtime.js';
import { syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { touchLocalRawVolume } from '../local-raw-volume-cache.js';
import { seriesVariantKey } from '../core/series-identity.js';
import { stackHasLocalByteSlices } from '../series/local-byte-slice.js';
import { hasDenseLoadedImages, workerFlattenAvailable } from './volume-image-readiness.js';
import { flattenImageBitmapsInWorker } from './volume-worker-client.js';

let _renderVolumes = () => {};

function overlayVoxelPresence() {
  const presence = Object.create(null);
  for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
    presence[cache.voxels] = !!state[cache.voxels];
  }
  return presence;
}

function overlayVoxelsAppeared(before) {
  return Object.values(OVERLAY_CACHE_BY_TYPE).some(
    (cache) => !before[cache.voxels] && !!state[cache.voxels],
  );
}

const _pendingBuilds = new Map();

function currentVolumeVariant(series) {
  return state.overlays.useBrain && series?.hasBrain ? 'brain' : 'base';
}

export async function tryFlattenVoxelsInWorker() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return false;
  const variant = currentVolumeVariant(series);
  const key = seriesVariantKey(series, variant, state.manifest);
  if (state.voxels && state.voxelsKey === key) return true;

  const localRaw = !state.overlays.useBrain && state._localRawVolumes?.[series.slug];
  if (localRaw) {
    touchLocalRawVolume(series.slug);
    return false;
  }
  const sourceStack = state.imgs;
  if (stackHasLocalByteSlices(sourceStack, series.slices)) return false;

  if (!workerFlattenAvailable()) return false;
  const W = series.width, H = series.height, D = series.slices;
  if (!hasDenseLoadedImages(sourceStack, D)) return false;
  const requestId = state.selectRequestId;
  const viewerSession = state.viewerSession;

  const inflight = _pendingBuilds.get(key);
  if (
    inflight?.sourceStack === sourceStack
    && inflight.requestId === requestId
    && inflight.viewerSession === viewerSession
  ) {
    try { await inflight.promise; } catch {                    }
    return state.voxels && state.voxelsKey === key;
  }

  const sourceImgs = sourceStack.slice(0, D);
  const build = (async () => {
    let bitmaps;
    try {
      bitmaps = await createImageBitmapBatch(sourceImgs);
    } catch (err) {
      console.warn('voxellab tryFlattenVoxelsInWorker: createImageBitmap failed', err);
      return null;
    }
    try {
      return await flattenImageBitmapsInWorker({ bitmaps, w: W, h: H, d: D });
    } catch (err) {
      console.warn('voxellab tryFlattenVoxelsInWorker: worker rejected', err);

      for (const bmp of bitmaps) bmp?.close?.();
      return null;
    }
  })();
  const pending = { sourceStack, requestId, viewerSession, promise: build };
  _pendingBuilds.set(key, pending);
  let bytes = null;
  try {
    bytes = await build;
  } finally {
    if (_pendingBuilds.get(key) === pending) _pendingBuilds.delete(key);
  }
  if (!bytes) return false;
  const activeSeries = state.manifest?.series?.[state.seriesIdx];
  const stillCurrent = state.selectRequestId === requestId
    && state.viewerSession === viewerSession
    && state.viewerSession?.requestId === requestId
    && seriesVariantKey(activeSeries, currentVolumeVariant(activeSeries), state.manifest) === key
    && state.imgs === sourceStack;
  if (!stillCurrent) return false;
  setVoxelCache(bytes, key);
  const hadOverlayVoxels = overlayVoxelPresence();
  ensureActiveOverlayVolumes();
  syncViewerRuntimeSession(series);
  if (overlayVoxelsAppeared(hadOverlayVoxels)) _renderVolumes();
  return true;
}

export function initEnsureVoxels(deps) {
  _renderVolumes = deps.renderVolumes;
}

export function ensureVoxels() {
  const series = state.manifest.series[state.seriesIdx];
  const variant = currentVolumeVariant(series);
  const key = seriesVariantKey(series, variant, state.manifest);
  if (state.voxels && state.voxelsKey === key) {
    ensureActiveOverlayVolumes();
    return true;
  }
  if (_pendingBuilds.has(key)) return false;

  const W = series.width, H = series.height, D = series.slices;
  const voxels = new Uint8Array(W * H * D);
  const localRaw = !state.overlays.useBrain && state._localRawVolumes?.[series.slug];
  if (localRaw && localRaw.length === voxels.length) {
    touchLocalRawVolume(series.slug);
    for (let i = 0; i < localRaw.length; i++) voxels[i] = Math.max(0, Math.min(255, Math.round(localRaw[i] * 255)));
  } else {
    if (!hasDenseLoadedImages(state.imgs, D)) return false;
    for (let z = 0; z < D; z++) {
      const bytes = readImageByteData(state.imgs[z], W, H);
      if (!bytes) return false;
      voxels.set(bytes, z * W * H);
    }
  }
  setVoxelCache(voxels, key);
  const hadOverlayVoxels = overlayVoxelPresence();
  ensureActiveOverlayVolumes();
  syncViewerRuntimeSession(series);
  if (overlayVoxelsAppeared(hadOverlayVoxels)) _renderVolumes();
  return true;
}
