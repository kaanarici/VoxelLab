// SEG / RTSTRUCT / SR / … overlay binding: FoR UID + affine checks. Use this module
// for validation instead of one-off checks.

import { geometryFromSeries } from './core/geometry.js';

const DERIVED_KINDS = new Set(['seg', 'rtstruct', 'sr', 'rtdose', 'registration', 'derived-volume']);

const AFFINE_COMPATIBILITY = new Set(['exact', 'within-tolerance', 'requires-registration', 'incompatible']);
const DERIVED_REGISTRY_KEY = 'mri-viewer/derived-objects/v1';
const DERIVED_REGISTRY_VERSION = 1;
const HYDRATABLE_AFFINE_COMPATIBILITY = new Set(['exact', 'within-tolerance']);

// In-memory fallback when localStorage is unavailable (tests, workers).
const MEMORY_STORAGE = new Map();

function hasTrustworthyGeometry(series) {
  return Array.isArray(series?.orientation) && series.orientation.length >= 6
    && Array.isArray(series?.firstIPP) && series.firstIPP.length >= 3
    && Array.isArray(series?.lastIPP) && series.lastIPP.length >= 3
    && Number(series?.slices || 0) > 0
    && Number(series?.pixelSpacing?.[0] || 0) > 0
    && Number(series?.pixelSpacing?.[1] || 0) > 0
    && series?.sliceSpacingRegular !== false;
}

function finiteMatrix4(matrix) {
  return Array.isArray(matrix) && matrix.length >= 4
    && matrix.slice(0, 4).every(row => Array.isArray(row) && row.length >= 4 && row.slice(0, 4).every(Number.isFinite));
}

function sourceGeometrySnapshot(series) {
  if (!hasTrustworthyGeometry(series)) return null;
  const geo = geometryFromSeries(series);
  return {
    frameOfReferenceUID: geo.frameOfReferenceUID,
    affineLps: geo.affineLps.map(row => row.slice()),
  };
}

function affineMatchesCurrentSource(stored, current, toleranceMm = 0.1) {
  if (!finiteMatrix4(stored) || !finiteMatrix4(current)) return false;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const tolerance = c === 3 ? toleranceMm : 1e-4;
      if (Math.abs(stored[r][c] - current[r][c]) > tolerance) return false;
    }
  }
  return true;
}

export function validateDerivedObjectBinding(binding) {
  const errors = [];

  if (!binding || typeof binding !== 'object') return ['binding: expected object'];

  if (!DERIVED_KINDS.has(binding.derivedKind)) {
    errors.push(`derivedKind: expected one of ${[...DERIVED_KINDS].sort().join(', ')}`);
  }
  // Empty is valid: a slug-bound local overlay (e.g. a SEG on a non-DICOM source
  // series with no FrameOfReferenceUID) carries '' here. A non-empty value is
  // compared against the source's FoR during hydration revalidation.
  if (typeof binding.frameOfReferenceUID !== 'string') {
    errors.push('frameOfReferenceUID: expected string');
  }
  const hasSourceUid = typeof binding.sourceSeriesUID === 'string' && !!binding.sourceSeriesUID;
  const hasSourceSlug = typeof binding.sourceSeriesSlug === 'string' && !!binding.sourceSeriesSlug;
  if (!hasSourceUid && !hasSourceSlug) {
    errors.push('sourceSeriesUID or sourceSeriesSlug: expected non-empty string');
  }
  if (typeof binding.requiresRegistration !== 'boolean') {
    errors.push('requiresRegistration: expected boolean');
  }
  if (!AFFINE_COMPATIBILITY.has(binding.affineCompatibility)) {
    errors.push(`affineCompatibility: expected one of ${[...AFFINE_COMPATIBILITY].sort().join(', ')}`);
  }

  if (['requires-registration', 'incompatible'].includes(binding.affineCompatibility) && !binding.requiresRegistration) {
    errors.push('requiresRegistration must be true when affineCompatibility requires registration');
  }
  if (binding.sourceGeometry != null) {
    if (typeof binding.sourceGeometry !== 'object') {
      errors.push('sourceGeometry: expected object');
    } else {
      if (typeof binding.sourceGeometry.frameOfReferenceUID !== 'string') {
        errors.push('sourceGeometry.frameOfReferenceUID: expected string');
      }
      if (!finiteMatrix4(binding.sourceGeometry.affineLps)) {
        errors.push('sourceGeometry.affineLps: expected finite 4x4 matrix');
      }
    }
  }

  return errors;
}

