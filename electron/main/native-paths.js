import fs from 'node:fs/promises';
import path from 'node:path';
import { isConvertibleInputPath, isSupportedInputPath, isZarrMetadataFileName, openPathsPayload } from '../shared/desktop-contracts.js';
import {
  classifyJsonSidecarText,
} from '../../js/sidecar-schemas.js';

export const MAX_FOLDER_IMPORT_FILES = 10000;
export const MAX_FOLDER_SCAN_FILES = 10000;
export const MAX_FOLDER_SCAN_DEPTH = 12;
export const MAX_NATIVE_READ_RANGE_BYTES = 1024 * 1024 * 1024;
export const MAX_NATIVE_PATH_STAT_CONCURRENCY = 32;
export const MAX_FOLDER_UNSUPPORTED_SAMPLES = 8;
export const PATH_UNAVAILABLE_REASON = 'path_unavailable';

export async function nativePathItem(filePath) {
  let stat = null;
  let statFailed = false;
  try {
    stat = await fs.stat(filePath);
  } catch {
    statFailed = true;
    stat = null;
  }
  const item = {
    path: filePath,
    isDirectory: !!stat?.isDirectory(),
    size: stat?.isFile() ? stat.size : undefined,
    lastModified: stat?.isFile() ? stat.mtimeMs : undefined,
  };
  if (stat?.isFile() && path.extname(filePath).toLowerCase() === '.json') {
    const { formatLabel, reason, schema } = await jsonSidecarInfo(filePath);
    if (formatLabel) item.formatLabel = formatLabel;
    else {
      item.unsupported = true;
      item.reason = reason;
      if (schema) item.schema = schema;
    }
  }
  if (statFailed) {
    item.unsupported = true;
    item.reason = PATH_UNAVAILABLE_REASON;
  }
  return item;
}

function concurrencyLimit(value, max) {
  const number = Number(value);
  const limit = Number.isFinite(number) && number >= 1 ? Math.trunc(number) : max;
  return Math.min(limit, max);
}

export async function nativePathItems(filePaths, opts = {}) {
  const paths = Array.from(filePaths || []);
  if (!paths.length) return [];
  const readItem = opts.readItem || nativePathItem;
  const workerCount = Math.min(
    concurrencyLimit(opts.concurrency, MAX_NATIVE_PATH_STAT_CONCURRENCY),
    paths.length,
  );
  const items = new Array(paths.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < paths.length) {
      const index = nextIndex;
      nextIndex += 1;
      items[index] = await readItem(paths[index]);
    }
  }));
  return items;
}

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function readRangeBounds(size, range = {}, maxBytes = MAX_NATIVE_READ_RANGE_BYTES) {
  const start = Math.max(0, Math.min(size, finiteInteger(range.start, 0)));
  const requestedEnd = finiteInteger(range.end, size);
  const end = Math.max(start, Math.min(size, requestedEnd));
  const length = end - start;
  const requestedLimit = Math.max(0, finiteInteger(maxBytes, MAX_NATIVE_READ_RANGE_BYTES));
  const limit = Math.min(requestedLimit, MAX_NATIVE_READ_RANGE_BYTES);
  if (length > limit) throw new Error('Selected file range is too large for one desktop bridge read');
  return { start, end, length };
}

function uniqueFolderPaths(folderPaths) {
  const folders = [];
  const seen = new Set();
  for (const item of folderPaths) {
    const folderPath = String(item || '');
    if (!folderPath) continue;
    const key = path.resolve(folderPath);
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folderPath);
  }
  return folders;
}

