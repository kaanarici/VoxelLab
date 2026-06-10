import {
  LOCAL_FOLDER_READ_FAILED_REASON,
  LOCAL_PATH_UNAVAILABLE_REASON,
} from '../file-drop.js';
import { isImageJRoiFile, isImageJRoiZipFile, isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import { classifyJsonSidecarText } from '../sidecar-schemas.js';
import { localFilePath, localIntakeStatusText } from './local-intake-text.js';

export const LOCAL_VENDOR_MICROSCOPY_EXTENSIONS = Object.freeze(['czi', 'nd2', 'lif', 'oib', 'oif', 'lsm']);
export const LOCAL_VENDOR_MICROSCOPY_LABEL = LOCAL_VENDOR_MICROSCOPY_EXTENSIONS.map(ext => ext.toUpperCase()).join('/');
export const LOCAL_VENDOR_MICROSCOPY_RE = new RegExp(`\\.(${LOCAL_VENDOR_MICROSCOPY_EXTENSIONS.join('|')})$`, 'i');
export const LOCAL_VENDOR_MICROSCOPY_ACCEPT = LOCAL_VENDOR_MICROSCOPY_EXTENSIONS.map(ext => `.${ext}`).join(',');

export function isNiftiFile(file) {
  return /\.nii(\.gz)?$/i.test(file?.name || '');
}

export function isMicroscopyTiffFile(file) {
  return /\.(ome\.)?tiff?$/i.test(file?.name || '');
}

export function isVendorMicroscopyFile(file) {
  return LOCAL_VENDOR_MICROSCOPY_RE.test(file?.name || '');
}

function isJsonFile(file) {
  return /\.json$/i.test(file?.name || '');
}

function isDicomSrFile(file) {
  return /\.sr$/i.test(file?.name || '');
}

async function readJsonSidecarInfo(file) {
  if (!isJsonFile(file) || typeof file.text !== 'function') return classifyJsonSidecarText('{}');
  return classifyJsonSidecarText(await file.text());
}

function isOmeZarrAcceptedFile(file = {}) {
  const filePath = localFilePath(file);
  if (!/\.zarr(\/|$)/i.test(filePath)) return isOmeZarrFile(file);
  const name = filePath.split('/').pop() || '';
  return /^(\.zattrs|\.zarray|\.zgroup|\.zmetadata|zarr\.json)$/i.test(name)
    || /^\d+(?:\.\d+)*$/.test(name);
}

function isLikelyDicomOrDerivedFile(file = {}) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/dicom') return true;
  if (/\.(dcm|dicom|ima|sr)$/i.test(name)) return true;
  return !!name && !name.includes('.');
}

async function localIntakeKind(file = {}) {
  if (file?.skipReason) return { skipReason: file.skipReason };
  if (isVendorMicroscopyFile(file)) return 'convertible';
  if (isOmeZarrAcceptedFile(file)) return 'openable';
  if (isImageJRoiFile(file) || isImageJRoiZipFile(file)) return 'sidecar';
  if (isDicomSrFile(file)) return { kind: 'sidecar', formatLabel: 'DICOM SR' };
  if (isJsonFile(file)) {
    const { formatLabel, reason, schema } = await readJsonSidecarInfo(file);
    return formatLabel ? { kind: 'sidecar', formatLabel } : { skipReason: reason, schema };
  }
  if (
    isLikelyDicomOrDerivedFile(file)
    || isNiftiFile(file)
    || isMicroscopyTiffFile(file)
  ) {
    return 'openable';
  }
  return '';
}

function localIntakeResultKind(result) {
  return typeof result === 'string' ? result : String(result?.kind || '');
}

function localIntakeFormatItem(file, result) {
  const formatLabel = typeof result === 'string' ? '' : String(result?.formatLabel || '');
  if (!formatLabel) return file;
  return {
    name: file?.name,
    path: file?.path,
    relativePath: file?.relativePath,
    webkitRelativePath: file?.webkitRelativePath,
    formatLabel,
  };
}

function localIntakeSkippedItem(file, result) {
  const skipReason = typeof result === 'string' ? '' : String(result?.skipReason || '');
  if (!skipReason) return file;
  return {
    name: file?.name,
    path: file?.path,
    relativePath: file?.relativePath,
    webkitRelativePath: file?.webkitRelativePath,
    failureKind: file?.failureKind,
    schema: typeof result === 'string' ? '' : String(result?.schema || ''),
    skipReason,
  };
}

export async function summarizeLocalIntake(files) {
  const kept = [];
  const skipped = [];
  const failedFileSamples = [];
  const folderReadFailures = [];
  const counts = { openable: 0, convertible: 0, sidecar: 0 };
  const formatItems = { openable: [], convertible: [], sidecar: [] };
  const checkedFiles = (files || []).length;
  for (const file of files || []) {
    const result = await localIntakeKind(file);
    const kind = localIntakeResultKind(result);
    if (kind) {
      kept.push(file);
      counts[kind] += 1;
      formatItems[kind].push(localIntakeFormatItem(file, result));
      continue;
    }
    const skippedItem = localIntakeSkippedItem(file, result);
    if (skippedItem.skipReason === LOCAL_FOLDER_READ_FAILED_REASON || skippedItem.failureKind === 'folder') {
      folderReadFailures.push({
        path: localFilePath(skippedItem),
        name: skippedItem.name,
        reason: LOCAL_FOLDER_READ_FAILED_REASON,
      });
    } else if (skippedItem.skipReason === LOCAL_PATH_UNAVAILABLE_REASON) {
      failedFileSamples.push({
        name: skippedItem.name,
        path: localFilePath(skippedItem),
        reason: LOCAL_PATH_UNAVAILABLE_REASON,
      });
    } else {
      skipped.push(skippedItem);
    }
  }
  const intake = {
    files: kept,
    skipped,
    skippedCount: skipped.length,
    failedFiles: failedFileSamples.length,
    failedFileSamples,
    warnings: folderReadFailures,
    failedFolderReads: folderReadFailures.length,
    warningCount: folderReadFailures.length,
    counts,
    formatItems,
    checkedFiles,
  };
  return {
    ...intake,
    message: skipped.length || counts.convertible || failedFileSamples.length || folderReadFailures.length
      ? `Local intake: ${localIntakeStatusText(intake)}.`
      : '',
  };
}
