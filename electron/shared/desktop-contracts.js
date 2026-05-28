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

const INPUT_EXTENSIONS = new Set([
  '.dcm',
  '.dicom',
  '.ima',
  '.nii',
  '.tif',
  '.tiff',
  '.json',
  '.sr',
  '.csv',
]);

const CONVERTIBLE_EXTENSIONS = new Set([
  '.czi',
  '.nd2',
  '.lif',
  '.oib',
  '.oif',
]);

export function isSupportedInputPath(filePath, { isDirectory = false } = {}) {
  if (isDirectory) return false;
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name) return false;
  if (name.endsWith('.nii.gz') || name.endsWith('.ome.tif') || name.endsWith('.ome.tiff')) return true;
  const ext = path.extname(name);
  return !ext || INPUT_EXTENSIONS.has(ext);
}

export function isConvertibleInputPath(filePath, { isDirectory = false } = {}) {
  if (isDirectory) return false;
  const name = path.basename(String(filePath || '')).toLowerCase();
  return CONVERTIBLE_EXTENSIONS.has(path.extname(name));
}

export function openPathRecord(filePath, opts = {}) {
  const isDirectory = !!opts.isDirectory;
  const supported = isSupportedInputPath(filePath, { isDirectory });
  const conversionRequired = !supported && isConvertibleInputPath(filePath, { isDirectory });
  const record = {
    path: String(filePath || ''),
    name: path.basename(String(filePath || '')),
    kind: isDirectory ? 'folder' : 'file',
    supported,
    conversionRequired,
    reason: supported || conversionRequired ? '' : (opts.reason || (isDirectory ? 'folder_empty_or_unsupported' : 'unsupported_extension')),
  };
  if (Number.isFinite(opts.size) && opts.size >= 0) record.size = opts.size;
  if (Number.isFinite(opts.lastModified)) record.lastModified = opts.lastModified;
  return record;
}

export function openPathsPayload(paths = [], opts = {}) {
  const records = paths.map(item => (
    typeof item === 'string'
      ? openPathRecord(item, opts)
      : openPathRecord(item.path, {
        isDirectory: item.isDirectory,
        reason: item.reason,
        size: item.size,
        lastModified: item.lastModified,
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
