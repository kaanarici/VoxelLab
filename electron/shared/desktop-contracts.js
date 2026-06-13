import path from 'node:path';

export const DESKTOP_API_VERSION = 1;
export const APP_SCHEME = 'voxellab';
export const APP_HOST = 'app';
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

export const IPC = Object.freeze({
  appInfo: 'desktop:app-info',
  openFiles: 'desktop:open-files',
  openFolder: 'desktop:open-folder',
  getRecentDocuments: 'desktop:get-recent-documents',
  openRecentPath: 'desktop:open-recent-path',
  clearRecentDocuments: 'desktop:clear-recent-documents',
  recentDocumentsChanged: 'desktop:recent-documents-changed',
  readFileRange: 'desktop:read-file-range',
  getConverterCapabilities: 'desktop:get-converter-capabilities',
  startConversionJob: 'desktop:start-conversion-job',
  getConversionJob: 'desktop:get-conversion-job',
  cancelConversionJob: 'desktop:cancel-conversion-job',
  conversionJobChanged: 'desktop:conversion-job-changed',
  revealPath: 'desktop:reveal-path',
  windowState: 'desktop:window-state',
  windowStateChanged: 'desktop:window-state-changed',
  rendererReady: 'desktop:renderer-ready',
  menuCommand: 'desktop:menu-command',
  openPaths: 'desktop:open-paths',
});

export const MENU_COMMAND = Object.freeze({
  showUpload: 'show-upload',
  exportScreenshot: 'export-screenshot',
});

export const DESKTOP_SUPPORTED_INPUT_EXTENSIONS = Object.freeze([
  '.dcm',
  '.dicom',
  '.ima',
  '.nii',
  '.tif',
  '.tiff',
]);

export const DESKTOP_SIDECAR_INPUT_EXTENSIONS = Object.freeze([
  '.json',
  '.roi',
  '.sr',
  '.zip',
]);

export const DESKTOP_COMPOUND_INPUT_EXTENSIONS = Object.freeze([
  '.nii.gz',
  '.ome.tif',
  '.ome.tiff',
]);

export const DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS = Object.freeze([
  '.czi',
  '.nd2',
  '.lif',
  '.oib',
  '.oif',
  '.lsm',
]);

export const DESKTOP_OPEN_FILE_FILTER_EXTENSIONS = Object.freeze([
  ...DESKTOP_SUPPORTED_INPUT_EXTENSIONS,
  ...DESKTOP_SIDECAR_INPUT_EXTENSIONS,
  ...DESKTOP_COMPOUND_INPUT_EXTENSIONS,
  ...DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
].map(extension => extension.slice(1)));

export const DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS = Object.freeze(
  DESKTOP_SIDECAR_INPUT_EXTENSIONS.map(extension => extension.slice(1)),
);

const INPUT_EXTENSIONS = new Set([
  ...DESKTOP_SUPPORTED_INPUT_EXTENSIONS,
  ...DESKTOP_SIDECAR_INPUT_EXTENSIONS,
]);
const CONVERTIBLE_EXTENSIONS = new Set(DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS);
const CONVERTIBLE_FORMAT_LABELS = new Map([
  ['.czi', 'CZI'],
  ['.nd2', 'ND2'],
  ['.lif', 'LIF'],
  ['.oib', 'OIB'],
  ['.oif', 'OIF'],
  ['.lsm', 'LSM'],
]);

const IGNORED_DESKTOP_INPUT_FILENAMES = new Set(['.ds_store', 'thumbs.db']);

function pathParts(filePath) {
  return String(filePath || '').replaceAll('\\', '/').split('/').filter(Boolean);
}

function isBlockedFolderPart(part) {
  return part.startsWith('.') || part.toLowerCase() === '__macosx';
}

function hasBlockedAncestor(parts, endExclusive = parts.length - 1) {
  for (let index = 0; index < endExclusive; index += 1) {
    if (isBlockedFolderPart(parts[index])) return true;
  }
  return false;
}

export function isZarrMetadataFileName(name) {
  return ['.zattrs', '.zarray', '.zgroup', '.zmetadata', 'zarr.json'].includes(String(name || '').toLowerCase());
}

function isZarrChunkFileName(name) {
  return /^\d+(?:\.\d+)*$/.test(String(name || ''));
}

