import assert from 'node:assert/strict';
import { test } from 'node:test';

const { slimsamResizeLogits } = await import('../js/overlay/slimsam-inference.js');
const { validateSlimSAMMeta } = await import('../js/overlay/slimsam.js');

test('slimsamResizeLogits thresholds native-size decoder masks', () => {
  const mask = slimsamResizeLogits(new Float32Array([-0.1, 0.2, 0, 3]), 2, 2, 2, 2);
  assert.deepEqual([...mask], [0, 255, 0, 255]);
});

test('slimsamResizeLogits bilinear-resizes logits before thresholding', () => {
  const lowRes = new Float32Array([
    -1, 1,
    1, 1,
  ]);
  const mask = slimsamResizeLogits(lowRes, 2, 2, 4, 4);
  assert.equal(mask.length, 16);
  assert.equal(mask[0], 0);
  assert.equal(mask[3], 255);
  assert.equal(mask[12], 255);
  assert.equal(mask[15], 255);
  assert.deepEqual([...mask.slice(0, 8)], [0, 0, 255, 255, 0, 0, 255, 255]);
});

test('validateSlimSAMMeta rejects sidecars for a different series geometry', () => {
  const meta = { width: 512, height: 512, slices: 12, embed_dim: 256, embed_h: 64, embed_w: 64 };
  const series = { width: 512, height: 384, slices: 12 };
  assert.deepEqual(validateSlimSAMMeta(meta, series), {
    valid: false,
    reason: 'geometry_mismatch',
    expected: { width: 512, height: 384, slices: 12 },
  });
});

test('validateSlimSAMMeta accepts matching sidecars', () => {
  const meta = { width: 512, height: 384, slices: 12, embed_dim: 256, embed_h: 64, embed_w: 64 };
  const series = { width: 512, height: 384, slices: 12 };
  assert.equal(validateSlimSAMMeta(meta, series).valid, true);
});
