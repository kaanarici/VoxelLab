import assert from 'node:assert/strict';
import { test } from 'node:test';

const { presentRegionsForSlice } = await import('../js/atlas/atlas-anchors.js');

const series = { width: 4, height: 4, slices: 1 };
const labels = {
  available: true,
  meta: {
    legend: { 5: 'Liver', 9: 'Spleen' },
    colors: { 5: [10, 20, 30], 9: [40, 50, 60] },
  },
};

// 4x4 label plane: label 5 fills the top-left 2x2, label 9 the bottom-right 2x2.
function plane2x2() {
  const p = new Uint8Array(16);
  p[0] = p[1] = p[4] = p[5] = 5;
  p[10] = p[11] = p[14] = p[15] = 9;
  return p;
}

test('returns present regions with name, color, area, and centroid sorted top-to-bottom', () => {
  const { regions } = presentRegionsForSlice(series, 0, labels, { plane: plane2x2(), minAreaPx: 1 });
  assert.equal(regions.length, 2);
  assert.deepEqual(regions.map((r) => r.label), [5, 9]); // sorted by cy ascending
  assert.equal(regions[0].name, 'Liver');
  assert.deepEqual(regions[0].color, [10, 20, 30]);
  assert.equal(regions[0].areaPx, 4);
  assert.equal(regions[1].name, 'Spleen');
});

test('drops regions below the minimum area threshold', () => {
  const { regions } = presentRegionsForSlice(series, 0, labels, { plane: plane2x2() });
  assert.equal(regions.length, 0, '2x2 regions are below the default 8px floor');
});

test('respects hiddenLabels', () => {
  const { regions } = presentRegionsForSlice(series, 0, labels, {
    plane: plane2x2(),
    minAreaPx: 1,
    hiddenLabels: new Set([9]),
  });
  assert.deepEqual(regions.map((r) => r.label), [5]);
});

test('snaps the anchor to an in-region pixel for split/concave regions', () => {
  // Label 3 occupies only two far-apart pixels; the arithmetic centroid (1.5,0)
  // lands in background, so the snapped anchor must be one of the two pixels.
  const p = new Uint8Array(16);
  p[0] = 3; // (0,0)
  p[3] = 3; // (3,0)
  const { regions } = presentRegionsForSlice(
    series,
    0,
    { available: true, meta: { legend: { 3: 'X' }, colors: { 3: [1, 1, 1] } } },
    { plane: p, minAreaPx: 1 },
  );
  assert.equal(regions.length, 1);
  const px = Math.floor(regions[0].cx);
  const py = Math.floor(regions[0].cy);
  assert.equal(p[py * 4 + px], 3, 'anchor pixel must belong to the region');
});
