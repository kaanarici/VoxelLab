import { seriesCompareGroup } from '../core/geometry.js';
import {
  PROJECTION_KINDS,
  PROJECTION_MODALITIES,
  PROJECTION_STATUSES,
} from '../core/contracts.js';
import { state } from '../core/state.js';
import { setManifestCollections } from '../core/state/viewer-commands.js';
import { RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE } from '../core/viewer-session-shape.js';

export const PROJECTION_MISSING_GEOMETRY = [
  'projectionMatrices',
  'sourceDetectorGeometry',
  'isocenter',
  'calibrationStatus',
];
export const MODAL_REQUIRED_URL_FIELDS = ['rawUrl', 'sliceUrlBase'];

export const SERIES_JOB_ID_FIELDS = ['job_id', 'sourceJobId'];
export const REQUIRED_SERIES_FIELDS = {
  slug: 'string',
  name: 'string',
  description: 'string',
  slices: 'integer',
  width: 'integer',
  height: 'integer',
  pixelSpacing: 'list',
  sliceThickness: 'number',
};
export const VECTOR_LENGTHS = {
  pixelSpacing: 2,
  firstIPP: 3,
  lastIPP: 3,
  orientation: 6,
  previewDims: 3,
};
export const AFFINE_COMPATIBILITY_VALUES = [
  'exact',
  'incompatible',
  'requires-registration',
  'within-tolerance',
];
export const RENDERABILITY_VALUES = ['2d', 'volume'];
export const GEOMETRY_RECORD_KINDS = [
  'cartesian_stack_irregular',
  'cartesian_volume',
  'insufficient',
  'single_frame',
];

const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const SERIES_BOOL_FIELDS = [
  'frameOfReferenceUIDConsistent',
  'hasAnalysis',
  'hasAskHistory',
  'hasBrain',
  'hasContext',
  'hasMaskRaw',
  'hasPreview',
  'hasRaw',
  'hasRegions',
  'hasSeg',
  'hasStats',
  'hasSym',
  'slicePositionsDistinct',
];

export function dumpSeriesContract() {
  return {
    requiredSeriesFields: { ...REQUIRED_SERIES_FIELDS },
    vectorLengths: { ...VECTOR_LENGTHS },
    optionalBoolFields: [...SERIES_BOOL_FIELDS],
    jobIdFields: [...SERIES_JOB_ID_FIELDS],
    affineCompatibilityValues: [...AFFINE_COMPATIBILITY_VALUES],
    renderabilityValues: [...RENDERABILITY_VALUES],
    geometryRecordKinds: [...GEOMETRY_RECORD_KINDS],
    projectionMissingGeometry: [...PROJECTION_MISSING_GEOMETRY],
    modalRequiredUrlFields: [...MODAL_REQUIRED_URL_FIELDS],
  };
}

function isSeriesContractRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function projectionKindForModality(modality) {
  return PROJECTION_MODALITIES.has(String(modality || '').toUpperCase()) ? 'xray' : 'unknown';
}

function ensureProjectionSets(manifest) {
  if (!Array.isArray(manifest.projectionSets)) manifest.projectionSets = [];
  return manifest.projectionSets;
}

function upsertById(list, record) {
  const idx = list.findIndex(item => item?.id === record.id);
  if (idx >= 0) list[idx] = record;
  else list.push(record);
}

function assertSafeProjectionSetId(id) {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || !SAFE_ID_RE.test(id)) {
    throw new Error(`Expected safe projection set id: ${id || 'missing'}`);
  }
}

function assertCalibratedProjectionGeometry(value, label = 'projection set') {
  if (value?.calibrationStatus !== 'calibrated') return;
  const matrices = value.projectionMatrices;
  if (!Array.isArray(matrices) || matrices.length !== Number(value.projectionCount)) {
    throw new Error(`${label}: calibrated sets require one matrix per projection`);
  }
  const detectorPixels = value.detectorPixels;
  if (!Array.isArray(detectorPixels) || detectorPixels.length !== 2
      || !detectorPixels.every(item => Number.isInteger(item) && item > 0)) {
    throw new Error(`${label}: calibrated sets require positive [rows, cols]`);
  }
  const detectorSpacing = value.detectorSpacingMm;
  if (!Array.isArray(detectorSpacing) || detectorSpacing.length !== 2
      || !detectorSpacing.every(item => Number(item) > 0)) {
    throw new Error(`${label}: calibrated sets require positive [row, col] spacing`);
  }
  if (!String(value.frameOfReferenceUID || '').trim()) {
    throw new Error(`${label}: calibrated sets require FrameOfReferenceUID`);
  }
}

function assertSeriesBooleanFields(entry) {
  for (const key of SERIES_BOOL_FIELDS) {
    if (key in entry && entry[key] !== true && entry[key] !== false) {
      throw new Error(`Cloud result ${key} must be a boolean`);
    }
  }
}

