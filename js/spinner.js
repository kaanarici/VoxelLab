const pending = new Set();

const SHOW_DELAY_MS = 150;
const MIN_SHOW_MS = 350;

let showTimer = 0;
let hideTimer = 0;
let visible = false;
let shownAt = 0;

function el() { return document.getElementById('viewer-spinner'); }

function apply(next) {
  const node = el();
  if (!node) return;
  node.hidden = !next;
  visible = next;
  if (next) shownAt = performance.now();
}

function schedule() {
  const want = pending.size > 0;
  if (want) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    if (visible || showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = 0;
      if (pending.size > 0) apply(true);
    }, SHOW_DELAY_MS);
    return;
  }
  if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
  if (!visible || hideTimer) return;
  const remaining = Math.max(0, MIN_SHOW_MS - (performance.now() - shownAt));
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    if (pending.size === 0) apply(false);
  }, remaining);
}

export function setSpinnerPending(key, isPending) {
  if (isPending) pending.add(key);
  else pending.delete(key);
  schedule();
}

export function clearSpinnerPendingPrefix(prefix) {
  const base = String(prefix || '');
  if (!base) return;
  for (const key of [...pending]) {
    if (key === base || key.startsWith(`${base}:`)) pending.delete(key);
  }
  schedule();
}

export function __pendingSpinnerKeysForTests() {
  return [...pending].sort();
}

export function __resetSpinnerForTests() {
  pending.clear();
  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);
  showTimer = 0;
  hideTimer = 0;
  visible = false;
  shownAt = 0;
  const node = el();
  if (node) node.hidden = true;
}
