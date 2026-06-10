import assert from 'node:assert/strict';
import { test } from 'node:test';

const { projectStack } = await import('../js/microscopy/microscopy-projection.js');

// 2x1 plane stack, 3 Z planes. Per-pixel columns: x0 = [10, 40, 70], x1 = [0, 30000, 60000].
const planes = [
  { width: 2, height: 1, pixels: new Float32Array([10, 0]) },
  { width: 2, height: 1, pixels: new Float32Array([40, 30000]) },
  { width: 2, height: 1, pixels: new Float32Array([70, 60000]) },
];

test('projectStack max takes the per-pixel maximum across Z', () => {
  const { pixels, mode, zRange } = projectStack(planes, { mode: 'max' });
  assert.deepEqual([...pixels], [70, 60000]);
  assert.equal(mode, 'max');
  assert.deepEqual(zRange, [0, 2]);
});

test('projectStack mean and sum collapse Z', () => {
  assert.deepEqual([...projectStack(planes, { mode: 'sum' }).pixels], [120, 90000]);
  assert.deepEqual([...projectStack(planes, { mode: 'mean' }).pixels], [40, 30000]);
});

test('projectStack sd is the sample standard deviation across Z', () => {
  const sd = projectStack(planes, { mode: 'sd' }).pixels;
  // x0 = [10,40,70], mean 40, sample variance ((30^2+0+30^2)/2)=900 → sd 30.
  assert.ok(Math.abs(sd[0] - 30) < 1e-9);
});

test('projectStack honors an inclusive z range', () => {
  assert.deepEqual([...projectStack(planes, { mode: 'max', zRange: [0, 1] }).pixels], [40, 30000]);
});

test('projectStack fails closed on empty or mismatched input', () => {
  assert.throws(() => projectStack([], { mode: 'max' }), /no planes/);
  assert.throws(() => projectStack([
    { width: 2, height: 1, pixels: new Float32Array([1, 2]) },
    { width: 3, height: 1, pixels: new Float32Array([1, 2, 3]) },
  ], { mode: 'max' }), /size mismatch/);
  assert.throws(() => projectStack(planes, { mode: 'nope' }), /unknown mode/);
});
