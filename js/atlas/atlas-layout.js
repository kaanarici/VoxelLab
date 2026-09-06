function capacity(bounds, rowH) {
  return Math.max(1, Math.floor((bounds.bottom - bounds.top) / rowH));
}

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
