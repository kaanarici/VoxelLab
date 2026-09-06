const RESERVED_LABELS = new Set([0, 254, 255]);

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function allLabelsFromMeta(regionMeta) {
  const regions = regionMeta?.regions;
  if (!regions || Array.isArray(regions) || Object.getPrototypeOf(regions) !== Object.prototype) return new Set();
  const out = new Set();
  for (const key of Object.keys(regions)) {
    const id = asNumber(key);
    if (id != null && !RESERVED_LABELS.has(id)) out.add(id);
  }
  return out;
}

export function isSelectionActive({ locked } = {}) {
  return locked instanceof Set && locked.size > 0;
}

export function effectiveVisibleLabels({ hidden, locked, allLabels } = {}) {
  const all = allLabels instanceof Set ? allLabels : new Set();
  const hide = hidden instanceof Set ? hidden : new Set();
  const selected = isSelectionActive({ locked }) ? locked : all;
  const visible = new Set();
  for (const id of selected) if (!hide.has(id)) visible.add(id);
  return visible;
}

export function effectiveHiddenLabels({ hidden, locked, allLabels } = {}) {
  if (!isSelectionActive({ locked })) {
    return hidden instanceof Set ? new Set(hidden) : new Set(hidden || []);
  }
  const all = allLabels instanceof Set ? allLabels : new Set();
  const visible = effectiveVisibleLabels({ hidden, locked, allLabels: all });
  const hiddenSet = new Set();
  for (const id of all) if (!visible.has(id)) hiddenSet.add(id);
  return hiddenSet;
}
