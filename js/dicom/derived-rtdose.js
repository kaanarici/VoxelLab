import { normalizeModality } from './dicom-meta.js';
import { seqFirst } from './derived-common.js';

export function rtdoseSourceSeriesUID(meta) {
  const source = seqFirst(meta?.ReferencedSeriesSequence);
  return String(source?.SeriesInstanceUID || '');
}

function requiredPositiveInteger(meta, field) {
  const value = Number(meta?.[field]);
  if (!(Number.isSafeInteger(value) && value > 0)) throw new Error(`rtdose_invalid_${field}`);
  return value;
}

function requiredPositiveFinite(meta, field) {
  const value = Number(meta?.[field]);
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`rtdose_invalid_${field}`);
  return value;
}

export function buildRtDoseImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'RTDOSE') return null;
  const doseFrameOfReferenceUID = String(meta?.FrameOfReferenceUID || '').trim();
  const sourceFrameOfReferenceUID = String(sourceSeries?.frameOfReferenceUID || '').trim();
  if (!doseFrameOfReferenceUID || !sourceFrameOfReferenceUID) {
    throw new Error('rtdose_frame_of_reference_missing');
  }
  if (doseFrameOfReferenceUID !== sourceFrameOfReferenceUID) {
    throw new Error('rtdose_frame_of_reference_mismatch');
  }
  const rows = requiredPositiveInteger(meta, 'Rows');
  const cols = requiredPositiveInteger(meta, 'Columns');
  const frames = meta?.NumberOfFrames == null || meta.NumberOfFrames === ''
    ? 1
    : requiredPositiveInteger(meta, 'NumberOfFrames');
  const scaling = requiredPositiveFinite(meta, 'DoseGridScaling');
  const doseUnits = String(meta?.DoseUnits || '').trim();
  const doseType = String(meta?.DoseType || '').trim();
  const summationType = String(meta?.DoseSummationType || '').trim();
  return {
    kind: 'rtdose',
    name: String(meta?.SeriesDescription || meta?.SeriesInstanceUID || 'RTDOSE import'),
    summary: {
      format: 'rtdose-summary-v1',
      rows,
      cols,
      frames,
      doseGridScaling: scaling,
      doseUnits,
      doseType,
      doseSummationType: summationType,
      frameOfReferenceUID: doseFrameOfReferenceUID,
    },
  };
}
