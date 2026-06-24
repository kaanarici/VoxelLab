// Isolate the 2D colored region mask without a shader edit: the slice compositor
// builds its region LUT from the regionColors map and paints nothing for labels
// whose color is absent (GLSL skips color (0,0,0); the CPU path skips when
// regionColors[label] is undefined). So passing a map containing ONLY the
// visible labels makes every other structure render as plain base pixels.
//
// Pure and non-mutating: never touch the shared regionMeta.colors map.

import { allLabelsFromMeta, effectiveVisibleLabels, isSelectionActive } from '../atlas/label-selection.js';

/**
 * Return a new colors map containing only entries whose numeric label is in
 * `visibleSet`. `baseColors` is the unfiltered { [label]: [r,g,b] } map.
 */
export function filteredRegionColors(baseColors, visibleSet) {
  if (!baseColors || !(visibleSet instanceof Set)) return baseColors || {};
  const out = {};
  for (const key of Object.keys(baseColors)) {
    if (visibleSet.has(Number(key))) out[key] = baseColors[key];
  }
  return out;
}

/**
 * Region colors for the 2D colored mask, isolated to the live anatomy selection
 * when one is active. Returns `baseColors` unchanged when no selection is in
 * effect, so the default render path is untouched. Pure: never mutates inputs.
 */
export function selectionRegionColors(baseColors, state) {
  if (!baseColors) return baseColors;
  if (!isSelectionActive({ locked: state.lockedLabels, preview: state.previewLabel })) return baseColors;
  const visible = effectiveVisibleLabels({
    hidden: state.hiddenLabels,
    locked: state.lockedLabels,
    preview: state.previewLabel,
    allLabels: allLabelsFromMeta(state.regionMeta),
  });
  return filteredRegionColors(baseColors, visible);
}
