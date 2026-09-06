import { allLabelsFromMeta, effectiveVisibleLabels, isSelectionActive } from '../atlas/label-selection.js';

export function filteredRegionColors(baseColors, visibleSet) {
  if (!baseColors || !(visibleSet instanceof Set)) return baseColors || {};
  const out = {};
  for (const key of Object.keys(baseColors)) {
    if (visibleSet.has(Number(key))) out[key] = baseColors[key];
  }
  return out;
}

export function selectionRegionColors(baseColors, state) {
  if (!baseColors) return baseColors;
  if (!isSelectionActive({ locked: state.lockedLabels })) return baseColors;
  const visible = effectiveVisibleLabels({
    hidden: state.hiddenLabels,
    locked: state.lockedLabels,
    allLabels: allLabelsFromMeta(state.overlays.regionMeta),
  });
  return filteredRegionColors(baseColors, visible);
}
