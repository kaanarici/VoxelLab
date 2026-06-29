import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

function isWindowsAbsolute(value) {
  return WINDOWS_ABSOLUTE_RE.test(String(value || ''));
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
  ].map(item => normalizedAbsolute(item, cwd)).filter(Boolean));
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
    if (!absolute || skip.has(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}
