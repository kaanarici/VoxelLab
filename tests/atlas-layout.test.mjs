import assert from 'node:assert/strict';
import { test } from 'node:test';

const { layoutAtlasLabels } = await import('../js/atlas/atlas-layout.js');

const bounds = { top: 0, bottom: 300 };
const rowH = 30;

test('splits items into left/right columns by the image center', () => {
  const items = [
    { id: 'a', anchorX: 10, anchorY: 50 },
    { id: 'b', anchorX: 90, anchorY: 60 },
  ];
  const placed = layoutAtlasLabels({ items, bounds, centerX: 50, rowH });
  const byId = Object.fromEntries(placed.map((p) => [p.id, p]));
  assert.equal(byId.a.side, 'left');
  assert.equal(byId.b.side, 'right');
});

test('resolves overlaps so no two pills in a column are closer than rowH', () => {
  // All on the left, all wanting the same y -> must be spread out.
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i, anchorX: 5, anchorY: 150 }));
  const placed = layoutAtlasLabels({ items, bounds, centerX: 50, rowH }).sort((p, q) => p.y - q.y);
  for (let i = 1; i < placed.length; i += 1) {
    assert.ok(placed[i].y - placed[i - 1].y >= rowH - 1e-6, 'adjacent pills overlap');
  }
});

test('keeps every pill within the vertical bounds', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: i, anchorX: 5, anchorY: i < 4 ? -100 : 9999 }));
  const placed = layoutAtlasLabels({ items, bounds, centerX: 50, rowH });
  for (const p of placed) {
    assert.ok(p.y >= bounds.top + rowH / 2 - 1e-6, 'pill above top bound');
    assert.ok(p.y <= bounds.bottom - rowH / 2 + 1e-6, 'pill below bottom bound');
  }
});

test('rebalances overflow from a full column to the one with room', () => {
  // 20 items all on the left, but only 10 rows fit -> overflow moves right.
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i, anchorX: 49, anchorY: i * 5 }));
  const placed = layoutAtlasLabels({ items, bounds, centerX: 50, rowH });
  const right = placed.filter((p) => p.side === 'right');
  assert.ok(right.length > 0, 'expected overflow to move to the right column');
});
