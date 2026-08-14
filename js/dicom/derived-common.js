import { state } from '../core/state.js';
import {
  dot3,
  geometryFromSeries,
  isOrthonormalImagePlane,
  numberList as geometryNumberList,
  orientationFromIOP,
  patientLpsToVoxel,
} from '../core/geometry.js';
import {
  buildDerivedRegistryEntry,
  getDerivedRegistryEntry,
  upsertDerivedRegistryEntry,
} from '../derived-objects.js';
import {
  nextDrawingEntryId,
  noteEntriesForSlice,
  roiEntriesForSlice,
  setNoteEntriesForSlice,
  setRoiEntriesForSlice,
} from '../overlay/annotation-graph.js';
import { normalizeModality } from './dicom-meta.js';

export const DICOM_PARSE_FAILED_REASON = 'dicom_parse_failed';
export const RTSTRUCT_NO_USABLE_CONTOURS_REASON = 'rtstruct_no_usable_contours';

export function numberList(value, length = 0) {
  return geometryNumberList(value, length);
}

export function sourceSeriesFromUIDOrFrameOfReference(manifest, sourceUID, frameOfReferenceUID) {
  if (sourceUID) {
    const byUid = findSeriesByUID(manifest, sourceUID);
    if (byUid) return byUid;
  }
  if (!frameOfReferenceUID) return null;
  const matches = (manifest?.series || [])
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => String(series?.frameOfReferenceUID || '') === frameOfReferenceUID);
  if (matches.length === 1) return matches[0];
  return null;
}

export function positiveSpacing2(value) {
  const spacing = numberList(value, 2);
  return spacing[0] > 0 && spacing[1] > 0 ? spacing : null;
}

export function sameNumber(a, b, tolerance = 1e-3) {
  const left = Number(a);
  const right = Number(b);
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * tolerance);
}

export function sameOrientation(frameIop, sourceIop) {
  if (!isOrthonormalImagePlane(frameIop) || !isOrthonormalImagePlane(sourceIop)) return false;
  const frame = orientationFromIOP(frameIop);
  const source = orientationFromIOP(sourceIop);
  return dot3(frame.row, source.row) >= 0.999 && dot3(frame.col, source.col) >= 0.999;
}

function knownSliceSpacing(series) {
  let slice = Number(series?.sliceSpacing || series?.sliceThickness || 0);
  if (!(slice > 0)) {
    const first = numberList(series?.firstIPP, 3);
    const last = numberList(series?.lastIPP, 3);
    const slices = Number(series?.slices || 0);
    if (first.length >= 3 && last.length >= 3 && slices > 1) {
      slice = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) / (slices - 1);
    }
  }
  return slice > 0 ? slice : null;
}

export function sourceGridSpacing(series) {
  if (series?.sliceSpacingRegular === false) return null;
  const spacing = positiveSpacing2(series?.pixelSpacing);
  const slice = knownSliceSpacing(series);
  if (!spacing || !(slice > 0)) return null;
  return { row: spacing[0], col: spacing[1], slice };
}

export function sourceContourGridReady(series) {
  const first = numberList(series?.firstIPP, 3);
  const last = numberList(series?.lastIPP, 3);
  return !!sourceGridSpacing(series)
    && isOrthonormalImagePlane(series?.orientation)
    && first.length >= 3
    && last.length >= 3
    && Number(series?.slices || 0) > 0;
}

export function voxelPointForLps(series, lps) {
  return patientLpsToVoxel(series, lps);
}

