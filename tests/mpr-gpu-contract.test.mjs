import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gpuMprInputSupport } from '../js/mpr/mpr-gpu-support.js';

test('GPU MPR eligibility enforces texture, data, precision, and slab contracts', () => {
  const dims = { W: 4, H: 3, D: 2 };
  const vox = new Uint8Array(24);
  const base = { dims, vox, max3DTextureSize: 2048 };

  assert.equal(gpuMprInputSupport(base).supported, true);
  assert.match(gpuMprInputSupport({ ...base, dims: { W: 2049, H: 1, D: 1 }, vox: new Uint8Array(2049) }).reason, /exceeds/i);
  assert.match(gpuMprInputSupport({ ...base, vox: new Uint8Array(23) }).reason, /does not match/i);
  assert.match(gpuMprInputSupport({ ...base, vox: new Float32Array(24), floatLinearFiltering: false }).reason, /Float32/i);
  assert.match(gpuMprInputSupport({ ...base, projection: { sampleCount: 515 } }).reason, /sample budget/i);
});
