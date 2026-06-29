// Shared SVG building blocks for the 3D anatomy-label callouts (atlas-3d.js).
// Nodes are created programmatically (no innerHTML); per-region colors are set
// as fill/stroke attributes.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const PILL_H = 26;
export const PILL_VGAP = 7;
export const ROW_H = PILL_H + PILL_VGAP;
// Leader shape: a horizontal shoulder of this length runs inward off the pill,
// then a straight diagonal to the target dot (an "L"). Long enough to read as a
// distinct shoulder rather than one slanted line.
export const ELBOW = 24;
const PILL_PAD_X = 9;
const DOT_R = 4;
const DOT_GAP = 8;
const MARKER_R = 3.5;
const TEXT_FONT = '500 13px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';

export function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

export function rgb(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Small always-on honesty caption for the label overlay (bottom-center). */
export function buildAtlasCaption(text, w, h) {
  const t = svgEl('text', { class: 'atlas-caption', x: (w / 2).toFixed(1), y: (h - 10).toFixed(1), 'text-anchor': 'middle' });
  t.textContent = text;
  return t;
}

let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  _measureCtx.font = TEXT_FONT;
  return _measureCtx;
}

/** Truncate `text` with an ellipsis so it fits `maxWidth` px in the pill font. */
export function fitText(text, maxWidth) {
  const ctx = measureCtx();
  const full = ctx.measureText(text).width;
  if (full <= maxWidth) return { text, width: full };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const clipped = `${text.slice(0, lo)}…`;
  return { text: clipped, width: ctx.measureText(clipped).width };
}

/** Max text width (px) that fits a pill inside a column of width `colW`. */
export function pillTextBudget(colW) {
  return colW - PILL_PAD_X * 2 - DOT_R * 2 - DOT_GAP;
}

const LOCK_R = 8;

// Padlock glyph centred on (0,0); the lock <g> is translated into place per frame.
function buildLockGlyph() {
  const g = svgEl('g', { class: 'atlas-lock', role: 'button' });
  g.appendChild(svgEl('circle', { class: 'atlas-lock-hit', cx: 0, cy: 0, r: LOCK_R }));
  g.appendChild(svgEl('rect', { class: 'atlas-lock-body', x: -3.5, y: -0.5, width: 7, height: 5.5, rx: 1 }));
  g.appendChild(svgEl('path', {
    class: 'atlas-lock-shackle', fill: 'none',
    d: 'M -2.2 -0.5 L -2.2 -3.4 A 2.2 2.2 0 0 1 2.2 -3.4 L 2.2 -0.5',
  }));
  return g;
}

/**
 * Create one callout node ONCE: <g.atlas-item> = leader + anchor marker + pill
 * (bg + colour dot + name + lock). The lock is a child of the PILL so hovering it
 * keeps the pill hovered (reachable, no deselect). Nodes are mutated in place by
 * `updateAtlasItem` — never recreated — so positions snap (no smear while
 * orbiting) while state (lock/fade/hover/expand) animates via CSS, no flicker.
 */
export function createAtlasItem() {
  const g = svgEl('g', { class: 'atlas-item' });
  const leader = svgEl('polyline', { class: 'atlas-leader', fill: 'none' });
  const marker = svgEl('circle', { class: 'atlas-marker', r: MARKER_R });
  const pill = svgEl('g', { class: 'atlas-pill' });
  const bg = svgEl('rect', { class: 'atlas-pill-bg', y: 0, height: PILL_H, rx: 7 });
  const dot = svgEl('circle', { class: 'atlas-pill-dot', cy: PILL_H / 2, r: DOT_R });
  const text = svgEl('text', { class: 'atlas-pill-text', y: PILL_H / 2, 'dominant-baseline': 'central' });
  const lock = buildLockGlyph();
  pill.append(bg, dot, text, lock); // lock INSIDE the pill → hovering it stays "on the pill"
  g.append(leader, marker, pill);
  return { g, leader, marker, pill, bg, dot, text, lock, _key: '', _pw: 0 };
}

