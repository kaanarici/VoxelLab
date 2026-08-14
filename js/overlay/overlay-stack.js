// Lazy-load overlay PNG stacks (seg / sym / regions) for the current series.
import { state } from '../core/state.js';
import { renderVolumeTable } from '../metadata.js';
import { loadImageStack, regionMetaUrlForSeries } from '../series/series-image-stack.js';
import { cachedFetchJson } from '../core/cached-fetch.js';
import { syncOverlays } from '../sync.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { invalidateVoxelCache, setOverlayStack } from '../runtime/viewer-runtime.js';
import { setRegionMeta } from '../core/state/viewer-commands.js';
import {
  DEFAULT_PREFETCH_LIMIT,
  OVERLAY_PREFETCH_CONCURRENCY,
  REMOTE_OVERLAY_PREFETCH_CONCURRENCY,
} from '../core/constants.js';

let _is3dActive = () => false;
let _ensureVoxels = () => false;
let _updateLabelTexture = () => {};

const IMG_KEY = { seg: 'segImgs', sym: 'symImgs', regions: 'regionImgs' };
const REMOTE_WINDOW_RADIUS = 1;
const REMOTE_OVERLAY_PREFETCH_LIMIT = Infinity;

export function initOverlayStack(h) {
  if (typeof h.is3dActive === 'function') _is3dActive = h.is3dActive;
  if (typeof h.ensureVoxels === 'function') _ensureVoxels = h.ensureVoxels;
  if (typeof h.updateLabelTexture === 'function') _updateLabelTexture = h.updateLabelTexture;
}

function ensureRegionMeta(type, series, overlays) {
  if (type !== 'regions' || !overlays.labels.available || state.regionMeta) return;
  const localMeta = state._localRegionMetaBySlug?.[series.slug];
  if (localMeta) {
    setRegionMeta(localMeta);
    renderVolumeTable();
    return;
  }
  cachedFetchJson(regionMetaUrlForSeries(series))
    .then((d) => {
      if (d) {
        setRegionMeta(d);
        renderVolumeTable();
      }
    })
    .catch(() => {});
}

export function ensureOverlayStack(type) {
  const series = state.manifest.series[state.seriesIdx];
  const overlays = activeOverlayStateForSeries(series);
  const canonicalKind = { seg: 'tissue', regions: 'labels', sym: 'heatmap' }[type];
  if (canonicalKind && !overlays[canonicalKind]?.available) return Promise.resolve(false);
  const isRemote = !!series?.sliceUrlBase;
  const windowRadius = isRemote ? REMOTE_WINDOW_RADIUS : 5;
  const concurrency = isRemote ? REMOTE_OVERLAY_PREFETCH_CONCURRENCY : OVERLAY_PREFETCH_CONCURRENCY;
  // 3D / MPR render the full dense volume, which can't build until EVERY overlay
  // slice is decoded (hasDenseLoadedImages). For 2D only the current slice is
  // needed, so prefetch caps at DEFAULT_PREFETCH_LIMIT. Without lifting that cap
  // in volume modes, the 3D overlay only colors after many toggles / ~a minute,
  // even though labels (current-slice only) appear instantly. So when a volume
  // mode is active, load the whole stack aggressively.
  const needVolume = state.mode === '3d' || state.mode === 'mpr3d' || state.mode === 'mpr';
  const prefetchLimit = (isRemote || needVolume) ? REMOTE_OVERLAY_PREFETCH_LIMIT : DEFAULT_PREFETCH_LIMIT;
  const prefetchConcurrency = needVolume && !isRemote ? 8 : concurrency;
  const currentIndex = state.sliceIdx;
  const dir = `${series.slug}_${type}`;
  const key = IMG_KEY[type];
  const existing = state[key];
  if (
    existing &&
    existing.length === series.slices &&
    existing._dir === dir &&
    existing.ensureIndex
  ) {
    const currentReady = existing.ensureIndex?.(currentIndex) || Promise.resolve(true);
    currentReady.then(() => {
      if (state[key] === existing && state.sliceIdx === currentIndex) syncOverlays();
    });
    existing.ensureWindow?.(currentIndex, windowRadius);
    existing.prefetchRemaining?.(currentIndex, windowRadius, {
      concurrency: prefetchConcurrency,
      limit: prefetchLimit,
    }).then(() => {
      if (_is3dActive()) {
        invalidateVoxelCache();
        if (_ensureVoxels()) void _updateLabelTexture();
      } else if (needVolume) {
        // MPR: rebuild the overlay volume + redraw once the full stack is in.
        invalidateVoxelCache();
        syncOverlays();
      }
    });
    ensureRegionMeta(type, series, overlays);
    return currentReady;
  }
  const { imgs, loaders } = loadImageStack(dir, series.slices, existing, series, {
    label: `${series.slug} ${type} overlay`,
    windowRadius,
    initialIndex: currentIndex,
  });
  setOverlayStack(type, imgs);
  const currentReady = imgs.ensureIndex?.(currentIndex) || Promise.resolve(true);
  currentReady.then(() => {
    if (state[key] === imgs && state.sliceIdx === currentIndex) syncOverlays();
  });
  Promise.all(loaders).then(() => {
    if (state[key] === imgs) syncOverlays();
  });
  imgs.prefetchRemaining?.(currentIndex, windowRadius, {
    concurrency: prefetchConcurrency,
    limit: prefetchLimit,
  }).then(() => {
    if (_is3dActive()) {
      invalidateVoxelCache();
      if (_ensureVoxels()) void _updateLabelTexture();
    } else if (needVolume) {
      invalidateVoxelCache();
      syncOverlays();
    }
  });
  ensureRegionMeta(type, series, overlays);
  return currentReady;
}
