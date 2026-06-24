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
} from './derived-sr.js';
import { buildRtDoseImport, rtdoseSourceSeriesUID } from './derived-rtdose.js';

export { buildSegOverlayImport } from './derived-seg.js';
export { buildRTStructImport } from './derived-rtstruct.js';
export { buildSRImport } from './derived-sr.js';
export { buildRtDoseImport } from './derived-rtdose.js';
export { hydrateDerivedStateForSeries } from './derived-hydrate.js';

export async function readLocalDicomObjects(files = [], dcmjsModule = null) {
  const dcmjs = dcmjsModule || await import(DCMJS_IMPORT_URL);
  const DicomMessage = dcmjs.data.DicomMessage;
  const out = [];
  const skipped = [];
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer();
      const ds = DicomMessage.readFile(ab);
      const meta = dcmjs.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
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
  const sourceRef = sourceSeriesFromUIDOrFrameOfReference(
    manifest,
    sourceUid,
    String(meta?.FrameOfReferenceUID || ''),
  );
  if (!sourceRef) {
    if (modality === 'SR') return { skipped: true, reason: 'SR import needs a loaded source series with a matching slug/series context' };
    return { skipped: true, reason: `No loaded source series matches derived-object references (uid=${sourceUid || '(missing)'}, for=${String(meta?.FrameOfReferenceUID || '(missing)')})` };
  }

  if (modality === 'SEG') {
    const overlay = buildSegOverlayImport(dataset, sourceRef.series);
    if (!overlay) return { skipped: true, reason: 'SEG import produced no overlay' };
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
    const dose = buildRtDoseImport(meta, sourceRef.series);
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
  const sourceSeries = (manifest?.series || []).find((series) => series?.slug === sourceSlug);
  if (!sourceSeries) {
    return { skipped: true, reason: `No loaded source series matches SR reference ${sourceSlug || '(missing)'}` };
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
    summaries.push({ modality, ...result });
  }
  return summaries.concat(skipped);
}