/** Update a callout node in place from a layout item (see createAtlasItem). */
export function updateAtlasItem(node, item) {
  const { label, name, color, side, pillOuterX, anchorX, anchorY, pillCenterY, colW, locked, faded } = item;
  const left = side === 'left';
  const col = rgb(color);

  // The pill internals (text, dot, lock slot, bg sizing) are constant per
  // label/side/colW — recompute only when one changes (rare: resize/rebalance).
  const key = `${name}|${side}|${colW}`;
  if (node._key !== key) {
    node._key = key;
    const fit = fitText(name, pillTextBudget(colW));
    // measureText can under-measure the SVG fallback font; pad so text clears the dot.
    const textW = fit.width + Math.max(6, fit.width * 0.08);
    const pw = PILL_PAD_X * 2 + DOT_R * 2 + DOT_GAP + textW; // collapsed: text only, NO reserved lock space
    node._pw = pw;
    node.text.textContent = fit.text;
    node.bg.setAttribute('width', pw.toFixed(2));
    const dotCx = left ? PILL_PAD_X + DOT_R : pw - PILL_PAD_X - DOT_R;
    node.dot.setAttribute('cx', dotCx.toFixed(2));
    node.text.setAttribute('x', (left ? PILL_PAD_X + DOT_R * 2 + DOT_GAP : PILL_PAD_X).toFixed(2));
    // The lock occupies the colour dot's exact slot — an icon swap (dot by
    // default, lock on hover / when locked). It never juts out, sits on the
    // outer/dot side, the pill width is fixed (no expand), and it's a pill child
    // so hovering it keeps the pill hovered (no deselect).
    node.lock.setAttribute('transform', `translate(${dotCx.toFixed(2)},${(PILL_H / 2).toFixed(2)})`);
  }

  const pw = node._pw;
  const gx = left ? pillOuterX : pillOuterX - pw;
  const gy = pillCenterY - PILL_H / 2;
  const innerX = left ? gx + pw : gx;
  const elbowX = left ? innerX + ELBOW : innerX - ELBOW;

  node.pill.setAttribute('transform', `translate(${gx.toFixed(2)},${gy.toFixed(2)})`);
  node.dot.setAttribute('fill', col);
  // The lock occupies the dot's slot and wears the structure's colour, so the
  // dot→lock hover/lock swap reads as the same coloured mark changing shape.
  node.lock.style.setProperty('--lock-color', col);
  node.marker.setAttribute('fill', col);
  node.marker.setAttribute('cx', anchorX.toFixed(2));
  node.marker.setAttribute('cy', anchorY.toFixed(2));
  node.leader.setAttribute('stroke', col);
  node.leader.setAttribute('points',
    `${innerX.toFixed(2)},${pillCenterY.toFixed(2)} ${elbowX.toFixed(2)},${pillCenterY.toFixed(2)} ${anchorX.toFixed(2)},${anchorY.toFixed(2)}`);
  if (label != null) {
    node.pill.setAttribute('data-label', String(label));
    node.lock.setAttribute('data-lock-label', String(label));
  }
  // Volume hover tooltip via the app's standard [data-tip] manager (grace-window
  // successive-hover state, consistent design) — placed on the inner/model side.
  if (item.tip) {
    node.pill.setAttribute('data-tip', item.tip);
    node.pill.setAttribute('data-tip-pos', left ? 'right' : 'left');
  } else {
    node.pill.removeAttribute('data-tip');
  }
  node.pill.classList.toggle('locked', !!locked);
  node.lock.classList.toggle('locked', !!locked);
  node.lock.setAttribute('aria-pressed', locked ? 'true' : 'false');
  node.lock.setAttribute('aria-label', locked ? 'Unlock structure' : 'Lock structure');
  node.g.classList.toggle('faded', !!faded);
}
