export const NOTIFY_KINDS = Object.freeze([
  'confirm',
  'info',
  'warning',
  'error',
  'progress',
  'action',
]);

const KIND_SET = new Set(NOTIFY_KINDS);
const STICKY_KINDS = new Set(['error', 'warning', 'action', 'progress']);
const EVICT_ORDER = ['confirm', 'info', 'warning'];

export function resolveKind(opts = {}) {
  if (KIND_SET.has(opts.kind)) return opts.kind;
  if (opts.progress) return 'progress';
  if (opts.command) return 'action';
  return 'confirm';
}

export function isSticky(kind) {
  return STICKY_KINDS.has(kind);
}

export function confirmDuration(opts = {}) {
  const duration = opts.duration;
  if (duration === 0) return 0;
  if (Number.isFinite(duration) && duration > 0) return duration;
  return 5000;
}

export function shouldAutoDismiss(kind, opts = {}) {
  return !isSticky(kind) && confirmDuration(opts) > 0;
}

export function pickEviction(items = []) {
  if (!items.length) return -1;
  for (const kind of EVICT_ORDER) {
    const index = items.findIndex(item => item.kind === kind);
    if (index >= 0) return index;
  }
  return 0;
}
