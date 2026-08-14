// Pure selection model for the anatomy-label isolate/lock feature. A single
// derived "effective" visible/hidden set is computed from three inputs and fed
// into every render sink (3D volume LUT, 2D/3D atlas pills, 2D colored mask) so
// isolation, hover-preview, and multi-lock all flow through one rule.
//
// Selection is active when at least one label is locked OR a label is being
// previewed (hovered). When inactive, behavior falls back to the user's manual
// hiddenLabels set so nothing changes for users who never touch a pill.

const RESERVED_LABELS = new Set([0, 254, 255]); // background + reserved

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Real anatomy label ids from regionMeta (keys, not a hardcoded 1..255 range). */
export function allLabelsFromMeta(regionMeta) {
  const regions = regionMeta?.regions;
  if (!regions || typeof regions !== 'object') return new Set();
  const out = new Set();
  for (const key of Object.keys(regions)) {
    const id = asNumber(key);
    if (id != null && !RESERVED_LABELS.has(id)) out.add(id);
  }
  return out;
}

/** True when isolation is in effect (something locked or a pill hovered). */
export function isSelectionActive({ locked, preview } = {}) {
  const hasLocked = locked instanceof Set ? locked.size > 0 : false;
  return hasLocked || preview != null;
}

/**
 * Effective set of labels that should render. When no selection is active the
 * visible set is every label minus the user-hidden ones. When active it is the
 * union of locked + preview, still minus anything the user explicitly hid.
 */
export function effectiveVisibleLabels({ hidden, locked, preview, allLabels } = {}) {
  const all = allLabels instanceof Set ? allLabels : new Set();
  const hide = hidden instanceof Set ? hidden : new Set();
  if (!isSelectionActive({ locked, preview })) {
    const visible = new Set();
    for (const id of all) if (!hide.has(id)) visible.add(id);
    return visible;
  }
  const selected = new Set(locked instanceof Set ? locked : []);
  const previewId = asNumber(preview);
  if (previewId != null) selected.add(previewId);
  const visible = new Set();
  for (const id of selected) if (!hide.has(id)) visible.add(id);
  return visible;
}

/**
 * Effective hidden set: the complement of effectiveVisibleLabels over allLabels
 * when a selection is active, otherwise the raw user-hidden set (fallthrough).
 */
export function effectiveHiddenLabels({ hidden, locked, preview, allLabels } = {}) {
  if (!isSelectionActive({ locked, preview })) {
    return hidden instanceof Set ? new Set(hidden) : new Set(hidden || []);
  }
  const all = allLabels instanceof Set ? allLabels : new Set();
  const visible = effectiveVisibleLabels({ hidden, locked, preview, allLabels: all });
  const hiddenSet = new Set();
  for (const id of all) if (!visible.has(id)) hiddenSet.add(id);
  return hiddenSet;
}
