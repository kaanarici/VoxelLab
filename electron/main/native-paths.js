import fs from 'node:fs/promises';
import path from 'node:path';
import { isSupportedInputPath, openPathsPayload } from '../shared/desktop-contracts.js';

export const MAX_FOLDER_IMPORT_FILES = 10000;
export const MAX_FOLDER_SCAN_DEPTH = 12;
export const MAX_NATIVE_READ_RANGE_BYTES = 1024 * 1024 * 1024;

export async function nativePathItem(filePath) {
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    stat = null;
  }
  return {
    path: filePath,
    isDirectory: !!stat?.isDirectory(),
    size: stat?.isFile() ? stat.size : undefined,
    lastModified: stat?.isFile() ? stat.mtimeMs : undefined,
  };
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
  if (length > maxBytes) throw new Error('Selected file range is too large for one desktop bridge read');
  return { start, end, length };
}

export async function readNativeFileRange(filePath, range = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Only selected files can be read by the desktop bridge');
  const { start, length } = readRangeBounds(stat.size, range, range.maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
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

async function walkFolder(dirPath, out, warnings, depth, limits) {
  if (out.length >= limits.maxFiles) return;
  if (depth > limits.maxDepth) {
    warnings.push({ path: dirPath, reason: 'folder_depth_limit' });
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    warnings.push({ path: dirPath, reason: 'folder_read_failed' });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limits.maxFiles) return;
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkFolder(childPath, out, warnings, depth + 1, limits);
    } else if (entry.isFile() && isSupportedInputPath(childPath)) {
      out.push({ path: childPath, isDirectory: false });
    }
  }
}

export async function collectSupportedFolderFiles(folderPaths, opts = {}) {
  const limits = {
    maxFiles: opts.maxFiles ?? MAX_FOLDER_IMPORT_FILES,
    maxDepth: opts.maxDepth ?? MAX_FOLDER_SCAN_DEPTH,
  };
  const files = [];
  const warnings = [];
  for (const folderPath of folderPaths.map(item => String(item || '')).filter(Boolean)) {
    const before = files.length;
    await walkFolder(folderPath, files, warnings, 0, limits);
    if (files.length === before) warnings.push({ path: folderPath, reason: 'folder_empty_or_unsupported' });
    if (files.length >= limits.maxFiles) {
      warnings.push({ path: folderPath, reason: 'folder_file_limit' });
      break;
    }
  }
  return { files, warnings };
}

export function openFolderPayload(folderPaths, files, warnings = []) {
  const records = files.length
    ? files
    : folderPaths.map(folderPath => ({
      path: folderPath,
      isDirectory: true,
      reason: 'folder_empty_or_unsupported',
    }));
  return {
    ...openPathsPayload(records),
    sourceFolders: folderPaths.map(item => String(item || '')).filter(Boolean),
    warnings,
  };
}
