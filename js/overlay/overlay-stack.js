import { state } from '../core/state.js';
import { loadImageStack, regionMetaUrlForSeries } from '../series/series-image-stack.js';
import { cachedFetchJson } from '../cached-fetch.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_TYPE } from '../runtime/overlay-cache-keys.js';
import { setOverlayStack } from '../runtime/viewer-runtime.js';
import { setRegionMeta } from '../core/state/viewer-commands.js';
import {
  DEFAULT_PREFETCH_LIMIT,
  OVERLAY_PREFETCH_CONCURRENCY,
  REMOTE_OVERLAY_PREFETCH_CONCURRENCY,
} from '../core/constants.js';

const REMOTE_WINDOW_RADIUS = 1;
const REMOTE_OVERLAY_PREFETCH_LIMIT = Infinity;

let _onReady = () => {};

export function initOverlayStack({ onReady = () => {} } = {}) {
  _onReady = onReady instanceof Function ? onReady : () => {};
}

export function notifyOverlayReady() {
  _onReady();
}

function ensureRegionMeta(cache, series, overlays) {
  if (!cache.needsRegionMeta || !overlays[cache.kind].available || state.overlays.regionMeta) return;
  const localMeta = state._localRegionMetaBySlug?.[series.slug];
  if (localMeta) {
    setRegionMeta(localMeta);
    return;
  }
  cachedFetchJson(regionMetaUrlForSeries(series))
    .then((d) => {
      if (d) setRegionMeta(d);
    })
    .catch(() => {});
}

export function ensureOverlayStack(type) {
  const cache = OVERLAY_CACHE_BY_TYPE[type];

  if (!cache || cache.refuseInOverlayStack) return Promise.resolve(false);
  const series = state.manifest.series[state.seriesIdx];
  const overlays = activeOverlayStateForSeries(series);
  if (!overlays[cache.kind]?.available) return Promise.resolve(false);
  const isRemote = !!series?.sliceUrlBase;
  const windowRadius = isRemote ? REMOTE_WINDOW_RADIUS : 5;
  const concurrency = isRemote ? REMOTE_OVERLAY_PREFETCH_CONCURRENCY : OVERLAY_PREFETCH_CONCURRENCY;

  const needVolume = state.mode === '3d' || state.mode === 'mpr3d' || state.mode === 'mpr';
  const prefetchLimit = (isRemote || needVolume) ? REMOTE_OVERLAY_PREFETCH_LIMIT : DEFAULT_PREFETCH_LIMIT;
  const prefetchConcurrency = needVolume && !isRemote ? 8 : concurrency;
  const currentIndex = state.sliceIdx;
  const dir = `${series.slug}_${type}`;
  const key = cache.imgs;
  const existing = state[key];
  if (
    existing &&
    existing.length === series.slices &&
    existing._dir === dir &&
    existing.ensureIndex
  ) {
    const currentReady = existing.ensureIndex?.(currentIndex) || Promise.resolve(true);
    currentReady.then(() => {
      if (state[key] === existing && state.sliceIdx === currentIndex) _onReady();
    });
    existing.ensureWindow?.(currentIndex, windowRadius);
    const prefetch = existing.prefetchRemaining?.(currentIndex, windowRadius, {
      concurrency: prefetchConcurrency,
      limit: prefetchLimit,
    }) || Promise.resolve([]);
    const prefetchToken = existing._prefetchToken;
    prefetch.then(() => {
      if (existing._prefetchToken !== prefetchToken) return;
      if (needVolume) _onReady();
    });
    ensureRegionMeta(cache, series, overlays);
    return currentReady;
  }
  const { imgs, loaders } = loadImageStack(dir, series.slices, existing, series, {
    label: `${series.slug} ${type} overlay`,
    windowRadius,
    initialIndex: currentIndex,
  });
  setOverlayStack(key, imgs);
  const currentReady = imgs.ensureIndex?.(currentIndex) || Promise.resolve(true);
  currentReady.then(() => {
    if (state[key] === imgs && state.sliceIdx === currentIndex) _onReady();
  });
  Promise.all(loaders).then(() => {
    if (state[key] === imgs) _onReady();
  });
  const prefetch = imgs.prefetchRemaining?.(currentIndex, windowRadius, {
    concurrency: prefetchConcurrency,
    limit: prefetchLimit,
  }) || Promise.resolve([]);
  const prefetchToken = imgs._prefetchToken;
  prefetch.then(() => {
    if (imgs._prefetchToken !== prefetchToken) return;
    if (needVolume) _onReady();
  });
  ensureRegionMeta(cache, series, overlays);
  return currentReady;
}
