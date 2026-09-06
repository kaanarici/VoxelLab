import { state } from '../core/state.js';
import { HAS_LOCAL_BACKEND } from '../core/local-backend.js';
import { cachedFetchResponse } from '../cached-fetch.js';
import { BASE_PREFETCH_CONCURRENCY, DEFAULT_PREFETCH_LIMIT, REMOTE_BASE_PREFETCH_CONCURRENCY } from '../core/constants.js';
import { notify } from '../notify.js';

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function useLocalAssetProxy(url) {
  try {
    if (!globalThis.location) return false;
    const parsed = new URL(url, globalThis.location.href);
    return HAS_LOCAL_BACKEND && parsed.origin !== globalThis.location.origin;
  } catch {
    return false;
  }
}

export function assetUrlForBrowser(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (!/^https?:$/i.test(parsed.protocol)) return url;
    return useLocalAssetProxy(parsed.href)
      ? `/api/proxy-asset?url=${encodeURIComponent(parsed.href)}`
      : parsed.href;
  } catch {
    return url;
  }
}

function shouldUseAnonymousCors(url) {
  try {
    if (!globalThis.location) return /^https?:\/\//i.test(url);
    return new URL(url, globalThis.location.href).origin !== globalThis.location.origin;
  } catch {
    return /^https?:\/\//i.test(url);
  }
}

