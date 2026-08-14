import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_RECENT_DOCUMENTS = 12;

export function recentDocumentsStorePath(appLike) {
  return path.join(appLike.getPath('userData'), 'recent-documents.json');
}

function normalizeRecentRecord(record) {
  const filePath = String(record?.path || '');
  if (!filePath) return null;
  const kind = record.kind === 'folder' ? 'folder' : 'file';
  const openedAt = Number.isFinite(Date.parse(record.lastOpenedAt || ''))
    ? new Date(record.lastOpenedAt).toISOString()
    : new Date().toISOString();
  return {
    path: filePath,
    name: String(record.name || path.basename(filePath)),
    kind,
    lastOpenedAt: openedAt,
  };
}

export async function readRecentDocuments(appLike, opts = {}) {
  const storePath = opts.storePath || recentDocumentsStorePath(appLike);
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecentRecord)
      .filter(Boolean)
      .slice(0, opts.maxItems || MAX_RECENT_DOCUMENTS);
  } catch {
    return [];
  }
}

export async function writeRecentDocuments(appLike, records, opts = {}) {
  const storePath = opts.storePath || recentDocumentsStorePath(appLike);
  const normalized = records
    .map(normalizeRecentRecord)
    .filter(Boolean)
    .slice(0, opts.maxItems || MAX_RECENT_DOCUMENTS);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`);
  await fs.rename(tmpPath, storePath);
  return normalized;
}

async function recentRecordForPath(filePath, now) {
  const absolutePath = String(filePath || '');
  if (!absolutePath) return null;
  const stat = await fs.stat(absolutePath);
  return {
    path: absolutePath,
    name: path.basename(absolutePath),
    kind: stat.isDirectory() ? 'folder' : 'file',
    lastOpenedAt: new Date(now).toISOString(),
  };
}

export async function rememberRecentDocuments(appLike, paths, opts = {}) {
  const openedAt = opts.now || Date.now();
  const maxItems = opts.maxItems || MAX_RECENT_DOCUMENTS;
  const existing = await readRecentDocuments(appLike, opts);
  const fresh = [];
  const seen = new Set();
  for (const filePath of paths.map(item => String(item || '')).filter(Boolean)) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      const record = await recentRecordForPath(filePath, openedAt);
      if (record) fresh.push(record);
    } catch {
      // Ignore stale launch arguments or removed files; the OS recent list may still hold them.
    }
  }
  const freshPaths = new Set(fresh.map(record => record.path));
  return writeRecentDocuments(appLike, [
    ...fresh,
    ...existing.filter(record => !freshPaths.has(record.path)),
  ].slice(0, maxItems), { ...opts, maxItems });
}

export async function removeRecentDocuments(appLike, paths, opts = {}) {
  const drop = new Set(paths.map(item => String(item || '')).filter(Boolean));
  if (!drop.size) return readRecentDocuments(appLike, opts);
  const existing = await readRecentDocuments(appLike, opts);
  return writeRecentDocuments(appLike, existing.filter(record => !drop.has(record.path)), opts);
}

export async function clearRecentDocuments(appLike, opts = {}) {
  return writeRecentDocuments(appLike, [], opts);
}