export function seqFirst(value) {
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

export function bytesFromValue(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') {
    const binary = globalThis.atob ? globalThis.atob(value) : '';
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(0);
}

function findSeriesByUID(manifest, seriesUID) {
  const index = (manifest?.series || []).findIndex((series) => series?.sourceSeriesUID === seriesUID);
  return index >= 0 ? { index, series: manifest.series[index] } : null;
}

export function sliceIndexForIPP(series, ipp, toleranceMm = 1.2) {
  const voxelPoint = voxelPointForLps(series, ipp);
  if (!voxelPoint) return -1;
  const [, , z] = voxelPoint;
  const rounded = Math.round(z);
  return Math.abs(z - rounded) <= toleranceMm / Math.max(geoSliceSpacing(series), 1e-6)
    ? Math.max(0, Math.min(series.slices - 1, rounded))
    : -1;
}

export function geoSliceSpacing(series) {
  const geo = geometryFromSeries(series);
  return geo.sliceSpacing || series.sliceSpacing || series.sliceThickness || 1;
}

export function emptyLabelSlices(width, height, depth) {
  return Array.from({ length: depth }, () => new Uint8Array(width * height));
}

export function sourceSeriesDerivedState(series) {
  state._localDerivedObjects[series.slug] = state._localDerivedObjects[series.slug] || {};
  return state._localDerivedObjects[series.slug];
}

function objectUIDForMeta(meta, fallbackKind = 'derived') {
  return String(meta?.SOPInstanceUID || meta?.SeriesInstanceUID || `${fallbackKind}:${meta?.SeriesDescription || 'object'}`);
}

function derivedSeriesForBinding(sourceSeries, meta, geometryKind = 'source-compatible') {
  const frameOfReferenceUID = String(meta?.FrameOfReferenceUID || sourceSeries?.frameOfReferenceUID || '');
  if (geometryKind === 'source-compatible') return { ...sourceSeries, frameOfReferenceUID };
  return { frameOfReferenceUID };
}

export function rememberDerivedObject(sourceSeries, meta, derivedKind, name, payload = null, geometryKind = 'source-compatible') {
  const objectUID = objectUIDForMeta(meta, derivedKind);
  if (getDerivedRegistryEntry(sourceSeries, objectUID)) return { accepted: false, objectUID };
  const entry = buildDerivedRegistryEntry({
    derivedKind,
    sourceSeries,
    derivedSeries: derivedSeriesForBinding(sourceSeries, meta, geometryKind),
    objectUID,
    name,
    modality: normalizeModality(meta?.Modality || derivedKind),
    payload,
  });
  const { persisted } = upsertDerivedRegistryEntry(entry);
  sourceSeriesDerivedState(sourceSeries)[objectUID] = { kind: derivedKind, name: entry.name };
  return { accepted: true, objectUID, persisted };
}

export function appendRois(sourceSeries, objectUID, roisBySlice) {
  for (const [sliceIndex, rois] of Object.entries(roisBySlice)) {
    const existing = roiEntriesForSlice(state, sourceSeries, sliceIndex);
    setRoiEntriesForSlice(state, sourceSeries, sliceIndex, existing.concat(rois));
  }
  return { skipped: false, count: Object.keys(roisBySlice).length };
}

export function appendAnnotations(sourceSeries, objectUID, annotationsBySlice) {
  for (const [sliceIndex, notes] of Object.entries(annotationsBySlice)) {
    const existing = noteEntriesForSlice(state, sourceSeries, sliceIndex);
    const nextId = nextDrawingEntryId(existing);
    setNoteEntriesForSlice(state, sourceSeries, sliceIndex, existing.concat(notes.map((note, index) => ({
      id: nextId + index,
      x: note.x,
      y: note.y,
      text: note.text,
      createdAt: Date.now(),
      sourceObjectUID: objectUID,
    }))));
  }
  return { skipped: false, count: Object.keys(annotationsBySlice).length };
}

export function incrementReason(reasonCounts, reason) {
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

export function localFileLabel(file = {}) {
  const relative = String(file.webkitRelativePath || '').replaceAll('\\', '/');
  if (relative) return relative.split('/').filter(Boolean).join('/');
  return String(file.name || file.path || 'selected file').replaceAll('\\', '/').split('/').filter(Boolean).pop() || 'selected file';
}