function hasSelectedParentFolder(folderPath, selectedFolders) {
  let parent = path.dirname(folderPath);
  while (parent && parent !== folderPath) {
    if (selectedFolders.has(parent)) return true;
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return false;
}

function scanFolderPaths(folderPaths) {
  const selectedFolders = new Set();
  const scanRoots = [];
  const folders = uniqueFolderPaths(folderPaths)
    .map(folderPath => ({ folderPath, resolved: path.resolve(folderPath) }))
    .sort((a, b) => a.resolved.length - b.resolved.length);
  for (const item of folders) selectedFolders.add(item.resolved);
  for (const item of folders) {
    if (hasSelectedParentFolder(item.resolved, selectedFolders)) continue;
    scanRoots.push(item.folderPath);
  }
  return scanRoots;
}

function shouldSkipFolderEntry(entry, inOmeZarrTree) {
  if (entry.isSymbolicLink()) return true;
  const name = String(entry.name || '');
  const lowerName = name.toLowerCase();
  if (name.startsWith('._') || ['.ds_store', 'thumbs.db'].includes(lowerName)) return true;
  if (entry.isDirectory() && lowerName === '__macosx') return true;
  if (!name.startsWith('.')) return false;
  return !(entry.isFile() && inOmeZarrTree && isZarrMetadataFileName(name));
}

function relativeFolderPath(rootPath, filePath) {
  const rootName = path.basename(path.resolve(rootPath));
  const relative = path.relative(rootPath, filePath);
  return [rootName, relative].filter(Boolean).join('/').replaceAll(path.sep, '/');
}

function recordUnsupportedFolderFile(summary, rootPath, filePath, reason = 'unsupported_extension', extra = {}) {
  summary.skippedUnsupportedFiles += 1;
  if (summary.skippedUnsupportedSamples.length >= MAX_FOLDER_UNSUPPORTED_SAMPLES) return;
  const sample = {
    path: filePath,
    name: path.basename(filePath),
    relativePath: relativeFolderPath(rootPath, filePath),
    reason,
  };
  if (extra.schema) sample.schema = String(extra.schema);
  summary.skippedUnsupportedSamples.push(sample);
}

function recordFailedFolderFile(summary, rootPath, filePath, reason = PATH_UNAVAILABLE_REASON) {
  summary.failedFiles += 1;
  if (summary.failedFileSamples.length >= MAX_FOLDER_UNSUPPORTED_SAMPLES) return;
  summary.failedFileSamples.push({
    path: filePath,
    name: path.basename(filePath),
    relativePath: relativeFolderPath(rootPath, filePath),
    reason,
  });
}

async function jsonSidecarInfo(filePath) {
  try {
    return classifyJsonSidecarText(await fs.readFile(filePath, 'utf8'));
  } catch {
    return classifyJsonSidecarText('');
  }
}

function folderScanLimitReached(limits) {
  return limits.summary.scannedFiles >= limits.maxScannedFiles;
}

export async function readNativeFileRange(filePath, range = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Only selected files can be read by the desktop bridge');
  const { start, length } = readRangeBounds(stat.size, range, range.maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = Buffer.allocUnsafe(length);
    const result = length ? await handle.read(bytes, 0, length, start) : { bytesRead: 0 };
    const view = bytes.subarray(0, result.bytesRead);
    return {
      path: filePath,
      name: path.basename(filePath),
      size: stat.size,
      lastModified: stat.mtimeMs,
      start,
      end: start + result.bytesRead,
      bytes: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    };
  } finally {
    await handle.close();
  }
}

async function walkFolder(dirPath, out, warnings, depth, limits, parentIsOmeZarr = false, rootPath = dirPath) {
  if (out.length >= limits.maxFiles || folderScanLimitReached(limits)) return false;
  if (depth > limits.maxDepth) {
    warnings.push({ path: dirPath, reason: 'folder_depth_limit' });
    return false;
  }
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    warnings.push({ path: dirPath, reason: 'folder_read_failed' });
    return false;
  }
  let matched = false;
  const inOmeZarrTree = parentIsOmeZarr || /\.zarr$/i.test(path.basename(dirPath));
  entries.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  for (const entry of entries) {
    if (out.length >= limits.maxFiles || folderScanLimitReached(limits)) return matched;
    if (shouldSkipFolderEntry(entry, inOmeZarrTree)) continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (await walkFolder(childPath, out, warnings, depth + 1, limits, inOmeZarrTree, rootPath)) matched = true;
    } else if (entry.isFile()) {
      limits.summary.scannedFiles += 1;
      const supported = isSupportedInputPath(childPath);
      const convertible = !supported && isConvertibleInputPath(childPath);
      const jsonSidecar = supported
        && !inOmeZarrTree
        && path.extname(childPath).toLowerCase() === '.json'
        ? await jsonSidecarInfo(childPath)
        : null;
      const jsonSidecarLabel = jsonSidecar?.formatLabel || '';
      const unsupportedJsonSidecar = supported
        && !inOmeZarrTree
        && path.extname(childPath).toLowerCase() === '.json'
        && !jsonSidecarLabel;
      if (!unsupportedJsonSidecar && (supported || convertible)) {
        matched = true;
        if (!limits.seenFiles.has(childPath)) {
          let stat;
          try {
            stat = await limits.statFile(childPath);
          } catch {
            recordFailedFolderFile(limits.summary, rootPath, childPath);
            continue;
          }
          limits.seenFiles.add(childPath);
          const record = {
            path: childPath,
            isDirectory: false,
            relativePath: relativeFolderPath(rootPath, childPath),
            size: stat.size,
            lastModified: stat.mtimeMs,
          };
          if (jsonSidecarLabel) record.formatLabel = jsonSidecarLabel;
          out.push(record);
        }
      } else {
        recordUnsupportedFolderFile(
          limits.summary,
          rootPath,
          childPath,
          unsupportedJsonSidecar ? jsonSidecar.reason : 'unsupported_extension',
          unsupportedJsonSidecar ? { schema: jsonSidecar.schema } : {},
        );
      }
    }
  }
  return matched;
}

