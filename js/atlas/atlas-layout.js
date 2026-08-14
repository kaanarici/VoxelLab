// Two-column label layout for the atlas view. Pure geometry, no DOM: given
// projected anchor points (stage px) and the image's horizontal center, assign
// each label to the left or right column by which half its anchor sits in,
// rebalance overflow toward the column with room, then lay each column out at a
// fixed equal pitch (ordered by anchor y), centred on the cluster. Equal spacing
// is intentional — the leader shoulders bridge each pill to its structure.

function capacity(bounds, rowH) {
  return Math.max(1, Math.floor((bounds.bottom - bounds.top) / rowH));
}

// Move items nearest the vertical divide from an overfull column to the other
// side until both fit (or neither can take more).
function rebalance(left, right, bounds, rowH, centerX) {
  const cap = capacity(bounds, rowH);
  const overfull = (a, b) => (a.length > cap && b.length < cap ? a : null);
  let guard = left.length + right.length;
  while (guard-- > 0) {
    const from = overfull(left, right) || overfull(right, left);
    if (!from) break;
    const to = from === left ? right : left;
    let idx = 0;
    let best = Infinity;
    from.forEach((it, i) => {
      const d = Math.abs(it.anchorX - centerX);
      if (d < best) { best = d; idx = i; }
    });
    to.push(from.splice(idx, 1)[0]);
  }
}

function placeColumn(items, side, bounds, rowH) {
  const sorted = items
    .map((it) => ({ ...it, side, y: it.anchorY }))
    .sort((a, b) => a.y - b.y);
  const n = sorted.length;
  if (!n) return sorted;

  // EXACTLY equal vertical spacing: stack at a fixed rowH pitch (ordered by
  // anchor y to minimise leader crossings), then slide the whole block so it
  // centres on the mean anchor y (shortest leaders), clamped to the bounds. The
  // leader shoulders absorb the offset between a pill's even slot and its real
  // structure position.
  const top = bounds.top + rowH / 2;
  const bottom = bounds.bottom - rowH / 2;
  const span = (n - 1) * rowH;
  const meanY = sorted.reduce((s, it) => s + it.anchorY, 0) / n;
  const start = span >= bottom - top
    ? top
    : Math.max(top, Math.min(meanY - span / 2, bottom - span));
  for (let i = 0; i < n; i += 1) sorted[i].y = start + i * rowH;
  return sorted;
}

/**
 * @param {object} a
 * @param {Array<{anchorX:number, anchorY:number}>} a.items projected anchors (stage px)
 * @param {{top:number, bottom:number}} a.bounds vertical pill-center range (stage px)
 * @param {number} a.centerX image horizontal center (stage px) — the left/right split
 * @param {number} a.rowH pill height + vertical gap (stage px)
 * @returns {Array<object>} each input item plus { side:'left'|'right', y } (y = pill center)
 */
export function layoutAtlasLabels({ items, bounds, centerX, rowH }) {
  const left = [];
  const right = [];
  for (const it of items) (it.anchorX < centerX ? left : right).push(it);
  rebalance(left, right, bounds, rowH, centerX);
  return [
    ...placeColumn(left, 'left', bounds, rowH),
    ...placeColumn(right, 'right', bounds, rowH),
  ];
}