function readStorage(key) {
  if (typeof localStorage === 'undefined') return String(MEMORY_STORAGE.get(key) || '');
  try { return String(localStorage.getItem(key) || ''); }
  catch { return ''; }
}

function writeStorage(key, json) {
  if (typeof localStorage === 'undefined') {
    MEMORY_STORAGE.set(key, json);
    return true;
  }
  try {
    localStorage.setItem(key, json);
    return true;
  } catch {
    return false;
  }
}

export function storageJsonGet(key, fallback = {}) {
  const raw = readStorage(String(key || ''));
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function storageJsonSet(key, value) {
  return writeStorage(String(key || ''), JSON.stringify(value));
}

export function derivedSourceRefFromSeries(series) {
  const sourceSeriesUID = typeof series?.sourceSeriesUID === 'string' && series.sourceSeriesUID
    ? series.sourceSeriesUID
    : '';
  const sourceSeriesSlug = typeof series?.slug === 'string' && series.slug
    ? series.slug
    : '';
  const sourceKey = sourceSeriesUID ? `uid:${sourceSeriesUID}` : sourceSeriesSlug ? `slug:${sourceSeriesSlug}` : '';
  return { sourceSeriesUID, sourceSeriesSlug, sourceKey };
}

function registryId(binding, objectUID) {
  const sourceKey = binding?.sourceSeriesUID
    ? `uid:${binding.sourceSeriesUID}`
    : binding?.sourceSeriesSlug
      ? `slug:${binding.sourceSeriesSlug}`
      : '';
  if (!sourceKey || !objectUID) return '';
  return `${sourceKey}|obj:${objectUID}`;
}

function emptyRegistry() {
  return { version: DERIVED_REGISTRY_VERSION, entries: {} };
}

export function loadDerivedRegistry() {
  const raw = readStorage(DERIVED_REGISTRY_KEY);
  if (!raw) return emptyRegistry();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyRegistry();
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return {
      version: DERIVED_REGISTRY_VERSION,
      entries,
    };
  } catch {
    return emptyRegistry();
  }
}

export function saveDerivedRegistry(registry) {
  const normalized = {
    version: DERIVED_REGISTRY_VERSION,
    entries: registry?.entries && typeof registry.entries === 'object' ? registry.entries : {},
  };
  const persisted = writeStorage(DERIVED_REGISTRY_KEY, JSON.stringify(normalized));
  return { registry: normalized, persisted };
}

export function clearDerivedRegistry() {
  saveDerivedRegistry(emptyRegistry());
}

export function validateDerivedRegistryEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['entry: expected object'];
  if (typeof entry.id !== 'string' || !entry.id) errors.push('id: expected non-empty string');
  if (typeof entry.objectUID !== 'string' || !entry.objectUID) errors.push('objectUID: expected non-empty string');
  if (typeof entry.name !== 'string' || !entry.name) errors.push('name: expected non-empty string');
  if (typeof entry.modality !== 'string' || !entry.modality) errors.push('modality: expected non-empty string');
  if (!Number.isFinite(Number(entry.importedAt || 0))) errors.push('importedAt: expected finite number');
  const bindingErrors = validateDerivedObjectBinding(entry.binding);
  for (const bindingError of bindingErrors) errors.push(`binding.${bindingError}`);
  if (entry.id && entry.objectUID && entry.binding) {
    const expectedId = registryId(entry.binding, entry.objectUID);
    if (!expectedId) errors.push('binding source reference: expected sourceSeriesUID or sourceSeriesSlug');
    else if (expectedId !== entry.id) errors.push('id: does not match binding + objectUID');
  }
  return errors;
}

