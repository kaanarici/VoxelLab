import { $ } from './dom.js';

const SEEN_KEY = 'voxellab:interaction-hint-seen';

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch {                                            }
}

export function initInteractionHint() {
  $('interaction-hint-dismiss')?.addEventListener('click', () => {
    const el = $('interaction-hint');
    if (el) el.hidden = true;
    markSeen();
  });
}

export function maybeShowInteractionHint() {
  if (seen()) return;
  const el = $('interaction-hint');
  if (el) el.hidden = false;
}
