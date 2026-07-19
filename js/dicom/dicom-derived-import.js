import { state } from '../core/state.js';
import { DCMJS_IMPORT_URL } from '../core/dependencies.js';
import { isDerivedObjectModality } from './dicom-import-routing.js';
import { normalizeModality } from './dicom-meta.js';
import {
  appendAnnotations,
  appendRois,
  DICOM_PARSE_FAILED_REASON,
  localFileLabel,
  rememberDerivedObject,
  sourceSeriesFromUIDOrFrameOfReference,
} from './derived-common.js';
import {
  attachRegionOverlay,
  buildSegOverlayImport,
  preflightRegionOverlayAttachment,
  segSourceSeriesUID,
  serializeSegPayload,
} from './derived-seg.js';
import {
  buildRTStructImport,
  rtstructNoContoursResult,
  rtstructSourceSeriesUID,
} from './derived-rtstruct.js';
import {
  buildSRImport,
  collectMeasurementGroups,
  contentItems,
  itemMeaning,
  parseViewerSrReference,
  referencedSeriesUID,
} from './derived-sr.js';
import { buildRtDoseImport, rtdoseSourceSeriesUID } from './derived-rtdose.js';

export { buildSegOverlayImport } from './derived-seg.js';
export { buildRTStructImport } from './derived-rtstruct.js';
export { buildSRImport } from './derived-sr.js';
export { buildRtDoseImport } from './derived-rtdose.js';
export { hydrateDerivedStateForSeries } from './derived-hydrate.js';

const MAX_PENDING_DERIVED_OBJECTS = 32;
const MAX_PENDING_DERIVED_BYTES = 256 * 1024 * 1024;

function pendingObjectKey(dataset = {}) {
  const meta = dataset.meta || {};
  const modality = normalizeModality(meta.Modality);
  const identity = String(meta.SOPInstanceUID || meta.SeriesInstanceUID || localFileLabel(dataset.file));
  return `${modality}:${identity}`;
}

function pendingObjectBytes(dataset = {}) {
  const size = Number(dataset.file?.size || 0);
  return Number.isSafeInteger(size) && size > 0 ? size : 0;
}

export function queuePendingDerivedObject(dataset) {
  const pending = state._pendingDerivedObjects || (state._pendingDerivedObjects = []);
  const key = pendingObjectKey(dataset);
  const existing = pending.find((item) => item.key === key);
  if (existing) return { accepted: true, duplicate: true, key, pendingCount: pending.length };
  if (pending.length >= MAX_PENDING_DERIVED_OBJECTS) {
    return { accepted: false, reason: `Pending derived-object limit (${MAX_PENDING_DERIVED_OBJECTS}) reached` };
  }
  const bytes = pendingObjectBytes(dataset);
  const retainedBytes = pending.reduce((sum, item) => sum + item.bytes, 0);
  if (bytes > MAX_PENDING_DERIVED_BYTES || retainedBytes + bytes > MAX_PENDING_DERIVED_BYTES) {
    return { accepted: false, reason: `Pending derived objects exceed the ${MAX_PENDING_DERIVED_BYTES} byte session budget` };
  }
  pending.push({ key, bytes, dataset });
  return { accepted: true, duplicate: false, key, pendingCount: pending.length };
}

export function retryPendingDerivedObjects(manifest) {
  const pending = state._pendingDerivedObjects || [];
  if (!pending.length) return [];
  const remaining = [];
  const results = [];
  for (const item of pending) {
    const modality = normalizeModality(item.dataset?.meta?.Modality);
    const result = modality === 'SR'
      ? applyDerivedSr(manifest, item.dataset.meta)
      : applyDerivedDataset(manifest, item.dataset);
    if (result.reasonCode === 'source_not_loaded') remaining.push(item);
    else results.push({ modality, pendingKey: item.key, ...result });
  }
  state._pendingDerivedObjects = remaining;
  return results;
}

