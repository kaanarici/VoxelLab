import { RUNTIME_OVERLAY_KIND_BY_TYPE } from './viewer-session-shape.js';

// Shape: canonical runtime overlay names, e.g. ['tissue', 'labels', 'heatmap', 'fusion'].
export const CANONICAL_OVERLAY_KINDS = Object.freeze(uniqueStrings(Object.values(RUNTIME_OVERLAY_KIND_BY_TYPE)));

// Shape: legacy UI/storage slot -> canonical overlay kind, shared with viewer session state.
export const LEGACY_OVERLAY_KIND_MAP = Object.freeze({ ...RUNTIME_OVERLAY_KIND_BY_TYPE });

const SERIES_OVERLAY_HINTS = '__voxOverlayHints';

function isOverlayRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function hintForSeries(series, kind) {
  if (!isOverlayRecord(series)) return null;
  const hint = series[SERIES_OVERLAY_HINTS]?.[kind];
  return isOverlayRecord(hint) ? hint : null;
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function defaultDescriptor(kind, series) {
  if (kind === 'tissue') {
    return {
      kind,
      available: !!series?.hasSeg,
      legacyKinds: ['seg'],
      manifestFlag: 'hasSeg',
      source: series?.hasSeg ? 'series-seg' : null,
    };
  }
  if (kind === 'labels') {
    return {
      kind,
      available: !!series?.hasRegions,
      legacyKinds: ['regions'],
      manifestFlag: 'hasRegions',
      source: series?.hasRegions ? 'series-regions' : null,
    };
  }
  if (kind === 'heatmap') {
    return {
      kind,
      available: !!series?.hasSym,
      legacyKinds: ['sym'],
      manifestFlag: 'hasSym',
      source: series?.hasSym ? 'series-sym' : null,
    };
  }
  return {
    kind,
    available: false,
    legacyKinds: ['fusion'],
    manifestFlag: null,
    source: null,
  };
}

// Shape: { labels: { source: 'dicom-seg', legacyKinds: ['regions', 'seg'] } }.
export function setSeriesOverlayHints(series, hints = {}) {
  if (!isOverlayRecord(series) || !isOverlayRecord(hints)) return series;
  const storedHints = series[SERIES_OVERLAY_HINTS];
  const existing = isOverlayRecord(storedHints) ? storedHints : {};
  const next = { ...existing };
  for (const kind of CANONICAL_OVERLAY_KINDS) {
    if (!(kind in hints) || !isOverlayRecord(hints[kind])) continue;
    const hint = hints[kind];
    const previous = isOverlayRecord(existing[kind]) ? existing[kind] : {};
    next[kind] = {
      ...previous,
      ...hint,
      legacyKinds: uniqueStrings([...(previous.legacyKinds || []), ...(hint.legacyKinds || [])]),
      source: String(hint.source || previous.source || '').trim() || null,
    };
  }
  Object.defineProperty(series, SERIES_OVERLAY_HINTS, {
    value: next,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return series;
}

// Shape: { byKind: { tissue: { available: true, ... } }, availableKinds: ['tissue'] }.
export function overlayKindsForSeries(series) {
  const byKind = {};
  for (const kind of CANONICAL_OVERLAY_KINDS) {
    const base = defaultDescriptor(kind, series);
    const hint = hintForSeries(series, kind);
    byKind[kind] = {
      ...base,
      available: hint?.available === true || hint?.available === false ? hint.available : base.available,
      legacyKinds: uniqueStrings([...(base.legacyKinds || []), ...(hint?.legacyKinds || [])]),
      source: String(hint?.source || base.source || '').trim() || null,
    };
  }
  const availableKinds = CANONICAL_OVERLAY_KINDS.filter((kind) => byKind[kind].available);
  return {
    byKind,
    availableKinds,
    legacyMap: { ...LEGACY_OVERLAY_KIND_MAP },
  };
}
