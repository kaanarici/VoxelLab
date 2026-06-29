import { state } from './core/state.js';

const MAX_LOCAL_RAW_VOLUME_BYTES = 512 * 1024 * 1024;

function ensureLocalRawVolumeOrder() {
  if (!Array.isArray(state._localRawVolumeOrder)) state._localRawVolumeOrder = [];
  return state._localRawVolumeOrder;
}

function totalLocalRawVolumeBytes() {
  return Object.values(state._localRawVolumes || {}).reduce(
    (sum, volume) => sum + (volume?.byteLength || 0),
    0,
  );
}

export function touchLocalRawVolume(slug = '') {
  const key = String(slug || '').trim();
  if (!key || !state._localRawVolumes?.[key]) return false;
  const next = ensureLocalRawVolumeOrder().filter((entry) => entry !== key);
  next.push(key);
  state._localRawVolumeOrder = next;
  return true;
}

export function cacheLocalRawVolume(slug, rawVolume, { maxBytes = MAX_LOCAL_RAW_VOLUME_BYTES } = {}) {
  const key = String(slug || '').trim();
  if (!key || !rawVolume) return false;
  state._localRawVolumes[key] = rawVolume;
  touchLocalRawVolume(key);
  const protectedSlugs = new Set([
    key,
    state.manifest?.series?.[state.seriesIdx]?.slug || '',
  ].filter(Boolean));
  while (totalLocalRawVolumeBytes() > maxBytes) {
    const victim = ensureLocalRawVolumeOrder().find((entry) => !protectedSlugs.has(entry));
    if (!victim) break;
    delete state._localRawVolumes[victim];
    state._localRawVolumeOrder = ensureLocalRawVolumeOrder().filter((entry) => entry !== victim);
  }
  return true;
}
