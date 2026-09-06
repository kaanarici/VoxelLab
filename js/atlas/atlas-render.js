import { createAtlasItem, updateAtlasItem, buildAtlasCaption } from './atlas-svg.js';

const _state = new WeakMap();

function stateFor(svg) {
  let st = _state.get(svg);
  if (!st) { st = { nodes: new Map(), caption: null }; _state.set(svg, st); }
  return st;
}

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

export function clearAtlasPills(svg) {
  const st = _state.get(svg);
  if (!st) return;
  for (const node of st.nodes.values()) node.g.remove();
  st.nodes.clear();
  if (st.caption) { st.caption.remove(); st.caption = null; }
}