export function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function applyPublicSeriesUrls(entry, publicBase) {
  const out = { ...entry };
  const slug = String(out.slug || '').trim();
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base || !slug) return out;
  if (!out.sliceUrlBase) out.sliceUrlBase = `${base}/data/${slug}`;
  if (out.hasRaw && !out.rawUrl) out.rawUrl = `${base}/${slug}.raw.zst`;
  for (const [type, keys] of Object.entries(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)) {
    if (!keys.availableFlag || !out[keys.availableFlag]) continue;
    if (keys.publicUrlBaseField && !out[keys.publicUrlBaseField]) {
      out[keys.publicUrlBaseField] = `${base}/data/${slug}_${type}`;
    }
    if (keys.publicMetaUrlField && !out[keys.publicMetaUrlField]) {
      out[keys.publicMetaUrlField] = `${base}/data/${slug}_${type}.json`;
    }
  }
  if (out.hasStats && !out.statsUrl) out.statsUrl = `${base}/data/${slug}_stats.json`;
  return out;
}

function assertTrustedPublicSeriesUrls(entry, publicBase) {
  const base = String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('Cloud result requires r2PublicUrl to trust asset locations');
  const trustedOrigin = normalizeOrigin(base);
  for (const key of MODAL_REQUIRED_URL_FIELDS) {
    if (key === 'rawUrl' && !entry.hasRaw) continue;
    const origin = normalizeOrigin(entry[key] || '');
    if (!origin) throw new Error(`Cloud result is missing a trusted ${key}`);
    if (trustedOrigin && origin !== trustedOrigin) {
      throw new Error(
        key === 'rawUrl'
          ? 'Cloud result escaped the configured raw-volume origin'
          : `Cloud result escaped the configured R2 origin: ${origin}`,
      );
    }
  }
  if (entry.hasRegions) {
    const regionOrigin = normalizeOrigin(entry.regionUrlBase || '');
    const regionMetaOrigin = normalizeOrigin(entry.regionMetaUrl || '');
    if (!regionOrigin || !regionMetaOrigin) {
      throw new Error('Cloud result is missing trusted region overlay URLs');
    }
    if (trustedOrigin && (regionOrigin !== trustedOrigin || regionMetaOrigin !== trustedOrigin)) {
      throw new Error('Cloud result escaped the configured region-overlay origin');
    }
  }
  if (entry.hasStats) {
    const statsOrigin = normalizeOrigin(entry.statsUrl || '');
    if (!statsOrigin) throw new Error('Cloud result is missing a trusted statsUrl');
    if (trustedOrigin && statsOrigin !== trustedOrigin) {
      throw new Error('Cloud result escaped the configured stats origin');
    }
  }
}

export function projectionSetRecordForEntry(entry) {
  if (!entry?.isProjectionSet && entry?.geometryKind !== 'projectionSet') return null;
  const modality = String(entry.modality || 'OT').toUpperCase();
  const id = String(entry.id || entry.projectionSetId || `${entry.slug}_projection_set`).trim();
  assertSafeProjectionSetId(id);

  const record = {
    id,
    name: entry.name || id,
    sourceSeriesSlug: entry.slug,
    modality,
    projectionKind: entry.projectionKind || projectionKindForModality(modality),
    projectionCount: Number(entry.projectionCount || entry.slices || 0),
    reconstructionCapability: 'requires-reconstruction',
    reconstructionStatus: entry.reconstructionStatus || 'requires-calibration',
    renderability: '2d',
    missingGeometry: entry.missingGeometry || PROJECTION_MISSING_GEOMETRY,
  };
  for (const key of [
    'sourceStudyUID',
    'sourceSeriesUID',
    'frameOfReferenceUID',
    'bodyPart',
    'calibrationStatus',
    'projectionMatrices',
    'detectorPixels',
    'detectorSpacingMm',
    'projectionCalibration',
  ]) {
    if (entry[key]) record[key] = entry[key];
  }
  assertCalibratedProjectionGeometry(record, 'projection set');
  return record;
}

export function registerProjectionSet(manifest, entry) {
  const record = projectionSetRecordForEntry(entry);
  if (!record) return null;
  if (manifest === state.manifest) {
    const projectionSets = Array.isArray(manifest.projectionSets) ? manifest.projectionSets.slice() : [];
    upsertById(projectionSets, record);
    setManifestCollections({ projectionSets });
    return record;
  }
  upsertById(ensureProjectionSets(manifest), record);
  return record;
}

export function localDisplayEntryForImport(entry, projectionSetRecord) {
  if (!projectionSetRecord) return entry;
  return {
    ...entry,
    geometryKind: 'imageStack',
    reconstructionCapability: '2d-only',
    renderability: '2d',
    isProjectionSet: false,
    sourceProjectionSetId: projectionSetRecord.id,
  };
}

