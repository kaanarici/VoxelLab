import { OVERLAY_ENABLE_KINDS, RUNTIME_OVERLAY_KIND_BY_TYPE } from '../core/viewer-session-shape.js';

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

  }
}

export function rememberPreferredOverlay(modality, kind) {
  const next = canonicalKind(kind);
  if (!VALID_KINDS.has(next)) return;
  const current = getPreferredOverlays(modality);
  if (current.includes(next)) return;
  setPreferredOverlays(modality, [...current, next]);
}

export function forgetPreferredOverlay(modality, kind) {
  const next = canonicalKind(kind);
  const current = getPreferredOverlays(modality);
  if (!current.includes(next)) return;
  setPreferredOverlays(modality, current.filter((k) => k !== next));
}