function isOmeZarrInputPath(filePath) {
  const parts = pathParts(filePath).map(part => part.toLowerCase());
  const zarrIndex = parts.findIndex(part => part.endsWith('.zarr'));
  if (zarrIndex < 0 || zarrIndex >= parts.length - 1) return false;
  if (hasBlockedAncestor(parts, zarrIndex)) return false;
  for (let index = zarrIndex + 1; index < parts.length - 1; index += 1) {
    if (isBlockedFolderPart(parts[index])) return false;
  }
  const name = parts[parts.length - 1];
  if (IGNORED_DESKTOP_INPUT_FILENAMES.has(name)) return false;
  if (name.startsWith('.')) return isZarrMetadataFileName(name);
  if (name === 'zarr.json') return true;
  return isZarrChunkFileName(name);
}

export function desktopInputFormatLabel(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const name = path.basename(normalized).toLowerCase();
  if (!name) return '';
  if (isOmeZarrInputPath(normalized)) return 'OME-Zarr';
  if (name.endsWith('.ome.tif') || name.endsWith('.ome.tiff')) return 'OME-TIFF';
  if (name.endsWith('.nii.gz') || name.endsWith('.nii')) return 'NIfTI';
  const ext = path.extname(name);
  if (!ext || ['.dcm', '.dicom', '.ima'].includes(ext)) return 'DICOM';
  if (['.tif', '.tiff'].includes(ext)) return 'TIFF/ImageJ TIFF';
  if (ext === '.json') return 'JSON sidecar';
  if (ext === '.roi') return 'ImageJ ROI';
  if (ext === '.sr') return 'DICOM SR';
  if (ext === '.zip') return 'ROI ZIP';
  return CONVERTIBLE_FORMAT_LABELS.get(ext) || '';
}

export function isSupportedInputPath(filePath, { isDirectory = false } = {}) {
  if (isDirectory) return false;
  if (isOmeZarrInputPath(filePath)) return true;
  const parts = pathParts(filePath);
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name) return false;
  if (IGNORED_DESKTOP_INPUT_FILENAMES.has(name)) return false;
  if (name.startsWith('.')) return false;
  if (hasBlockedAncestor(parts)) return false;
  if (DESKTOP_COMPOUND_INPUT_EXTENSIONS.some(extension => name.endsWith(extension))) return true;
  const ext = path.extname(name);
  return !ext || INPUT_EXTENSIONS.has(ext);
}

export function isConvertibleInputPath(filePath, { isDirectory = false } = {}) {
  if (isDirectory) return false;
  if (hasBlockedAncestor(pathParts(filePath))) return false;
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name) return false;
  if (IGNORED_DESKTOP_INPUT_FILENAMES.has(name)) return false;
  if (name.startsWith('.')) return false;
  return CONVERTIBLE_EXTENSIONS.has(path.extname(name));
}

export function openPathRecord(filePath, opts = {}) {
  const isDirectory = !!opts.isDirectory;
  const forcedUnsupported = opts.unsupported === true;
  const supported = !forcedUnsupported && isSupportedInputPath(filePath, { isDirectory });
  const conversionRequired = !supported && isConvertibleInputPath(filePath, { isDirectory });
  const record = {
    path: String(filePath || ''),
    name: path.basename(String(filePath || '')),
    kind: isDirectory ? 'folder' : 'file',
    supported,
    conversionRequired,
    reason: supported || conversionRequired ? '' : (opts.reason || (isDirectory ? 'folder_empty_or_unsupported' : 'unsupported_extension')),
  };
  const formatLabel = opts.formatLabel ? String(opts.formatLabel) : desktopInputFormatLabel(filePath);
  if (formatLabel && (supported || conversionRequired)) record.formatLabel = formatLabel;
  if (Number.isFinite(opts.size) && opts.size >= 0) record.size = opts.size;
  if (Number.isFinite(opts.lastModified)) record.lastModified = opts.lastModified;
  if (opts.relativePath) record.relativePath = String(opts.relativePath).replaceAll('\\', '/');
  if (opts.schema && !record.supported && !record.conversionRequired) record.schema = String(opts.schema);
  return record;
}

export function openPathsPayload(paths = [], opts = {}) {
  const records = paths.map(item => (
    typeof item === 'string'
      ? openPathRecord(item, opts)
      : openPathRecord(item.path, {
        isDirectory: item.isDirectory,
        reason: item.reason,
        relativePath: item.relativePath,
        size: item.size,
        lastModified: item.lastModified,
        formatLabel: item.formatLabel,
        schema: item.schema,
        unsupported: item.unsupported,
      })
  )).filter(item => item.path);
  return {
    apiVersion: DESKTOP_API_VERSION,
    records,
    supported: records.filter(item => item.supported),
    convertible: records.filter(item => item.conversionRequired),
    unsupported: records.filter(item => !item.supported && !item.conversionRequired),
  };
}
