import { SERVICE_WORKER_VERSION } from './js/core/dependencies.js';
import { PRECACHE_LOCAL } from './js/sw-precache-manifest.js';

const STATIC_CACHE = `voxellab-static-${SERVICE_WORKER_VERSION}`;
const DATA_CACHE = `voxellab-data-${SERVICE_WORKER_VERSION}`;
const MAX_INSTALL_PRECACHE_LOCAL_SLICES = 32;
const MAX_DATA_CACHE_ENTRIES = 512;

// Non-globbable shell roots (root URL + assets the generated manifest doesn't
// glob). PRECACHE_LOCAL covers js/css/templates/index.html — see gen_sw_manifest.mjs.
const CORE_SHELL = [
  './',
  './icons.svg',
  './config.json',
  './viewer.js',
];

const CORE_ASSETS = [...CORE_SHELL, ...PRECACHE_LOCAL];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(CORE_ASSETS);

    const dataCache = await caches.open(DATA_CACHE);
    await trimRuntimeCache(dataCache, MAX_DATA_CACHE_ENTRIES);
    const manifestResponse = await fetch('./data/manifest.json').catch(() => null);
    if (manifestResponse?.ok) {
      const manifestUrl = new URL('./data/manifest.json', self.location.href).href;
      await dataCache.put(manifestUrl, manifestResponse.clone());
      const manifest = await manifestResponse.json().catch(() => null);
      const urls = manifest ? localManifestAssetUrls(manifest) : [];
      await Promise.all(urls.map((url) => dataCache.add(url).catch(() => null)));
      await trimRuntimeCache(dataCache, MAX_DATA_CACHE_ENTRIES, manifestUrl);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, DATA_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (keep.has(key) ? null : caches.delete(key))));
    const dataCache = await caches.open(DATA_CACHE);
    await trimRuntimeCache(dataCache, MAX_DATA_CACHE_ENTRIES);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isCacheFirstStaticRequest(url)) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  if (isNetworkFirstStaticRequest(url)) {
    event.respondWith(networkFirst(event.request, STATIC_CACHE));
    return;
  }

  if (isLocalDataRequest(url)) {
    event.respondWith(networkFirstData(event.request));
  }
});

function isCacheFirstStaticRequest(url) {
  return (
    url.origin === self.location.origin &&
    (
      url.pathname.endsWith('/icons.svg') ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/css/') ||
      url.pathname.startsWith('/templates/') ||
      url.pathname.startsWith('/node_modules/')
    )
  );
}

function isNetworkFirstStaticRequest(url) {
  return (
    url.origin === self.location.origin &&
    (
      url.pathname === '/' ||
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/config.json')
    )
  );
}

function isLocalDataRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/data/');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.status === 401 || response.status === 403) {
      await caches.delete(DATA_CACHE);
    } else if (response.ok && !request.headers.has('Authorization')) {
      await cache.put(request, response.clone());
      await trimRuntimeCache(cache, MAX_DATA_CACHE_ENTRIES, request);
    }
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

function cacheRequestKey(value) {
  const key = typeof value === 'string' ? value : String(value?.url || '');
  if (!key) return '';
  try {
    return new URL(key, self.location.href).href;
  } catch {
    return key;
  }
}

async function trimRuntimeCache(cache, maxEntries, protectedRequest = null) {
  if (!cache || typeof cache.keys !== 'function' || typeof cache.delete !== 'function') return;
  let keys;
  try {
    keys = await cache.keys();
  } catch {
    return;
  }
  let excess = Math.max(0, keys.length - maxEntries);
  const protectedKey = cacheRequestKey(protectedRequest);
  for (const key of keys) {
    if (!excess || (protectedKey && cacheRequestKey(key) === protectedKey)) continue;
    try {
      if (await cache.delete(key)) excess -= 1;
    } catch {
      // Cache retention is best-effort; network responses must still succeed.
    }
  }
}

function localManifestAssetUrls(manifest) {
  const urls = [];
  for (const series of manifest.series || []) {
    if (series.sliceUrlBase || series.rawUrl) continue;
    const slug = String(series.slug || '');
    const slices = Number(series.slices || 0);
    if (!slug || slices <= 0) continue;
    const preloadSlices = Math.min(slices, MAX_INSTALL_PRECACHE_LOCAL_SLICES);
    for (let index = 0; index < preloadSlices; index++) {
      urls.push(`./data/${slug}/${String(index).padStart(4, '0')}.png`);
    }
    if (series.hasAnalysis) urls.push(`./data/${slug}_analysis.json`);
    if (series.hasAskHistory) urls.push(`./data/${slug}_asks.json`);
    if (series.hasStats) urls.push(`./data/${slug}_stats.json`);
    if (series.hasRegions) {
      urls.push(`./data/${slug}_regions.json`);
    }
  }
  return urls;
}
