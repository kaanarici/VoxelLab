import assert from 'node:assert/strict';
import { test } from 'node:test';

const { computeGradientRGBA8 } = await import('../js/volume/volume-gradient.js');

const DUMMY = 0; // edge term for a flat voxel

test('flat volume produces zero gradient and zero edge everywhere', () => {
  const W = 4, H = 4, D = 4;
  const src = new Uint8Array(W * H * D).fill(120);
  const out = computeGradientRGBA8(src, W, H, D, 0);
  assert.equal(out.length, W * H * D * 4);
  for (let i = 0; i < out.length; i += 4) {
    assert.equal(out[i], 128);     // 0.5 encoded
    assert.equal(out[i + 1], 128);
    assert.equal(out[i + 2], 128);
    assert.equal(out[i + 3], DUMMY);
  }
});

test('a ramp along +x yields a normal pointing in +x with a nonzero edge', () => {
  const W = 5, H = 1, D = 1;
  // 0, 64, 128, 192, 255 → smooth positive x gradient
  const src = new Uint8Array([0, 64, 128, 192, 255]);
  const out = computeGradientRGBA8(src, W, H, D, 0);
  // Interior voxel x=2: central diff (192-64)/255 > 0 → +x dominant, y/z flat.
  const o = 2 * 4;
  assert.ok(out[o] > 200, `expected strong +x normal, got ${out[o]}`);
  assert.equal(out[o + 1], 128);
  assert.equal(out[o + 2], 128);
  assert.ok(out[o + 3] > 0, 'edge term should be nonzero on a ramp');
});

test('float input is read directly (no /255) and matches uint8 scaling', () => {
  const W = 3, H = 1, D = 1;
  const u8 = new Uint8Array([0, 128, 255]);
  const f32 = new Float32Array([0, 128 / 255, 255 / 255]);
  const a = computeGradientRGBA8(u8, W, H, D, 0);
  const b = computeGradientRGBA8(f32, W, H, D, 1);
  assert.deepEqual([...a], [...b]);
});
