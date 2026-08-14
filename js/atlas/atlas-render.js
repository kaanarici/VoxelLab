// Keyed, persistent renderer for the atlas label overlays (2D + 3D). Each label
// owns ONE DOM node that is created once and mutated in place every frame, so
// positions snap (no smear while orbiting/scrubbing) while state changes
// (lock / fade / hover) animate via CSS — and nothing flashes or re-packs,
// because the SVG is never rebuilt. Both overlays share this so there is one
// place that owns pill lifecycle.

import { createAtlasItem, updateAtlasItem, buildAtlasCaption } from './atlas-svg.js';

const _state = new WeakMap(); // svg -> { nodes: Map<label, node>, caption }

function stateFor(svg) {
  let st = _state.get(svg);
  if (!st) { st = { nodes: new Map(), caption: null }; _state.set(svg, st); }
  return st;
}

/**
 * @param {SVGElement} svg
 * @param {Array<object>} items layout items (label, name, color, side, pillOuterX,
 *   anchorX, anchorY, pillCenterY, colW, locked, faded)
 * @param {string} captionText honesty caption (empty/falsey hides it)
 * @param {number} w @param {number} h overlay size (for caption placement)
 */
export function renderAtlasPills(svg, items, captionText, w, h) {
  const st = stateFor(svg);
  const { nodes } = st;
  const seen = new Set();
  for (const item of items) {
    seen.add(item.label);
    let node = nodes.get(item.label);
    if (!node) { node = createAtlasItem(); nodes.set(item.label, node); svg.appendChild(node.g); }
    updateAtlasItem(node, item);
  }
  for (const [label, node] of nodes) {
    if (!seen.has(label)) { node.g.remove(); nodes.delete(label); }
  }
  if (captionText) {
    if (!st.caption) { st.caption = buildAtlasCaption(captionText, w, h); svg.appendChild(st.caption); }
    st.caption.textContent = captionText;
    st.caption.setAttribute('x', (w / 2).toFixed(1));
    st.caption.setAttribute('y', (h - 10).toFixed(1));
  } else if (st.caption) {
    st.caption.remove();
    st.caption = null;
  }
}

/** Remove every node for an overlay (mode change / teardown). */
export function clearAtlasPills(svg) {
  const st = _state.get(svg);
  if (!st) return;
  for (const node of st.nodes.values()) node.g.remove();
  st.nodes.clear();
  if (st.caption) { st.caption.remove(); st.caption = null; }
}
