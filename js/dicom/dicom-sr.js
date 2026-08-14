// DICOM Structured Report (TID 1500) export — loader + download; see dicom-sr-*.js.

import { DCMJS_IMPORT_URL } from '../core/dependencies.js';
import { collectMeasurements } from './dicom-sr-collect.js';
import { buildSRDataset } from './dicom-sr-dataset.js';

export async function exportDicomSR(host) {
  const bundle = collectMeasurements(host);
  if (!bundle.measurements.length) {
    throw new Error('Nothing to export — make a measurement, ROI, or annotation first.');
  }

  const dcmjs = await import(DCMJS_IMPORT_URL);
  const dataset = buildSRDataset(bundle);

  const DicomMetaDictionary = dcmjs.data.DicomMetaDictionary;
  const dict = new dcmjs.data.DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  const buffer = dict.write();

  const blob = new Blob([buffer], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const studyDate = host.manifest.studyDate || 'unknown';
  a.download = `${bundle.slug}_measurements_${studyDate.replace(/-/g, '')}.dcm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  return { count: bundle.measurements.length, filename: a.download };
}

export function hasExportableMeasurements(host) {
  const bundle = collectMeasurements(host);
  return bundle.measurements.length;
}
