export function getFloat(meta, key, fallback = 0) {
  const v = meta[key];
  if (v == null) return fallback;
  if (Array.isArray(v)) return parseFloat(v[0]) || fallback;
  return parseFloat(v) || fallback;
}

export function getInt(meta, key, fallback = 0) {
  const v = meta[key];
  if (v == null) return fallback;
  const parsed = Array.isArray(v) ? parseInt(v[0], 10) : parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getStr(meta, key, fallback = '') {
  const v = meta[key];
  if (v == null) return fallback;
  if (Array.isArray(v)) return String(v[0] || fallback);
  return String(v || fallback);
}

export function getFloatArray(meta, key) {
  const v = meta[key];
  if (!v) return null;
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string') return v.split('\\').map(Number);
  return null;
}

export function getStrArray(meta, key) {
  const v = meta[key];
  if (!v) return [];
  if (Array.isArray(v)) return v.map(item => String(item || ''));
  return String(v).split('\\');
}

export function normalizeModality(modality, fallback = 'OT') {
  return String(modality || fallback).trim().toUpperCase();
}
