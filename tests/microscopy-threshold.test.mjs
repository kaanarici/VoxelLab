import assert from 'node:assert/strict';
import { test } from 'node:test';

const { computeThreshold, applyThreshold } = await import('../js/microscopy/microscopy-threshold.js');

// Bimodal raw plane: half background (100), half signal (5000). 16 pixels.
const bimodal = {
  width: 4, height: 4,
  pixels: new Float32Array([
    100, 100, 100, 100,
    100, 100, 100, 100,
    5000, 5000, 5000, 5000,
    5000, 5000, 5000, 5000,
  ]),
};

test('computeThreshold manual returns the exact numeric cut, never the method', () => {
  const t = computeThreshold(bimodal, { method: 'manual', value: 2500 });
  assert.equal(t.resolvedValue, 2500);
  assert.equal(typeof t.resolvedValue, 'number');
});

test('computeThreshold otsu resolves a numeric cut between the two clusters', () => {
  const t = computeThreshold(bimodal, { method: 'otsu' });
  assert.equal(typeof t.resolvedValue, 'number');
  assert.ok(t.resolvedValue > 100 && t.resolvedValue < 5000, `otsu cut ${t.resolvedValue} between clusters`);
  assert.equal(t.pixelMin, 100);
  assert.equal(t.pixelMax, 5000);
});

test('computeThreshold darkBackground flips the band', () => {
  const dark = computeThreshold(bimodal, { method: 'manual', value: 2500, darkBackground: true });
  assert.deepEqual([dark.lo, dark.hi], [2500, Infinity]);
  const light = computeThreshold(bimodal, { method: 'manual', value: 2500, darkBackground: false });
  assert.deepEqual([light.lo, light.hi], [-Infinity, 2500]);
});

test('applyThreshold selects pixels inside the band', () => {
  const t = computeThreshold(bimodal, { method: 'manual', value: 2500, darkBackground: true });
  const mask = applyThreshold(bimodal, t);
  assert.equal(mask.reduce((s, v) => s + v, 0), 8, 'the 8 signal pixels pass');
});

test('computeThreshold fails closed on unresolved or unknown method', () => {
  assert.throws(() => computeThreshold(bimodal, { method: 'manual', value: NaN }), /unresolved/);
  assert.throws(() => computeThreshold(bimodal, { method: 'bogus' }), /unknown method/);
});
