import { loadConfig, localApiHeaders } from './config.js';
import { IMAGE_CACHE_NAME } from './core/dependencies.js';

const INFLIGHT = new Map();
let _cachePromise = null;
let QUOTA_WARNED = false;
export const MAX_IMAGE_CACHE_ENTRIES = 512;
export const MAX_VOLUME_CACHE_ENTRIES = 1;

function supportsCacheStorage() {
  return !!(globalThis.caches && globalThis.URL && globalThis.fetch);
}

export function isHttpUrl(url) {
  try {
    const resolved = new URL(url, globalThis.location?.href || 'http://localhost/');
    return resolved.protocol === 'http:' || resolved.protocol === 'https:';
  } catch {
    return false;
  }
}

export function absoluteUrl(url) {
  return String(new URL(url, globalThis.location?.href || 'http://localhost/'));
}

function cacheEntryKey(value) {
  const key = value != null && String(value) === value ? value : value?.url;
  if (!key) return '';
  try {
    return absoluteUrl(key);
  } catch {
    return String(key);
  }
}

export async function trimCacheEntries(cache, maxEntries, protectedKey = '') {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 0));
  if (!cache || !(cache.keys instanceof Function) || !(cache.delete instanceof Function)) return 0;
  let keys;
  try {
    keys = await cache.keys();
  } catch {
    return 0;
  }
  let excess = Math.max(0, keys.length - limit);
  if (!excess) return 0;
  const protectedUrl = cacheEntryKey(protectedKey);
  let removed = 0;
  for (const key of keys) {
    if (!excess || (protectedUrl && cacheEntryKey(key) === protectedUrl)) continue;
    try {
      if (await cache.delete(key)) {
        excess -= 1;
        removed += 1;
      }
    } catch {

    }
  }
  return removed;
}

function getCache() {
  if (!_cachePromise) {
    _cachePromise = caches.open(IMAGE_CACHE_NAME).then(async (cache) => {
      await trimCacheEntries(cache, MAX_IMAGE_CACHE_ENTRIES);
      return cache;
    });
  }
  return _cachePromise;
}

export function isLocalProxyAssetUrl(url) {
  try {
    const base = new URL(globalThis.location?.href || 'http://localhost/');
    const resolved = new URL(url, base);
    return resolved.protocol === base.protocol
      && resolved.host === base.host
      && resolved.pathname === '/api/proxy-asset';
  } catch {
    return false;
  }
}

async function fetchInitFor(url, opts = {}) {
  const init = opts.priority ? { priority: opts.priority } : {};
  if (!isLocalProxyAssetUrl(url)) return init;
  await loadConfig();
  return { ...init, cache: 'no-store', headers: localApiHeaders() };
}

const _cleanupRuns = new Map();
export function cleanupStaleCaches(prefix, keep, legacy = []) {
  if (!supportsCacheStorage()) return Promise.resolve();
  const memoKey = `${prefix}\u0000${keep}`;
  const existing = _cleanupRuns.get(memoKey);
  if (existing) return existing;
  const legacySet = new Set(legacy);
  const run = caches.keys()
    .then((keys) => Promise.all(
      keys
        .filter((key) => (key.startsWith(prefix) || legacySet.has(key)) && key !== keep)
        .map((key) => caches.delete(key)),
    ))
    .catch(() => {})
    .then(() => {});
  _cleanupRuns.set(memoKey, run);
  return run;
}

export function cleanupOldImageCaches() {
  return cleanupStaleCaches('voxellab-images-', IMAGE_CACHE_NAME);
}

if (supportsCacheStorage()) cleanupOldImageCaches();

export async function cachedFetchResponse(url, opts = {}) {
  if (!supportsCacheStorage() || !isHttpUrl(url)) {
    return fetch(url, await fetchInitFor(url, opts));
  }
  const cacheKey = absoluteUrl(url);
  const existing = INFLIGHT.get(cacheKey);
  if (existing) return (await existing).clone();
  const pending = (async () => {

    if (isLocalProxyAssetUrl(cacheKey)) {
      return fetch(cacheKey, await fetchInitFor(cacheKey, opts));
    }
    const cache = await getCache();
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const response = await fetch(cacheKey, await fetchInitFor(cacheKey, opts));
    if (response.ok) {
      try {
        await cache.put(cacheKey, response.clone());
        await trimCacheEntries(cache, MAX_IMAGE_CACHE_ENTRIES, cacheKey);
      } catch (err) {

        if (!QUOTA_WARNED) {
          QUOTA_WARNED = true;
          console.warn('voxellab cached-fetch: cache.put failed, falling back to network', err);
        }
      }
    }
    return response;
  })().finally(() => INFLIGHT.delete(cacheKey));
  INFLIGHT.set(cacheKey, pending);
  return (await pending).clone();
}

cachedFetchResponse.invalidate = async function invalidate(url) {
  if (!supportsCacheStorage() || !isHttpUrl(url)) return;
  try {
    const cache = await getCache();
    await cache.delete(absoluteUrl(url));
  } catch {

  }
};

export async function cachedFetchJson(url) {
  try {
    const response = await cachedFetchResponse(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
