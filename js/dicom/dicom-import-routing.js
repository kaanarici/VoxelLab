import { getStr, normalizeModality } from './dicom-meta.js';
import { assertDICOMActualFileBytes, isDICOMResourceLimit } from './dicom-import-resources.js';

const DERIVED_OBJECT_MODALITIES = new Set(['SEG', 'RTSTRUCT', 'SR', 'RTDOSE']);

function looksLikeSourceManifest(payload) {
  return payload && typeof payload === 'object'
    && (payload.sourceKind === 'projection' || payload.sourceKind === 'ultrasound');
}

export async function parseSourceManifests(files = [], { onActualFileBytes = null } = {}) {
  const bySeriesUID = new Map();
  for (const [index, file] of files.entries()) {
    if (!/\.json$/i.test(file?.name || '')) continue;
    try {
      const bytes = await file.arrayBuffer();
      assertDICOMActualFileBytes(bytes.byteLength, file, index);
      onActualFileBytes?.(bytes.byteLength, file, index);
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (!looksLikeSourceManifest(payload)) continue;
      const key = String(payload.seriesUID || '');
      if (key) bySeriesUID.set(key, payload);
    } catch (error) {
      if (isDICOMResourceLimit(error)) throw error;
      // Ignore non-source JSON attachments.
    }
  }
  return bySeriesUID;
}

/** Build a stable DICOM series grouping key from study + series identifiers. */
export function dicomSeriesGroupKey(meta) {
  const study = getStr(meta, 'StudyInstanceUID', 'study');
  const fallback = [
    getStr(meta, 'SeriesNumber'),
    getStr(meta, 'SeriesDescription'),
    getStr(meta, 'Modality'),
  ].filter(Boolean).join('|') || 'series';
  const series = getStr(meta, 'SeriesInstanceUID') || fallback;
  return `${study}|${series}`;
}

export function groupDatasetsBySeries(datasets) {
  const groups = [];
  const byKey = new Map();
  for (const item of datasets) {
    const key = dicomSeriesGroupKey(item.meta);
    let group = byKey.get(key);
    if (!group) {
      group = { key, datasets: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.datasets.push(item);
  }
  return groups;
}

export function isDerivedObjectModality(modality) {
  return DERIVED_OBJECT_MODALITIES.has(normalizeModality(modality));
}