export async function readLocalDicomObjects(files = [], dcmjsModule = null) {
  const dcmjs = dcmjsModule || await import(DCMJS_IMPORT_URL);
  const DicomMessage = dcmjs.data.DicomMessage;
  const out = [];
  const skipped = [];
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer();
      const ds = DicomMessage.readFile(ab);
      const meta = {
        ...dcmjs.data.DicomMetaDictionary.naturalizeDataset(ds.dict),
        TransferSyntaxUID: ds.meta?.['00020010']?.Value?.[0] || '',
      };
      out.push({ meta, pixelData: ds.dict['7FE00010'], file });
    } catch {
      skipped.push({ skipped: true, file: localFileLabel(file), reason: DICOM_PARSE_FAILED_REASON });
    }
  }
  return { objects: out, skipped };
}

export function applyDerivedDataset(manifest, dataset) {
  const meta = dataset?.meta || {};
  const modality = normalizeModality(meta.Modality);
  let sourceUid = '';
  if (modality === 'SEG') sourceUid = segSourceSeriesUID(meta);
  else if (modality === 'RTSTRUCT') sourceUid = rtstructSourceSeriesUID(meta);
  else if (modality === 'RTDOSE') sourceUid = rtdoseSourceSeriesUID(meta);
  const frameOfReferenceUID = String(meta?.FrameOfReferenceUID || '').trim();
  if (!sourceUid && !frameOfReferenceUID) {
    return {
      skipped: true,
      reasonCode: 'source_reference_missing',
      reason: `${modality || 'Derived object'} has no usable source SeriesInstanceUID or FrameOfReferenceUID`,
    };
  }
  const sourceRef = sourceSeriesFromUIDOrFrameOfReference(
    manifest,
    sourceUid,
    frameOfReferenceUID,
  );
  if (!sourceRef) {
    if (modality === 'SR') return { skipped: true, reasonCode: 'source_not_loaded', reason: 'SR import needs a loaded source series with a matching slug/series context' };
    return { skipped: true, reasonCode: 'source_not_loaded', reason: `No loaded source series matches derived-object references (uid=${sourceUid || '(missing)'}, for=${String(meta?.FrameOfReferenceUID || '(missing)')})` };
  }

  if (modality === 'SEG') {
    let overlay = null;
    try {
      overlay = buildSegOverlayImport(dataset, sourceRef.series);
    } catch (error) {
      return {
        skipped: true,
        reason: error?.message || 'seg_import_rejected',
        sourceSlug: sourceRef.series.slug,
        kind: 'seg',
      };
    }
    if (!overlay) return { skipped: true, reason: 'SEG import produced no overlay' };
    try {
      // The region slot is shared runtime state. Check it before recording a
      // durable object so a rejected SEG cannot be restored on a later load.
      preflightRegionOverlayAttachment(sourceRef.series);
    } catch (error) {
      return {
        skipped: true,
        reason: error?.message || 'seg_attachment_rejected',
        sourceSlug: sourceRef.series.slug,
        kind: 'seg',
      };
    }
    const payload = serializeSegPayload(overlay.labelSlices, overlay.regionMeta);
    const remember = rememberDerivedObject(sourceRef.series, meta, 'seg', overlay.name, payload, 'source-compatible');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'seg' };
    const attached = attachRegionOverlay(sourceRef.series, overlay);
    return { skipped: false, ...attached, sourceSlug: sourceRef.series.slug, kind: 'seg', persisted: remember.persisted };
  }
  if (modality === 'RTSTRUCT') {
    const overlay = buildRTStructImport(meta, sourceRef.series);
    if (!overlay) return { skipped: true, reason: 'RTSTRUCT import produced no planar contours' };
    if (!Object.keys(overlay.roisBySlice || {}).length) {
      return {
        skipped: true,
        sourceSlug: sourceRef.series.slug,
        kind: 'rtstruct',
        ...rtstructNoContoursResult(overlay.skippedReasonCounts || {}),
      };
    }
    const remember = rememberDerivedObject(sourceRef.series, meta, 'rtstruct', overlay.name, {
      format: 'rtstruct-summary-v1',
      contourSlices: Object.keys(overlay.roisBySlice).length,
    }, 'source-compatible');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'rtstruct' };
    const appended = appendRois(sourceRef.series, remember.objectUID, overlay.roisBySlice);
    return { skipped: false, ...appended, sourceSlug: sourceRef.series.slug, kind: 'rtstruct', persisted: remember.persisted };
  }
  if (modality === 'RTDOSE') {
    let dose = null;
    try {
      dose = buildRtDoseImport(meta, sourceRef.series);
    } catch (error) {
      return {
        skipped: true,
        reason: error?.message || 'rtdose_import_rejected',
        sourceSlug: sourceRef.series.slug,
        kind: 'rtdose',
      };
    }
    if (!dose) return { skipped: true, reason: 'RTDOSE import produced no summary' };
    const remember = rememberDerivedObject(sourceRef.series, meta, 'rtdose', dose.name, dose.summary, 'frame-only');
    if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceRef.series.slug, kind: 'rtdose' };
    state._localRtDoseBySlug[sourceRef.series.slug] = state._localRtDoseBySlug[sourceRef.series.slug] || [];
    state._localRtDoseBySlug[sourceRef.series.slug].push({
      objectUID: remember.objectUID,
      name: dose.name,
      summary: dose.summary,
    });
    return { skipped: false, count: 1, sourceSlug: sourceRef.series.slug, kind: 'rtdose', persisted: remember.persisted };
  }
  return { skipped: true, reason: `Unsupported derived modality ${modality}` };
}