function httpUrlForImage(url) {
  try {
    const resolved = new URL(url, globalThis.location?.href || 'http://localhost/');
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveImageSrc(url, priority) {
  const resolved = httpUrlForImage(url);
  if (resolved?.pathname !== '/api/proxy-asset') {
    return { src: url, release: null };
  }
  const response = await cachedFetchResponse(url, priority ? { priority } : undefined);
  if (!response.ok) throw new Error(`Image request failed: ${url}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  return { src: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}

function loadFreshImage(img, url, label, index, errorMode, priority, onFail) {
  return wrapLoader((async () => {

    if (priority === 'high' && 'fetchPriority' in img) {
      img.fetchPriority = 'high';
    }
    const { src, release } = await resolveImageSrc(url, priority);
    try {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(true);
        img.onerror = () => reject(new Error(`Image ${index + 1} failed: ${url}`));
        if (src === url && shouldUseAnonymousCors(url)) img.crossOrigin = 'anonymous';
        img.src = src;
      });
      return true;
    } finally {
      img.onload = null;
      img.onerror = null;
      release?.();
    }
  })(), label, index, errorMode, onFail);
}

export function imageUrlForStack(dir, index, series = state.manifest?.series?.[state.seriesIdx]) {
  const file = `${String(index).padStart(4, '0')}.png`;
  if (!series) return `./data/${dir}/${file}`;

  if (dir === series.slug && series.sliceUrlBase) {
    return assetUrlForBrowser(`${trimSlash(series.sliceUrlBase)}/${file}`);
  }

  const overlayBase = series.overlayUrlBases?.[dir];
  if (overlayBase) return assetUrlForBrowser(`${trimSlash(overlayBase)}/${file}`);

  if (dir === `${series.slug}_regions` && series.regionUrlBase) {
    return assetUrlForBrowser(`${trimSlash(series.regionUrlBase)}/${file}`);
  }

  return `./data/${dir}/${file}`;
}

export function regionMetaUrlForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series?.slug) return '';

  if (series.regionMetaUrl) return assetUrlForBrowser(series.regionMetaUrl);

  return `./data/${series.slug}_regions.json`;
}

export function statsUrlForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series?.slug) return '';
  if (series.statsUrl) return assetUrlForBrowser(series.statsUrl);
  return `./data/${series.slug}_stats.json`;
}

export function rawVolumeUrlForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series?.slug) return '';
  if (series.rawUrl) return assetUrlForBrowser(series.rawUrl);
  return `./data/${series.slug}.raw`;
}

function imageSlotFailed(img) {
  return !!(img?.complete && img.naturalWidth === 0);
}

function loadExistingImage(img, label, index, errorMode, onFail) {
  return wrapLoader(new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) resolve(true);
    else if (img.complete && img.naturalWidth === 0) reject(new Error(`Image ${index + 1} failed: ${img.src}`));
    else {
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error(`Image ${index + 1} failed: ${img.src}`));
    }
  }), label, index, errorMode, onFail);
}

function prefetchConcurrency(value) {
  const requested = Math.trunc(Number(value));
  const limit = requested >= 1 ? requested : BASE_PREFETCH_CONCURRENCY;
  return Math.min(limit, REMOTE_BASE_PREFETCH_CONCURRENCY);
}

function attachStackControls(imgs, dir, count, series, label, errorMode) {
  imgs._dir = dir;
  imgs._pending = imgs._pending || new Map();
  imgs._failed = imgs._failed || new Set();
  imgs._prefetchToken = imgs._prefetchToken || 0;
  const markFailed = (index) => imgs._failed.add(index);
  imgs.ensureIndex = (index, opts) => {
    if (index < 0 || index >= count) return Promise.resolve(true);
    const pending = imgs._pending.get(index);
    if (pending) return pending;
    const existing = imgs[index];
    const failed = imageSlotFailed(existing) || imgs._failed.has(index);
    if (failed && !opts?.retry) return Promise.resolve(null);
    if (existing && !imageSlotFailed(existing)) {
      return loadExistingImage(existing, label, index, errorMode, markFailed);
    }
    if (failed && opts?.retry) {
      imgs._failed.delete(index);
      allowStackUnavailableNotify(label);
    }
    const img = new Image();
    img.alt = '';
    imgs[index] = img;
    const loader = loadFreshImage(
      img,
      imageUrlForStack(dir, index, series),
      label,
      index,
      errorMode,
      opts?.priority,
      markFailed,
    );
    imgs._pending.set(index, loader);
    loader.finally(() => imgs._pending.delete(index));
    return loader;
  };
  imgs.ensureWindow = (center, radius = 0) => Promise.all(
    Array.from({ length: radius * 2 + 1 }, (_, offset) => center - radius + offset)
      .filter(index => index >= 0 && index < count)
      .map(index => imgs.ensureIndex(index)),
  );
  imgs.prefetchRemaining = (
    center = 0,
    radius = 0,
    { concurrency = BASE_PREFETCH_CONCURRENCY, limit = DEFAULT_PREFETCH_LIMIT } = {},
  ) => {
    const indexes = [];
    const addIndex = (index) => {
      if (index < 0 || index >= count) return;
      if (index >= center - radius && index <= center + radius) return;
      if (imgs[index]?.complete && imgs[index].naturalWidth > 0) return;
      if (imageSlotFailed(imgs[index]) || imgs._failed.has(index)) return;
      indexes.push(index);
    };
    if (Number.isFinite(limit)) {
      const max = Math.max(0, Math.trunc(limit));
      const maxDistance = Math.max(Math.abs(center), Math.abs(count - 1 - center)) + radius + 1;
      for (let distance = 0; indexes.length < max && distance <= maxDistance; distance += 1) {
        const lower = center - distance;
        const upper = center + distance;
        addIndex(lower);
        if (upper !== lower && indexes.length < max) addIndex(upper);
      }
    } else {
      for (let index = 0; index < count; index++) addIndex(index);
      indexes.sort((a, b) => (Math.abs(a - center) - Math.abs(b - center)) || (a - b));
    }
    const token = ++imgs._prefetchToken;
    const queue = indexes;
    const workerLimit = prefetchConcurrency(concurrency);
    const workerCount = Math.min(workerLimit, queue.length);
    let queueIndex = 0;
    const runWorker = async () => {
      while (queueIndex < queue.length && imgs._prefetchToken === token) {
        const nextIndex = queue[queueIndex];
        queueIndex += 1;
        await imgs.ensureIndex(nextIndex);
      }
    };
    return Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  };
  return imgs;
}

function initialLoadIndexes(count, windowRadius, initialIndex) {
  if (windowRadius == null) return Array.from({ length: count }, (_, index) => index);
  return Array.from(
    { length: windowRadius * 2 + 1 },
    (_, offset) => initialIndex - windowRadius + offset,
  ).filter(index => index >= 0 && index < count);
}

export function loadImageStack(
  dir,
  count,
  existing,
  series = state.manifest?.series?.[state.seriesIdx],
  { label = dir, errorMode = 'soft', windowRadius = null, initialIndex = 0 } = {},
) {
  const indexes = initialLoadIndexes(count, windowRadius, initialIndex);
  const ensureOpts = (index) => {
    const options = { retry: true };
    if (index === initialIndex) options.priority = 'high';
    return options;
  };
  const local = state._localStacks?.[dir];
  if (local && local.length === count) {
    attachStackControls(local, dir, count, series, label, errorMode);
    const loaders = indexes.map(index => local.ensureIndex(index, ensureOpts(index)));
    return { imgs: local, loaders };
  }

  if (existing && existing.length === count && existing._dir === dir) {
    attachStackControls(existing, dir, count, series, label, errorMode);
    const loaders = indexes.map(index => existing.ensureIndex(index, ensureOpts(index)));
    return { imgs: existing, loaders };
  }
  const imgs = attachStackControls(new Array(count), dir, count, series, label, errorMode);
  const loaders = indexes.map(index => imgs.ensureIndex(index, ensureOpts(index)));
  return { imgs, loaders };
}

const _stackUnavailableNotified = new Set();

function allowStackUnavailableNotify(label) {
  _stackUnavailableNotified.delete(label);
}

function notifyStackUnavailable(label) {
  if (!globalThis.document) return;
  if (_stackUnavailableNotified.has(label)) return;
  _stackUnavailableNotified.add(label);
  notify(`${label} unavailable`, { id: `stack-unavailable:${label}`, kind: 'error' });
}

function wrapLoader(promise, label, index, errorMode, onFail) {
  return promise.catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    const prefix = errorMode === 'hard' ? 'Image load failed' : 'Image preload skipped';
    console.warn(`[${label} image ${index + 1}] ${prefix}:`, err);
    onFail?.(index);
    if (errorMode === 'hard') notifyStackUnavailable(label);
    return null;
  });
}
