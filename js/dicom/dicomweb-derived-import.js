import { DCMJS_IMPORT_URL } from '../core/dependencies.js';
import {
  applyDerivedDataset,
  applyDerivedSr,
} from './dicom-derived-import.js';
import { isDerivedObjectModality } from './dicom-import-routing.js';
import { normalizeModality } from './dicom-meta.js';
import {
  fetchSeriesItems,
  fetchSeriesMetadataJson,
  normalizeInstances,
} from './dicomweb/dicomweb-source.js';

function naturalizeDicomJsonInstances(rawInstances, dcmjs) {
  return rawInstances.map((instance) => dcmjs.data.DicomMetaDictionary.naturalizeDataset(instance));
}

export async function importDicomwebDerivedObject({
  wadoBase,
  studyUID,
  seriesUID,
  headers = {},
  fetchImpl,
  signal,
  manifest,
  isActive = () => true,
}) {
  const rawInstances = await fetchSeriesMetadataJson({ wadoBase, studyUID, seriesUID, headers, fetchImpl, signal });
  if (!isActive()) return { skipped: true, reason: 'DICOMweb import session ended' };
  const dcmjs = await import(DCMJS_IMPORT_URL);
  if (!isActive()) return { skipped: true, reason: 'DICOMweb import session ended' };
  const metas = naturalizeDicomJsonInstances(rawInstances, dcmjs);
  const frameMetas = normalizeInstances(rawInstances);
  const first = metas[0] || {};
  const modality = normalizeModality(first.Modality);
  if (!isDerivedObjectModality(modality)) {
    throw new Error(`DICOMweb series ${seriesUID} is not a supported derived object`);
  }
  if (modality === 'SEG') {
    const items = await fetchSeriesItems({ wadoBase, studyUID, seriesUID, headers, fetchImpl, signal, metadata: frameMetas });
    if (!isActive()) return { skipped: true, reason: 'DICOMweb import session ended' };
    const transferSyntaxUID = String(items[0]?.meta?.TransferSyntaxUID || '');
    const consistentTransferSyntax = transferSyntaxUID
      && items.every((item) => String(item?.meta?.TransferSyntaxUID || '') === transferSyntaxUID);
    const dataset = {
      meta: {
        ...first,
        TransferSyntaxUID: consistentTransferSyntax ? transferSyntaxUID : '',
      },
      pixelData: { Value: items.map((item) => item.pixelData?.Value?.[0]).filter(Boolean) },
    };
    return { modality, ...applyDerivedDataset(manifest, dataset) };
  }
  if (!isActive()) return { skipped: true, reason: 'DICOMweb import session ended' };
  if (modality === 'RTSTRUCT') {
    return { modality, ...applyDerivedDataset(manifest, { meta: first }) };
  }
  if (modality === 'RTDOSE') {
    return { modality, ...applyDerivedDataset(manifest, { meta: first }) };
  }
  return { modality, ...applyDerivedSr(manifest, first) };
}
