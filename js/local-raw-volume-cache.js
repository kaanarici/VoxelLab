import { state } from './core/state.js';
import {
  deleteLocalRuntimeMapEntry,
  getLocalRawVolumeOrder,
  setLocalRawVolumeOrder,
  setLocalRuntimeMapEntry,
} from './runtime/viewer-runtime.js';

const MAX_LOCAL_RAW_VOLUME_BYTES = 512 * 1024 * 1024;

function totalLocalRawVolumeBytes() {
  return Object.values(state._localRawVolumes || {}).reduce(
    (sum, volume) => sum + (volume?.byteLength || 0),
    0,
  );
}

export function touchLocalRawVolume(slug = '') {
  const key = String(slug || '').trim();
  if (!key || !state._localRawVolumes?.[key]) return false;
  const next = getLocalRawVolumeOrder().filter((entry) => entry !== key);
  next.push(key);
  setLocalRawVolumeOrder(next);
  return true;
}

export function clearLocalRawVolume(slug = '') {
  const key = String(slug || '').trim();
  if (!key) return false;
  const hadVolume = Boolean(state._localRawVolumes?.[key]);
  deleteLocalRuntimeMapEntry('_localRawVolumes', key);
  const order = getLocalRawVolumeOrder();
  const next = order.filter((entry) => entry !== key);
  setLocalRawVolumeOrder(next);
  return hadVolume || next.length !== order.length;
}

export function cacheLocalRawVolume(slug, rawVolume, { maxBytes = MAX_LOCAL_RAW_VOLUME_BYTES } = {}) {
  const key = String(slug || '').trim();
  if (!key || !rawVolume) return false;
  const byteLength = Number(rawVolume?.byteLength) || 0;
  if (byteLength > maxBytes) {
    clearLocalRawVolume(key);
    return false;
  }
  setLocalRuntimeMapEntry('_localRawVolumes', key, rawVolume);
  touchLocalRawVolume(key);
  while (totalLocalRawVolumeBytes() > maxBytes) {
    const victim = getLocalRawVolumeOrder().find((entry) => entry !== key);
    if (!victim) break;
    deleteLocalRuntimeMapEntry('_localRawVolumes', victim);
    setLocalRawVolumeOrder(getLocalRawVolumeOrder().filter((entry) => entry !== victim));
  }
  return true;
}
