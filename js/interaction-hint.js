// One-time first-run legend for the canvas gestures that have no visible
// affordance (window/level via Shift+drag, zoom via modifier-scroll). Shown the
// first time a study is open; dismissal persists. The same reference lives
// permanently in the Help (?) modal, so this is purely an onboarding nudge.

import { $ } from './dom.js';

const SEEN_KEY = 'voxellab:interaction-hint-seen';

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode — show once per session */ }
}

/** Wire the dismiss button. Safe to call once at startup. */
export function initInteractionHint() {
  $('interaction-hint-dismiss')?.addEventListener('click', () => {
    const el = $('interaction-hint');
    if (el) el.hidden = true;
    markSeen();
  });
}

/** Show the hint once, only when a study is actually on screen. */
export function maybeShowInteractionHint() {
  if (seen()) return;
  const el = $('interaction-hint');
  if (el) el.hidden = false;
}