export async function collectSupportedFolderFiles(folderPaths, opts = {}) {
  const limits = {
    maxFiles: opts.maxFiles ?? MAX_FOLDER_IMPORT_FILES,
    maxScannedFiles: opts.maxScannedFiles ?? MAX_FOLDER_SCAN_FILES,
    maxDepth: opts.maxDepth ?? MAX_FOLDER_SCAN_DEPTH,
    statFile: opts.statFile || fs.stat,
    seenFiles: new Set(),
    summary: {
      scannedFiles: 0,
      skippedUnsupportedFiles: 0,
      skippedUnsupportedSamples: [],
      failedFiles: 0,
      failedFileSamples: [],
    },
  };
  const files = [];
  const warnings = [];
  for (const folderPath of scanFolderPaths(folderPaths)) {
    const matched = await walkFolder(folderPath, files, warnings, 0, limits);
    if (!matched && !folderScanLimitReached(limits)) {
      warnings.push({ path: folderPath, reason: 'folder_empty_or_unsupported' });
    }
    if (files.length >= limits.maxFiles || folderScanLimitReached(limits)) {
      warnings.push({ path: folderPath, reason: 'folder_file_limit' });
      break;
    }
  }
  return { files, warnings, summary: limits.summary };
}

export function openFolderPayload(folderPaths, files, warnings = [], summary = {}) {
  const sourceFolders = uniqueFolderPaths(folderPaths);
  const records = files.length
    ? files
    : sourceFolders.map(folderPath => ({
      path: folderPath,
      isDirectory: true,
      reason: 'folder_empty_or_unsupported',
    }));
  const payload = openPathsPayload(records);
  return {
    ...payload,
    sourceFolders,
    warnings,
    folderSummary: {
      scannedFiles: Number(summary.scannedFiles || 0),
      supportedFiles: payload.supported.length,
      convertibleFiles: payload.convertible.length,
      unsupportedRecords: payload.unsupported.length,
      skippedUnsupportedFiles: Number(summary.skippedUnsupportedFiles || 0),
      skippedUnsupportedSamples: Array.isArray(summary.skippedUnsupportedSamples)
        ? summary.skippedUnsupportedSamples.slice(0, MAX_FOLDER_UNSUPPORTED_SAMPLES)
        : [],
      failedFiles: Number(summary.failedFiles || 0),
      failedFileSamples: Array.isArray(summary.failedFileSamples)
        ? summary.failedFileSamples.slice(0, MAX_FOLDER_UNSUPPORTED_SAMPLES)
        : [],
      warningCount: warnings.length,
      failedFolderReads: warnings.filter(item => item?.reason === 'folder_read_failed').length,
    },
  };
}