export function normalizeSeriesEntryForManifest(manifest, entry) {

  const next = withRegistrationDerivedBinding(manifest, { ...entry });
  if (next.group == null) next.group = seriesCompareGroup(next);
  if (next.sourceProjectionSetId) {
    const projectionId = String(next.sourceProjectionSetId);
    const projectionSets = Array.isArray(manifest?.projectionSets) ? manifest.projectionSets : [];
    if (!projectionSets.length) throw new Error('Imported series references unknown projection set: projectionSets registry is required');
    if (!projectionSets.some(item => item?.id === projectionId)) {
      throw new Error(`Imported series references unknown projection set: ${projectionId}`);
    }
  }
  return next;
}

function compactString(...values) {
  for (const value of values) {
    const next = String(value || '').trim();
    if (next) return next;
  }
  return '';
}

function seriesUidValues(series = {}) {
  return [
    series.sourceSeriesUID,
    series.seriesInstanceUID,
    series.seriesUID,
    series.uid,
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function registrationRecordForEntry(entry = {}) {
  if (isSeriesContractRecord(entry.registration)) return entry.registration;
  const report = isSeriesContractRecord(entry.engineReport) ? entry.engineReport : {};
  return isSeriesContractRecord(report.registration) ? report.registration : null;
}

function registrationInputForEntry(entry = {}) {
  if (isSeriesContractRecord(entry.registrationInput)) return entry.registrationInput;
  const report = isSeriesContractRecord(entry.engineReport) ? entry.engineReport : {};
  return isSeriesContractRecord(report.registrationInput) ? report.registrationInput : {};
}

function findRegistrationSourceSeries(manifest = {}, refs = []) {
  const candidates = (Array.isArray(manifest.series) ? manifest.series : [])
    .filter(series => series?.slug);
  for (const ref of refs.map(value => String(value || '').trim()).filter(Boolean)) {
    const bySlug = candidates.find(series => String(series.slug || '').trim() === ref);
    if (bySlug) return bySlug;
    const byUid = candidates.filter(series => seriesUidValues(series).includes(ref));
    if (byUid.length === 1) return byUid[0];
  }
  return null;
}

function hasEquivalentRegistrationBinding(bindings = [], sourceSlug = '') {
  return bindings.some(binding => binding?.derivedKind === 'registration'
    && String(binding.sourceSeriesSlug || '').trim() === sourceSlug);
}

function withRegistrationDerivedBinding(manifest, entry) {
  const registration = registrationRecordForEntry(entry);
  const registrationInput = registrationInputForEntry(entry);
  if (!registration && !Object.keys(registrationInput).length) return entry;

  const frameOfReferenceUID = compactString(entry.frameOfReferenceUID);
  if (!frameOfReferenceUID) return entry;
  const source = findRegistrationSourceSeries(manifest, [
    registration?.movingSeriesUID,
    registrationInput.movingSeriesUID,
    registration?.movingSlug,
    entry.sourceSeriesUID,
  ]);
  const sourceSlug = compactString(source?.slug);
  if (!sourceSlug || sourceSlug === compactString(entry.slug)) return entry;

  const bindings = Array.isArray(entry.derivedObjectBindings) ? entry.derivedObjectBindings.slice() : [];
  if (hasEquivalentRegistrationBinding(bindings, sourceSlug)) return entry;
  const binding = {
    derivedKind: 'registration',
    frameOfReferenceUID,
    sourceSeriesSlug: sourceSlug,
    requiresRegistration: true,
    affineCompatibility: 'requires-registration',
  };
  return { ...entry, derivedObjectBindings: [...bindings, binding] };
}

export function findExistingSeriesIndex(manifest, entry) {
  const matches = new Map();
  const slug = entry?.slug;
  const jobIds = new Set(SERIES_JOB_ID_FIELDS.map(key => entry?.[key]).filter(Boolean));
  for (let index = 0; index < manifest.series.length; index++) {
    const series = manifest.series[index];
    if (!series) continue;
    if (slug && series.slug === slug) matches.set(index, 'slug');
    if (jobIds.size && SERIES_JOB_ID_FIELDS.some(key => jobIds.has(series?.[key]))) matches.set(index, 'jobId');
  }
  if (matches.size > 1) {
    throw new Error(`Imported series matches multiple existing entries: ${[...matches.keys()].join(', ')}`);
  }
  return matches.size ? [...matches.keys()][0] : -1;
}

export function mergeSeriesIntoManifest(manifest, entry) {
  const normalizedEntry = normalizeSeriesEntryForManifest(manifest, entry);
  const existingIdx = findExistingSeriesIndex(manifest, normalizedEntry);
  if (existingIdx >= 0) manifest.series[existingIdx] = { ...manifest.series[existingIdx], ...normalizedEntry };
  else manifest.series.push(normalizedEntry);
  return existingIdx >= 0 ? existingIdx : manifest.series.length - 1;
}

export function normalizeCloudProjectionSetEntry(entry, seriesEntry = null) {
  if (!isSeriesContractRecord(entry)) throw new Error('Cloud result is missing a projection set entry');
  const normalized = { ...entry };
  normalized.id = String(normalized.id || normalized.projectionSetId || '').trim();
  assertSafeProjectionSetId(normalized.id);
  normalized.slug = String(normalized.slug || normalized.id).trim();
  assertSafeProjectionSetId(normalized.slug);
  normalized.name = String(normalized.name || normalized.id).trim();
  if (!normalized.name) throw new Error('Cloud projection set is missing a name');
  normalized.modality = String(normalized.modality || '').trim();
  if (!normalized.modality) throw new Error('Cloud projection set is missing a modality');
  normalized.projectionKind = String(normalized.projectionKind || '').trim();
  if (!PROJECTION_KINDS.has(normalized.projectionKind)) {
    throw new Error(`Cloud projection set has invalid projectionKind: ${normalized.projectionKind || 'missing'}`);
  }
  normalized.reconstructionStatus = String(normalized.reconstructionStatus || '').trim();
  if (!PROJECTION_STATUSES.has(normalized.reconstructionStatus)) {
    throw new Error(`Cloud projection set has invalid reconstructionStatus: ${normalized.reconstructionStatus || 'missing'}`);
  }
  normalized.projectionCount = Number(normalized.projectionCount);
  if (!Number.isInteger(normalized.projectionCount) || normalized.projectionCount <= 0) {
    throw new Error('Cloud projection set has invalid projectionCount');
  }
  if ((normalized.reconstructionCapability || 'requires-reconstruction') !== 'requires-reconstruction') {
    throw new Error('Cloud projection set must require reconstruction');
  }
  normalized.reconstructionCapability = 'requires-reconstruction';
  if ((normalized.renderability || '2d') !== '2d') {
    throw new Error('Cloud projection set must remain 2d');
  }
  normalized.renderability = '2d';
  if (seriesEntry?.sourceProjectionSetId && normalized.id !== seriesEntry.sourceProjectionSetId) {
    throw new Error(`Cloud projection set id mismatch: ${normalized.id} vs ${seriesEntry.sourceProjectionSetId}`);
  }
  assertCalibratedProjectionGeometry(normalized, 'Cloud projection set');
  return normalized;
}

export function attachSeriesJobIdentity(entry, jobId) {
  if (!entry) return null;
  if (!jobId || SERIES_JOB_ID_FIELDS.some(key => entry[key])) return entry;
  return { ...entry, sourceJobId: jobId };
}

export function normalizeCloudSeriesEntry(entry, { publicBase = '' } = {}) {
  if (!isSeriesContractRecord(entry)) throw new Error('Cloud result is missing a series entry');
  const normalized = applyPublicSeriesUrls({
    hasBrain: false,
    hasSeg: false,
    hasSym: false,
    hasRegions: false,
    hasStats: false,
    hasAnalysis: false,
    hasMaskRaw: false,
    hasRaw: false,
    hasPreview: false,
    hasContext: false,
    hasAskHistory: false,
    ...entry,
  }, publicBase);
  assertSeriesBooleanFields(normalized);
  if (!normalized.slug || !normalized.name || !normalized.description) {
    throw new Error('Cloud result is missing required series metadata');
  }
  for (const key of ['slices', 'width', 'height']) {
    if (!Number.isInteger(normalized[key]) || normalized[key] <= 0) {
      throw new Error(`Cloud result has an invalid ${key}`);
    }
  }
  if (!Array.isArray(normalized.pixelSpacing) || normalized.pixelSpacing.length !== 2
      || normalized.pixelSpacing.some(value => !(Number(value) > 0))) {
    throw new Error('Cloud result has invalid pixel spacing');
  }
  if (!(Number(normalized.sliceThickness) > 0)) {
    throw new Error('Cloud result has invalid slice thickness');
  }
  assertTrustedPublicSeriesUrls(normalized, publicBase);
  return normalized;
}

export function normalizeCompleteSlug(status = {}, seriesEntry = null) {
  const statusSlug = String(status.slug || '').trim();
  const entrySlug = String(seriesEntry?.slug || '').trim();
  if (statusSlug && entrySlug && statusSlug !== entrySlug) {
    throw new Error(`Cloud result slug mismatch: ${statusSlug} vs ${entrySlug}`);
  }
  const slug = statusSlug || entrySlug;
  if (!slug) throw new Error('Cloud result is missing a completed slug');
  return slug;
}
