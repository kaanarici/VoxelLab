import { OVERLAY_ENABLE_KINDS, RUNTIME_OVERLAY_KIND_BY_TYPE } from '../core/viewer-session-shape.js';

// Persisted preferred-overlay hints per modality (localStorage). Single-writer/single-reader;
// tiny entries. Read synchronously so selectSeries() can schedule overlay prefetch before any await.
//
// Policy:
// - One key per modality: voxellab.overlay.preferred.<MODALITY>
// - Value is a JSON array of overlay kinds: ['tissue', 'labels', 'heatmap']
// - Empty array (or missing key) means "no preference" — selectSeries
//   should not pre-fetch anything beyond what state.overlays already requests.
// - Eviction: none. Bounded by O(modalities) — typically ≤ 10 entries.

const VALID_KINDS = new Set(OVERLAY_ENABLE_KINDS);

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function keyFor(modality) {
  const m = String(modality || '').toUpperCase().trim();
  return m ? `voxellab.overlay.preferred.${m}` : '';
}

function canonicalKind(kind) {
  return VALID_KINDS.has(kind) ? kind : '';
}

export function migratePreferredOverlayKinds(kinds) {
  const next = [];
  let changed = false;
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    const alias = RUNTIME_OVERLAY_KIND_BY_TYPE[kind];
    const mapped = VALID_KINDS.has(kind) ? kind : (VALID_KINDS.has(alias) ? alias : '');
    if (mapped !== kind) changed = true;
    if (!mapped || next.includes(mapped)) continue;
    next.push(mapped);
  }
  return { kinds: next, changed };
}

/**
 * Return the user's preferred overlays for this modality. Empty array when
 * no preference has been recorded or storage is unavailable.
 *
 * @param {string} modality e.g. 'CT', 'MR'
 * @returns {Array<'tissue' | 'labels' | 'heatmap'>}
 */
export function getPreferredOverlays(modality) {
  const store = storage();
  const key = keyFor(modality);
  if (!store || !key) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (parsed.every((kind) => VALID_KINDS.has(kind))) {
      return [...new Set(parsed)];
    }
    const migrated = migratePreferredOverlayKinds(parsed);
    if (migrated.kinds.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify(migrated.kinds));
    return migrated.kinds;
  } catch {
    return [];
  }
}

/**
 * Persist the preferred overlay set for this modality. Filters to known
 * kinds; writing an empty set clears the entry.
 *
 * @param {string} modality
 * @param {Array<'tissue' | 'labels' | 'heatmap'>} set
 */
export function setPreferredOverlays(modality, set) {
  const store = storage();
  const key = keyFor(modality);
  if (!store || !key) return;
  const filtered = [...new Set((Array.isArray(set) ? set : []).filter((kind) => VALID_KINDS.has(kind)))];
  try {
    if (filtered.length === 0) {
      store.removeItem(key);
    } else {
      store.setItem(key, JSON.stringify(filtered));
    }
  } catch {
    // Best-effort persistence; ignore quota errors.
  }
}

/**
 * Add one overlay kind to the preferred set for this modality. No-op if
 * already present. Used by overlay toggle handlers when the user enables
 * a new overlay.
 *
 * @param {string} modality
 * @param {'tissue' | 'labels' | 'heatmap'} kind
 */
export function rememberPreferredOverlay(modality, kind) {
  const next = canonicalKind(kind);
  if (!VALID_KINDS.has(next)) return;
  const current = getPreferredOverlays(modality);
  if (current.includes(next)) return;
  setPreferredOverlays(modality, [...current, next]);
}

/**
 * Remove one overlay kind from the preferred set. No-op if missing.
 *
 * @param {string} modality
 * @param {'tissue' | 'labels' | 'heatmap'} kind
 */
export function forgetPreferredOverlay(modality, kind) {
  const next = canonicalKind(kind);
  const current = getPreferredOverlays(modality);
  if (!current.includes(next)) return;
  setPreferredOverlays(modality, current.filter((k) => k !== next));
}
