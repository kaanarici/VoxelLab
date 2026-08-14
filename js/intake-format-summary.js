const CONVERTER_LABELS = new Map([
  ['czi', 'CZI'],
  ['nd2', 'ND2'],
  ['lif', 'LIF'],
  ['oib', 'OIB'],
  ['oif', 'OIF'],
  ['lsm', 'LSM'],
]);

function inputPath(item = {}) {
  return String(item.webkitRelativePath || item.relativePath || item.name || item.path || '').replaceAll('\\', '/');
}

function baseName(value = '') {
  return String(value || '').split('/').filter(Boolean).at(-1) || '';
}

function extension(name = '') {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.nii.gz')) return 'nii.gz';
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index + 1) : '';
}

export function intakeFormatLabel(item = {}) {
  if (item?.formatLabel) return String(item.formatLabel);
  const filePath = inputPath(item);
  const name = baseName(filePath).toLowerCase();
  if (/\.zarr(?:\/|$)/i.test(filePath)) return 'OME-Zarr';
  if (name.endsWith('.ome.tif') || name.endsWith('.ome.tiff')) return 'OME-TIFF';
  const ext = extension(name);
  if (ext === 'nii' || ext === 'nii.gz') return 'NIfTI';
  if (ext === 'dcm' || ext === 'dicom' || ext === 'ima') return 'DICOM';
  if (ext === 'tif' || ext === 'tiff') return 'TIFF/ImageJ TIFF';
  if (ext === 'roi') return 'ImageJ ROI';
  if (ext === 'zip') return 'ROI ZIP';
  if (ext === 'sr') return 'DICOM SR';
  if (ext === 'json') return 'JSON sidecar';
  if (CONVERTER_LABELS.has(ext)) return CONVERTER_LABELS.get(ext);
  return !ext && name ? 'DICOM candidate' : '';
}

export function intakeFormatSummary(items = [], { maxLabels = 4 } = {}) {
  const counts = new Map();
  for (const item of items || []) {
    const label = intakeFormatLabel(item);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const labels = [...counts.entries()];
  if (!labels.length) return '';
  const visible = labels.slice(0, maxLabels);
  const hiddenCount = labels.slice(maxLabels).reduce((sum, [, count]) => sum + count, 0);
  const parts = visible.map(([label, count]) => (count === 1 ? label : `${label} ${count}`));
  if (hiddenCount) parts.push(`${hiddenCount} other`);
  return parts.join(', ');
}

export function appendIntakeFormatSummary(text, items = []) {
  const summary = intakeFormatSummary(items);
  return summary ? `${text} (${summary})` : text;
}