export function upsertDerivedRegistryEntry(entry) {
  const errors = validateDerivedRegistryEntry(entry);
  if (errors.length) throw new Error(`Invalid derived registry entry: ${errors.join('; ')}`);
  const registry = loadDerivedRegistry();
  registry.entries[entry.id] = entry;
  const { persisted } = saveDerivedRegistry(registry);
  return { entry, persisted };
}

export function getDerivedRegistryEntry(sourceSeries, objectUID) {
  const sourceRef = derivedSourceRefFromSeries(sourceSeries);
  const id = registryId({
    sourceSeriesUID: sourceRef.sourceSeriesUID || undefined,
    sourceSeriesSlug: sourceRef.sourceSeriesSlug || undefined,
  }, String(objectUID || ''));
  if (!id) return null;
  const registry = loadDerivedRegistry();
  const entry = registry.entries[id] || null;
  return assessDerivedRegistryEntryForSeries(entry, sourceSeries).accepted ? entry : null;
}

export function listDerivedRegistryEntriesForSeries(sourceSeries) {
  return listDerivedRegistryEntriesForSeriesWithSkipped(sourceSeries).entries;
}

// Revalidate a persisted binding against the current source before hydrating.
// The goal is to skip only genuinely INCOMPATIBLE bindings (a real FoR or affine
// mismatch), not to block a previously-valid overlay whose binding simply lacks
// optional geometry. A slug-bound local overlay with no FrameOfReferenceUID and
// no stored affine is legitimate and must hydrate; a binding whose stored affine
// clearly disagrees with trustworthy current geometry is a real mismatch.
export function assessDerivedRegistryEntryForSeries(entry, sourceSeries) {
  const errors = validateDerivedRegistryEntry(entry);
  if (errors.length) return { accepted: false, reason: 'derived_registry_entry_invalid', errors };
  const binding = entry.binding || {};
  const { sourceSeriesUID, sourceSeriesSlug } = derivedSourceRefFromSeries(sourceSeries);
  const sourceMatches = (sourceSeriesUID && binding.sourceSeriesUID === sourceSeriesUID)
    || (sourceSeriesSlug && binding.sourceSeriesSlug === sourceSeriesSlug);
  if (!sourceMatches) return { accepted: false, reason: 'derived_binding_source_mismatch' };

  // Reject only a real FoR conflict: both sides carry a FoR and they differ.
  // A missing FoR on either side is a slug-bound (non-spatial) overlay.
  const sourceFrame = String(sourceSeries?.frameOfReferenceUID || '');
  const bindingFrame = String(binding.frameOfReferenceUID || '');
  if (sourceFrame && bindingFrame && sourceFrame !== bindingFrame) {
    return { accepted: false, reason: 'derived_binding_frame_mismatch' };
  }

  // Reject only when a stored affine EXISTS, the current source geometry is
  // trustworthy, and the two clearly disagree. A binding without a stored affine
  // (or a current source we can't trust) is not treated as a mismatch.
  const storedAffine = binding.sourceGeometry?.affineLps;
  if (storedAffine) {
    const storedFrame = String(binding.sourceGeometry?.frameOfReferenceUID || '');
    if (sourceFrame && storedFrame && storedFrame !== sourceFrame) {
      return { accepted: false, reason: 'derived_binding_frame_mismatch' };
    }
    const currentAffine = sourceGeometrySnapshot(sourceSeries)?.affineLps;
    if (currentAffine && !affineMatchesCurrentSource(storedAffine, currentAffine)) {
      return { accepted: false, reason: 'derived_binding_geometry_mismatch' };
    }
  }

  if (!HYDRATABLE_AFFINE_COMPATIBILITY.has(binding.affineCompatibility) && binding.derivedKind !== 'rtdose') {
    return { accepted: false, reason: 'derived_binding_requires_registration' };
  }
  return { accepted: true };
}

