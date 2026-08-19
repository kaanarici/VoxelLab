// Shared overlay-volume extraction for MPR / 3D label paths.

import { state } from '../core/state.js';
import { createImageBitmapBatch } from '../image-bitmap-batch.js';
import { flattenImageBitmapsInWorker } from '../volume/volume-worker-client.js';
import { hasDenseLoadedImages, workerFlattenAvailable } from '../volume/volume-image-readiness.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_KIND, OVERLAY_CACHE_BY_TYPE, overlayImgsKey, overlayVoxelsKey } from '../runtime/overlay-cache-keys.js';
import { syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { seriesIdentityKey } from '../core/series-identity.js';
import { setOverlayVoxels } from '../runtime/viewer-runtime.js';
import { readImageByteData } from './overlay-data.js';

const _pending = new Map();
let _onReady = () => {};

function stackForType(type) {
  const key = overlayImgsKey(type);
  return key ? state[key] : null;
}

function localRegionVolume(series, W, H, D) {
  const slices = state._localRegionLabelSlicesBySlug?.[series.slug];
  if (!Array.isArray(slices) || slices.length !== D) return null;
  const voxels = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z++) {
    const slice = slices[z];
    if (!slice || slice.length !== W * H) return null;
    voxels.set(slice, z * W * H);
  }
  return voxels;
}

export function initOverlayVolumes({ onReady = () => {} } = {}) {
  _onReady = onReady;
}

async function buildVolumeFromWorker(type, seriesKey, imgs, W, H, D, requestId, viewerSession) {
  const key = `${seriesKey}|${type}|${W}x${H}x${D}`;
  const inflight = _pending.get(key);
  if (
    inflight?.sourceStack === imgs
    && inflight.requestId === requestId
    && inflight.viewerSession === viewerSession
  ) return inflight.promise;
  const pending = { sourceStack: imgs, requestId, viewerSession, promise: null };
  pending.promise = (async () => {
    let bitmaps = null;
    try {
      bitmaps = await createImageBitmapBatch(imgs.slice(0, D));
      const voxels = await flattenImageBitmapsInWorker({ bitmaps, w: W, h: H, d: D });
      imgs._voxels = voxels;
      return voxels;
    } catch (err) {
      console.warn(`voxellab overlay-volumes: worker flatten failed for ${type}`, err);
      return null;
    } finally {
      for (const bitmap of bitmaps || []) bitmap?.close?.();
      if (_pending.get(key) === pending) _pending.delete(key);
    }
  })();
  _pending.set(key, pending);
  return pending.promise;
}

function buildVolumeFromStack(type, series, W, H, D) {
  const cache = OVERLAY_CACHE_BY_TYPE[type];
  if (cache?.usesLocalRegionVolume) {
    const local = localRegionVolume(series, W, H, D);
    if (local) return local;
  }

  const imgs = stackForType(type);
  if (!hasDenseLoadedImages(imgs, D)) {
    return null;
  }
  if (imgs._voxels?.length === W * H * D) return imgs._voxels;
  if (workerFlattenAvailable()) {
    const seriesKey = seriesIdentityKey(series, state.manifest);
    const requestId = state.selectRequestId;
    const viewerSession = state.viewerSession;
    buildVolumeFromWorker(type, seriesKey, imgs, W, H, D, requestId, viewerSession).then((voxels) => {
      if (!voxels) return;
      const activeSeries = state.manifest?.series?.[state.seriesIdx];
      if (
        state.selectRequestId !== requestId
        || state.viewerSession !== viewerSession
        || state.viewerSession?.requestId !== requestId
        || seriesIdentityKey(activeSeries, state.manifest) !== seriesKey
        || stackForType(type) !== imgs
      ) return;
      if (!overlayVoxelsKey(type)) return;
      setOverlayVoxels(type, voxels);
      syncViewerRuntimeSession(activeSeries);
      _onReady(type);
    });
    return null;
  }

  const voxels = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z++) {
    const data = readImageByteData(imgs[z], W, H);
    if (!data) return null;
    voxels.set(data, z * W * H);
  }
  imgs._voxels = voxels;
  return voxels;
}

/**
 * Synchronously return the full region label volume for a series, building it
 * from the local label slices or the decoded region image stack when the
 * labels voxel slot is not yet cached. Used by mesh export, which needs the
 * complete 3D mask regardless of whether the colour overlay is enabled. Returns
 * null when the source slices are not all decoded yet.
 */
export function ensureRegionVoxelsSync(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series) return null;
  const cache = OVERLAY_CACHE_BY_KIND.labels;
  const W = series.width;
  const H = series.height;
  const D = series.slices;
  const cached = state[cache.voxels];
  if (cached?.length === W * H * D) return cached;
  const local = localRegionVolume(series, W, H, D);
  if (local) return local;
  const imgs = state[cache.imgs];
  if (!hasDenseLoadedImages(imgs, D)) return null;
  if (imgs._voxels?.length === W * H * D) return imgs._voxels;
  const voxels = new Uint8Array(W * H * D);
  for (let z = 0; z < D; z += 1) {
    const data = readImageByteData(imgs[z], W, H);
    if (!data) return null;
    voxels.set(data, z * W * H);
  }
  imgs._voxels = voxels;
  return voxels;
}

/** Ensure the currently-active overlay stacks have cached 3D byte volumes when possible. */
export function ensureActiveOverlayVolumes() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return;
  const overlays = activeOverlayStateForSeries(series);
  const W = series.width;
  const H = series.height;
  const D = series.slices;

  for (const [type, entry] of Object.entries(OVERLAY_CACHE_BY_TYPE)) {
    const stateKey = entry.voxels;
    if (!stateKey) continue;
    const current = state[stateKey];
    // Disable is a paint flag. Evicting voxels here would break mesh export
    // and any other consumer that needs the cached mask while the overlay is off.
    if (!overlays[entry.kind]?.enabled) continue;
    const built = buildVolumeFromStack(type, series, W, H, D);
    if (!built || current === built || current?.length === built.length) continue;
    setOverlayVoxels(type, built);
  }
  syncViewerRuntimeSession(series);
}
