import {
  RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE,
  RUNTIME_OVERLAY_KIND_BY_TYPE,
} from '../core/viewer-session-shape.js';

const OVERLAY_PACKAGE_ASSET_BY_KIND = Object.freeze({
  tissue: Object.freeze({ kind: 'tissue-overlay', label: 'Tissue overlay PNG stack' }),
  labels: Object.freeze({ kind: 'anatomy-labels', label: 'Anatomy label PNG stack' }),
  heatmap: Object.freeze({ kind: 'symmetry-heatmap', label: 'Symmetry heatmap PNG stack' }),
});

function overlayCacheEntry(type, kind, keys) {
  return Object.freeze({
    type,
    kind,
    packageAsset: OVERLAY_PACKAGE_ASSET_BY_KIND[kind] || null,
    ...keys,
  });
}

export const OVERLAY_CACHE_BY_TYPE = Object.freeze(
  Object.fromEntries(
    Object.entries(RUNTIME_OVERLAY_KIND_BY_TYPE).map(([type, kind]) => [
      type,
      overlayCacheEntry(type, kind, RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE[type]),
    ]),
  ),
);

export const OVERLAY_CACHE_BY_KIND = Object.freeze(
  Object.fromEntries(Object.values(OVERLAY_CACHE_BY_TYPE).map((entry) => [entry.kind, entry])),
);

export function overlayImgsKey(type) {
  return OVERLAY_CACHE_BY_TYPE[type]?.imgs || null;
}

export function overlayVoxelsKey(type) {
  return OVERLAY_CACHE_BY_TYPE[type]?.voxels || null;
}

export function overlayBytesPresent(overlayBytes) {
  return Object.values(OVERLAY_CACHE_BY_KIND).some((cache) => overlayBytes?.[cache.bytes]);
}

export function overlayBytesFromCaches(readBytes) {
  const overlayBytes = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    overlayBytes[cache.bytes] = readBytes(cache) || null;
  }
  return overlayBytes;
}
