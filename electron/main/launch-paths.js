import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_OR_DEVICE_RE = /^(?:\\\\|\/\/)/;

function isWindowsAbsolute(value) {
  const input = String(value || '');
  return WINDOWS_DRIVE_ABSOLUTE_RE.test(input)
    || (WINDOWS_UNC_OR_DEVICE_RE.test(input) && path.win32.isAbsolute(input));
}

function resolveNativePath(value, cwd) {
  if (isWindowsAbsolute(value) || isWindowsAbsolute(cwd)) {
    return path.win32.resolve(cwd, value);
  }
  return path.resolve(cwd, value);
}

function normalizedAbsolute(candidate, cwd) {
  if (!candidate) return '';
  let value = String(candidate);
  if (!isWindowsAbsolute(value) && /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
    if (!value.toLowerCase().startsWith('file:')) return '';
    try {
      value = fileURLToPath(value);
    } catch {
      return '';
    }
  }
  return resolveNativePath(value, cwd);
}

function normalizedSkipSet(opts, cwd) {
  return new Set([
    opts.rootDir,
    opts.mainPath,
    ...(opts.skipPaths || []),
  ].map(item => normalizedAbsolute(item, cwd)).filter(Boolean).map(pathComparisonKey));
}

function pathComparisonKey(value) {
  return isWindowsAbsolute(value) ? value.toLowerCase() : value;
}

export function launchPathsFromArgv(argv = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const skip = normalizedSkipSet(opts, cwd);
  const out = [];
  const seen = new Set();
  let positional = false;

  for (const raw of argv.slice(1).map(item => String(item || '')).filter(Boolean)) {
    if (!positional && raw === '--') {
      positional = true;
      continue;
    }
    if (!positional && raw.startsWith('-')) continue;

    const absolute = normalizedAbsolute(raw, cwd);
    const comparisonKey = pathComparisonKey(absolute);
    if (!absolute || skip.has(comparisonKey)) continue;
    if (seen.has(comparisonKey)) continue;
    seen.add(comparisonKey);
    out.push(absolute);
  }
  return out;
}
