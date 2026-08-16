import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_SAVED_IMPORTS = 300;
export const MAX_SAVED_IMPORT_PATHS = 10000;
export const MAX_TOTAL_SAVED_IMPORT_PATHS = 20000;

export function savedImportsStorePath(appLike) {
  return path.join(appLike.getPath('userData'), 'saved-imports.json');
}

function normalizedPaths(paths, maxPaths = MAX_SAVED_IMPORT_PATHS) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.from(paths || [])) {
    const filePath = String(value || '');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    unique.push(filePath);
    if (unique.length >= maxPaths) break;
  }
  return unique;
}

export function savedImportId(paths) {
  const canonical = normalizedPaths(paths).slice().sort();
  if (!canonical.length) return '';
  return `import-${createHash('sha256').update(canonical.join('\0')).digest('hex').slice(0, 24)}`;
}

function normalizeSavedImport(record, opts = {}) {
  const paths = normalizedPaths(record?.paths, opts.maxPaths);
  const id = savedImportId(paths);
  if (!id) return null;
  const savedAt = Number.isFinite(Date.parse(record?.savedAt || ''))
    ? new Date(record.savedAt).toISOString()
    : new Date().toISOString();
  return { id, paths, savedAt };
}

export async function readSavedImports(appLike, opts = {}) {
  const storePath = opts.storePath || savedImportsStorePath(appLike);
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const records = parsed
      .map(record => normalizeSavedImport(record, opts))
      .filter(Boolean)
      .slice(0, opts.maxItems || MAX_SAVED_IMPORTS);
    const bounded = [];
    let totalPaths = 0;
    for (const record of records) {
      if (totalPaths + record.paths.length > (opts.maxTotalPaths || MAX_TOTAL_SAVED_IMPORT_PATHS)) continue;
      bounded.push(record);
      totalPaths += record.paths.length;
    }
    return bounded;
  } catch {
    return [];
  }
}

export async function writeSavedImports(appLike, records, opts = {}) {
  const storePath = opts.storePath || savedImportsStorePath(appLike);
  const candidates = records
    .map(record => normalizeSavedImport(record, opts))
    .filter(Boolean)
    .slice(0, opts.maxItems || MAX_SAVED_IMPORTS);
  const normalized = [];
  let totalPaths = 0;
  for (const record of candidates) {
    if (totalPaths + record.paths.length > (opts.maxTotalPaths || MAX_TOTAL_SAVED_IMPORT_PATHS)) continue;
    normalized.push(record);
    totalPaths += record.paths.length;
  }
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmpPath, storePath);
  return normalized;
}

export async function rememberSavedImport(appLike, paths, opts = {}) {
  const normalized = normalizeSavedImport({ paths, savedAt: new Date(opts.now || Date.now()).toISOString() }, opts);
  if (!normalized) throw new Error('A saved desktop import needs at least one selected source file');
  if (Array.from(paths || []).length > (opts.maxPaths || MAX_SAVED_IMPORT_PATHS)) {
    throw new Error(`A saved desktop import cannot contain more than ${opts.maxPaths || MAX_SAVED_IMPORT_PATHS} source files`);
  }
  const existing = await readSavedImports(appLike, opts);
  return {
    record: normalized,
    records: await writeSavedImports(appLike, [
      normalized,
      ...existing.filter(record => record.id !== normalized.id),
    ], opts),
  };
}

export async function removeSavedImports(appLike, ids, opts = {}) {
  const drop = new Set(Array.from(ids || []).map(String).filter(Boolean));
  const existing = await readSavedImports(appLike, opts);
  if (!drop.size) return existing;
  return writeSavedImports(appLike, existing.filter(record => !drop.has(record.id)), opts);
}
