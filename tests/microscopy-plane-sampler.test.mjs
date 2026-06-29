import assert from 'node:assert/strict';
import { test } from 'node:test';

const { samplePlaneIntensity, boundsOfPoints } = await import('../js/microscopy/microscopy-plane-sampler.js');

const all = () => true;

test('samplePlaneIntensity accumulates raw single-channel values over the bbox', () => {
  // 3x2 plane, row-major. Values chosen > 255 to prove raw (not 8-bit) domain.
  const plane = { width: 3, height: 2, pixels: new Float32Array([40000, 10000, 20000, 0, 30000, 5000]) };
  const { n, sum, sum2, min, max } = samplePlaneIntensity(plane, all, { minX: 0, maxX: 2, minY: 0, maxY: 1 });
  assert.equal(n, 6);
  assert.equal(sum, 40000 + 10000 + 20000 + 0 + 30000 + 5000);
  assert.equal(min, 0);
  assert.equal(max, 40000);
  assert.equal(sum2, 40000 ** 2 + 10000 ** 2 + 20000 ** 2 + 0 + 30000 ** 2 + 5000 ** 2);
});

test('samplePlaneIntensity respects the inclusion test at pixel centers', () => {
  const plane = { width: 2, height: 1, pixels: new Float32Array([40000, 10000]) };
  // Only the left pixel center (0.5) is inside.
  const inside = (cx) => cx < 1;
  const { n, sum, min, max } = samplePlaneIntensity(plane, inside, { minX: 0, maxX: 1, minY: 0, maxY: 0 });
  assert.equal(n, 1);
  assert.equal(sum, 40000);
  assert.equal(min, 40000);
  assert.equal(max, 40000);
});

test('samplePlaneIntensity clamps the bbox to the plane and fails closed when empty', () => {
  const plane = { width: 2, height: 2, pixels: new Float32Array([1, 2, 3, 4]) };
  const out = samplePlaneIntensity(plane, () => false, { minX: -5, maxX: 99, minY: -5, maxY: 99 });
  assert.equal(out.n, 0);
  assert.equal(out.min, Infinity);
  assert.equal(out.max, -Infinity);
});

test('boundsOfPoints returns the inclusive extent', () => {
  assert.deepEqual(boundsOfPoints([[2, 3], [8, 1], [5, 9]]), { minX: 2, maxX: 8, minY: 1, maxY: 9 });
});
