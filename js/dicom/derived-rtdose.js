import { normalizeModality } from './dicom-meta.js';
import { seqFirst } from './derived-common.js';

export function rtdoseSourceSeriesUID(meta) {
  const source = seqFirst(meta?.ReferencedSeriesSequence);
  return String(source?.SeriesInstanceUID || '');
}

export function buildRtDoseImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'RTDOSE') return null;
  const rows = Number(meta?.Rows || 0);
  const cols = Number(meta?.Columns || 0);
  const frames = Number(meta?.NumberOfFrames || 1);
  const scaling = Number(meta?.DoseGridScaling || 0);
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
      doseGridScaling: Number.isFinite(scaling) ? scaling : 0,
      doseUnits,
      doseType,
      doseSummationType: summationType,
      frameOfReferenceUID: String(meta?.FrameOfReferenceUID || sourceSeries?.frameOfReferenceUID || ''),
    },
  };
}