export function listDerivedRegistryEntriesForSeriesWithSkipped(sourceSeries) {
  const registry = loadDerivedRegistry();
  const entries = [];
  const skipped = [];
  const { sourceSeriesUID, sourceSeriesSlug } = derivedSourceRefFromSeries(sourceSeries);
  for (const entry of Object.values(registry.entries)) {
    const binding = entry?.binding || {};
    const sourceMatches = (sourceSeriesUID && binding.sourceSeriesUID === sourceSeriesUID)
      || (sourceSeriesSlug && binding.sourceSeriesSlug === sourceSeriesSlug);
    if (!sourceMatches) continue;
    const assessment = assessDerivedRegistryEntryForSeries(entry, sourceSeries);
    if (assessment.accepted) entries.push(entry);
    else {
      skipped.push({
        objectUID: String(entry?.objectUID || ''),
        name: String(entry?.name || ''),
        kind: String(entry?.binding?.derivedKind || ''),
        reason: assessment.reason,
        errors: assessment.errors || [],
      });
    }
  }
  entries.sort((a, b) => Number(a.importedAt || 0) - Number(b.importedAt || 0));
  return { entries, skipped };
}

export function assessAffineCompatibility(sourceSeries, derivedSeries, toleranceMm = 0.1) {
  const sourceGeo = geometryFromSeries(sourceSeries);
  const derivedGeo = geometryFromSeries(derivedSeries);

  const sourceFor = sourceGeo.frameOfReferenceUID;
  const derivedFor = derivedGeo.frameOfReferenceUID;
  if (!sourceFor || !derivedFor || sourceFor !== derivedFor) {
    return 'incompatible';
  }
  if (!hasTrustworthyGeometry(sourceSeries) || !hasTrustworthyGeometry(derivedSeries)) {
    return 'requires-registration';
  }

  const srcM = sourceGeo.affineLps;
  const derM = derivedGeo.affineLps;
  let maxLinearDiff = 0;
  let maxTranslationDiffMm = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      maxLinearDiff = Math.max(maxLinearDiff, Math.abs(srcM[r][c] - derM[r][c]));
    }
    maxTranslationDiffMm = Math.max(maxTranslationDiffMm, Math.abs(srcM[r][3] - derM[r][3]));
  }

  if (maxLinearDiff < 1e-6 && maxTranslationDiffMm < 1e-6) return 'exact';
  if (maxLinearDiff < 1e-4 && maxTranslationDiffMm < toleranceMm) return 'within-tolerance';
  return 'requires-registration';
}

export function buildDerivedObjectBinding(derivedKind, sourceSeries, derivedSeries) {
  const compatibility = assessAffineCompatibility(sourceSeries, derivedSeries);
  const binding = {
    derivedKind,
    frameOfReferenceUID: String(derivedSeries.frameOfReferenceUID || ''),
    requiresRegistration: compatibility === 'requires-registration' || compatibility === 'incompatible',
    affineCompatibility: compatibility,
  };
  const sourceGeometry = sourceGeometrySnapshot(sourceSeries);
  if (sourceGeometry) binding.sourceGeometry = sourceGeometry;
  if (sourceSeries.sourceSeriesUID) binding.sourceSeriesUID = String(sourceSeries.sourceSeriesUID);
  else if (sourceSeries.slug) binding.sourceSeriesSlug = String(sourceSeries.slug);
  return binding;
}

export function buildDerivedRegistryEntry({
  derivedKind,
  sourceSeries,
  derivedSeries,
  objectUID,
  name,
  modality,
  payload,
  importedAt = Date.now(),
}) {
  const binding = buildDerivedObjectBinding(derivedKind, sourceSeries, derivedSeries);
  const id = registryId(binding, String(objectUID || ''));
  return {
    id,
    objectUID: String(objectUID || ''),
    name: String(name || `${String(derivedKind || '').toUpperCase()} import`),
    modality: String(modality || String(derivedKind || '').toUpperCase()),
    importedAt: Number(importedAt || Date.now()),
    binding,
    payload: payload || null,
  };
}
