export const MAX_LOCAL_FILE_SELECTION_FILES = 10000;
export const LOCAL_PATH_UNAVAILABLE_REASON = 'path_unavailable';
export const LOCAL_FOLDER_READ_FAILED_REASON = 'folder_read_failed';

function setRelativePath(file, relativePath) {
  const path = String(relativePath || '');
  if (!path || file.webkitRelativePath) return file;
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
  } catch {
    try { file.path = path; } catch {}
  }
  return file;
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function unavailableEntryFile(entry, relativePath, reason = LOCAL_PATH_UNAVAILABLE_REASON, failureKind = 'file') {
  return setRelativePath({
    name: String(entry?.name || relativePath || 'unavailable file'),
    skipReason: reason,
    failureKind,
  }, relativePath);
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function isIgnoredFileName(name) {
  const text = String(name || '');
  return text.startsWith('._') || ['.ds_store', 'thumbs.db'].includes(text.toLowerCase());
}

function isIgnoredFolderName(name) {
  return String(name || '').toLowerCase() === '__macosx';
}

function isZarrMetadataFileName(name) {
  return ['.zattrs', '.zarray', '.zgroup', '.zmetadata'].includes(String(name || '').toLowerCase());
}

function shouldSkipEntry(entry, inOmeZarrTree) {
  const name = String(entry.name || '');
  if (isIgnoredFileName(name)) return true;
  if (entry.isDirectory && isIgnoredFolderName(name)) return true;
  if (!name.startsWith('.')) return false;
  return !(entry.isFile && inOmeZarrTree && isZarrMetadataFileName(name));
}

function shouldSkipLocalFile(file) {
  if (isIgnoredFileName(file?.name)) return true;
  const path = String(file?.webkitRelativePath || file?.path || '');
  if (!path) return String(file?.name || '').startsWith('.');
  let inOmeZarrTree = false;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (isIgnoredFolderName(part)) return true;
    if (part.startsWith('.')) return true;
    if (/\.zarr$/i.test(part)) inOmeZarrTree = true;
  }
  const fileName = parts[parts.length - 1] || String(file?.name || '');
  if (fileName.startsWith('.') && (!inOmeZarrTree || !isZarrMetadataFileName(fileName))) return true;
  return false;
}

function entryRootPath(entry) {
  const path = String(entry?.fullPath || '').replace(/\\/g, '/');
  return path.startsWith('/') ? path : `/${path}`;
}

function hasCoveringRoot(root, roots) {
  let slash = root.lastIndexOf('/');
  while (slash > 0) {
    const parent = root.slice(0, slash);
    if (roots.has(parent)) return true;
    slash = parent.lastIndexOf('/');
  }
  return false;
}

function skipCoveredRoots(entries) {
  const roots = entries.map(entry => entryRootPath(entry));
  const rootSet = new Set();
  const firstIndexByRoot = new Map();
  roots.forEach((root, index) => {
    if (root === '/') return;
    rootSet.add(root);
    if (!firstIndexByRoot.has(root)) firstIndexByRoot.set(root, index);
  });
  return entries.filter((_entry, index) => {
    const root = roots[index];
    if (root === '/') return true;
    if (firstIndexByRoot.get(root) !== index) return false;
    return !hasCoveringRoot(root, rootSet);
  });
}

function countEntryFile(limits) {
  limits.count += 1;
  assertFileListWithinLimit(limits.count, limits.maxFiles, 'Folder drop');
}

function assertFileListWithinLimit(count, maxFiles, source) {
  if (count <= maxFiles) return;
  const noun = maxFiles === 1 ? 'file' : 'files';
  throw new Error(`${source} contains more than ${maxFiles} ${noun}. Use a smaller folder or the Electron app for large local studies.`);
}

export function filterLocalFiles(files, { maxFiles = MAX_LOCAL_FILE_SELECTION_FILES, source = 'File selection' } = {}) {
  const seen = new Set();
  const filtered = [];
  for (let index = 0; index < (files?.length || 0); index += 1) {
    const file = files[index];
    if (shouldSkipLocalFile(file)) continue;
    const key = file?.webkitRelativePath || file?.path || '';
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    filtered.push(file);
    assertFileListWithinLimit(filtered.length, maxFiles, source);
  }
  return filtered;
}

async function collectEntryFiles(entry, prefix = '', parentIsOmeZarr = false, limits = { count: 0, maxFiles: MAX_LOCAL_FILE_SELECTION_FILES, seenPaths: new Set() }) {
  const path = `${prefix}${entry.name}`;
  if (shouldSkipEntry(entry, parentIsOmeZarr)) return [];
  if (entry.isFile) {
    if (limits.seenPaths.has(path)) return [];
    limits.seenPaths.add(path);
    countEntryFile(limits);
    try {
      return [setRelativePath(await entryFile(entry), path)];
    } catch {
      return [unavailableEntryFile(entry, path)];
    }
  }
  if (!entry.isDirectory) return [];
  const inOmeZarrTree = parentIsOmeZarr || /\.zarr$/i.test(entry.name);
  const reader = entry.createReader();
  const files = [];
  for (;;) {
    let batch;
    try {
      batch = await readEntries(reader);
    } catch {
      countEntryFile(limits);
      files.push(unavailableEntryFile(entry, path, LOCAL_FOLDER_READ_FAILED_REASON, 'folder'));
      return files;
    }
    if (!batch.length) return files;
    const childFiles = await Promise.all(
      batch.map(child => collectEntryFiles(child, `${path}/`, inOmeZarrTree, limits)),
    );
    for (const list of childFiles) files.push(...list);
  }
}

export async function collectDroppedFiles(dataTransfer, { maxFiles = MAX_LOCAL_FILE_SELECTION_FILES } = {}) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = skipCoveredRoots(items.map(item => item.webkitGetAsEntry?.()).filter(Boolean));
  if (!entries.length) return filterLocalFiles(dataTransfer?.files, { maxFiles, source: 'Folder drop' });
  const limits = { count: 0, maxFiles, seenPaths: new Set() };
  const files = [];
  for (const entry of entries) {
    files.push(...await collectEntryFiles(entry, '', false, limits));
  }
  return files;
}
