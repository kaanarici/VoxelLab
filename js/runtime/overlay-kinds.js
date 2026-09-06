import { seriesIdentityKey } from '../core/series-identity.js';
import { deletePassthroughRootEntry, setPassthroughRootEntry, state } from '../core/state.js';
import { OVERLAY_CACHE_BY_KIND } from './overlay-cache-keys.js';

function uniqueStrings(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export const CANONICAL_OVERLAY_KINDS = Object.freeze(
  uniqueStrings(Object.values(OVERLAY_CACHE_BY_KIND).map((cache) => cache.kind)),
);

function isOverlayRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function overlayHintKey(series) {
  return seriesIdentityKey(series);
}

function hintsForSeries(series) {
  const key = overlayHintKey(series);
  if (!key) return null;
  const stored = state._seriesOverlayHints?.[key];
  return isOverlayRecord(stored) ? stored : null;
}

function hintForSeries(series, kind) {
  const hint = hintsForSeries(series)?.[kind];
  return isOverlayRecord(hint) ? hint : null;
}

function hintAvailable(value) {
  return value === true || value === false ? value : null;
}

function defaultDescriptor(kind, series) {
  const flag = OVERLAY_CACHE_BY_KIND[kind]?.availableFlag;
  return {
    available: flag ? !!series?.[flag] : false,
  };
}

export function overlayAvailabilityForKind(series, kind) {
  return hintAvailable(hintForSeries(series, kind)?.available)
    ?? defaultDescriptor(kind, series).available;
}

function ensureOverlayHintBag() {
  if (state._seriesOverlayHints && Object.getPrototypeOf(state._seriesOverlayHints) === Object.prototype) {
    return true;
  }
  state._seriesOverlayHints = {};
  return true;
}

export function setSeriesOverlayHints(series, hints = {}) {
  if (!isOverlayRecord(series) || !isOverlayRecord(hints)) return series;
  const key = overlayHintKey(series);
  if (!key) return series;
  const existing = hintsForSeries(series) || {};
  const next = { ...existing };
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    const kind = cache.kind;
    if (!(kind in hints) || !isOverlayRecord(hints[kind])) continue;
    const available = hintAvailable(hints[kind].available) ?? hintAvailable(existing[kind]?.available);
    if (available == null) {
      delete next[kind];
      continue;
    }
    next[kind] = { available };
  }
  ensureOverlayHintBag();
  setPassthroughRootEntry('_seriesOverlayHints', key, next);
  return series;
}

export function clearSeriesOverlayHints(series) {
  const key = overlayHintKey(series);
  if (!key) return false;
  return deletePassthroughRootEntry('_seriesOverlayHints', key);
}

export function overlayKindsForSeries(series) {
  const byKind = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    byKind[cache.kind] = { available: overlayAvailabilityForKind(series, cache.kind) };
  }
  const availableKinds = CANONICAL_OVERLAY_KINDS.filter((kind) => byKind[kind].available);
  return {
    byKind,
    availableKinds,
  };
}