export function applyDerivedSr(manifest, meta) {
  const groups = collectMeasurementGroups(meta);
  if (!groups.length) return { skipped: true, reason: 'SR import contains no measurement groups' };
  const sourceText = contentItems(groups[0]).find((item) => itemMeaning(item) === 'Referenced Series');
  const reference = parseViewerSrReference(sourceText);
  if (!reference) {
    return { skipped: true, reason: 'SR import currently supports only VoxelLab viewer-exported measurement notes with explicit "<slug> slice N" references' };
  }
  const sourceSlug = reference.sourceSlug;
  const sourceUid = referencedSeriesUID(meta, groups[0]);
  const sourceSeries = sourceUid
    ? sourceSeriesFromUIDOrFrameOfReference(manifest, sourceUid, '')?.series
    : (manifest?.series || []).find((series) => series?.slug === sourceSlug);
  if (!sourceSeries) {
    return sourceUid
      ? { skipped: true, reasonCode: 'source_not_loaded', reason: `No loaded source series matches SR SeriesInstanceUID ${sourceUid}` }
      : { skipped: true, reasonCode: 'source_reference_missing', reason: `SR reference ${sourceSlug || '(missing)'} has no stable SeriesInstanceUID for deferred attachment` };
  }
  let sr = null;
  try {
    sr = buildSRImport(meta, sourceSeries);
  } catch (error) {
    return { skipped: true, reason: error?.message || 'SR import rejected unsupported measurement encoding' };
  }
  if (!sr) return { skipped: true, reason: 'SR import produced no annotations' };
  const remember = rememberDerivedObject(sourceSeries, meta, 'sr', sr.name, {
    format: 'sr-summary-v1',
    annotationSlices: Object.keys(sr.annotationsBySlice).length,
  }, 'source-compatible');
  if (!remember.accepted) return { skipped: true, reason: `Derived object ${remember.objectUID} already imported`, sourceSlug: sourceSeries.slug, kind: 'sr' };
  const appended = appendAnnotations(sourceSeries, remember.objectUID, sr.annotationsBySlice);
  return { skipped: false, ...appended, sourceSlug: sourceSeries.slug, kind: 'sr', persisted: remember.persisted };
}

export async function importLocalDerivedObjects(files, manifest, onProgress = () => {}) {
  onProgress('derived', 'reading derived objects...');
  const { objects, skipped } = await readLocalDicomObjects(files);
  const summaries = [];
  for (const dataset of objects) {
    const modality = normalizeModality(dataset?.meta?.Modality);
    if (!isDerivedObjectModality(modality)) continue;
    const result = modality === 'SR'
      ? applyDerivedSr(manifest, dataset.meta)
      : applyDerivedDataset(manifest, dataset);
    if (result.reasonCode === 'source_not_loaded') {
      const queued = queuePendingDerivedObject(dataset);
      summaries.push({
        modality,
        skipped: true,
        pending: queued.accepted,
        reason: queued.accepted
          ? `${localFileLabel(dataset.file)} is waiting for its matching source series in this session`
          : queued.reason,
      });
    } else {
      summaries.push({ modality, ...result });
    }
  }
  return summaries.concat(skipped);
}
