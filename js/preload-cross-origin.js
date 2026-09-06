import { imageUrlForStack } from './series/series-image-stack.js';

const INJECTED = new Set();

function pageOrigin() {
  try {
    return globalThis.location?.origin || '';
  } catch {
    return '';
  }
}

function originOf(url) {
  if (!url || url?.constructor !== String) return '';
  try {
    const parsed = new URL(url, globalThis.location?.href || 'http://localhost/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function isLocalProxyUrl(url) {
  try {
    return new URL(url, globalThis.location?.href || 'http://localhost/').pathname === '/api/proxy-asset';
  } catch {
    return false;
  }
}

function collectSeriesUrls(series) {
  const out = [];
  const { sliceUrlBase, rawUrl, regionUrlBase, regionMetaUrl, overlayUrlBases } = series;
  if (sliceUrlBase) out.push(sliceUrlBase);
  if (rawUrl) out.push(rawUrl);
  if (regionUrlBase) out.push(regionUrlBase);
  if (regionMetaUrl) out.push(regionMetaUrl);
  if (overlayUrlBases && !Array.isArray(overlayUrlBases) && Object.getPrototypeOf(overlayUrlBases) === Object.prototype) {
    for (const value of Object.values(overlayUrlBases)) {
      if (value?.constructor === String) out.push(value);
    }
  }
  return out;
}

export function collectCrossOriginHosts(manifest) {
  if (!manifest || !Array.isArray(manifest.series)) return [];
  const self = pageOrigin();
  const hosts = new Set();
  for (const series of manifest.series) {
    if (!series) continue;
    for (const url of collectSeriesUrls(series)) {
      const origin = originOf(url);
      if (origin && origin !== self) hosts.add(origin);
    }
  }
  return [...hosts];
}

function injectLink(rel, href, extras = {}) {

  const dedupeKey = `${rel}\u0000${href}`;
  if (INJECTED.has(dedupeKey)) return;
  if (!globalThis.document?.head) return;
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  for (const [key, value] of Object.entries(extras)) {
    if (value != null) link[key] = value;
  }
  document.head.appendChild(link);
  INJECTED.add(dedupeKey);
}

export function applyCrossOriginPreloads(manifest, { activeSeriesIdx = 0 } = {}) {
  const hosts = collectCrossOriginHosts(manifest);
  for (const origin of hosts) {
    injectLink('preconnect', origin, { crossOrigin: 'anonymous' });
  }
  if (!hosts.length) return;
  const active = manifest?.series?.[activeSeriesIdx];
  if (!active?.sliceUrlBase) return;

  const firstSliceUrl = imageUrlForStack(active.slug, 0, active);
  if (!originOf(firstSliceUrl)) return;
  if (isLocalProxyUrl(firstSliceUrl)) return;
  injectLink('preload', firstSliceUrl, {
    as: 'image',
    fetchPriority: 'high',
    crossOrigin: 'anonymous',
  });
}
