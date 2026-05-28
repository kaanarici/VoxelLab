import assert from 'node:assert/strict';
import { test } from 'node:test';

const { MAX_RAYCAST_STEPS, raycastStepCount } = await import('../js/volume-raycast-steps.js');

test('raycastStepCount keeps alpha rendering at the default interactive budget', () => {
  assert.equal(raycastStepCount({ width: 4096, height: 512, depth: 512, renderMode: 'alpha' }), 512);
});

test('raycastStepCount samples MIP and minIP at least to the longest represented axis', () => {
  assert.equal(raycastStepCount({ width: 640, height: 512, depth: 256, renderMode: 'mip' }), 640);
  assert.equal(raycastStepCount({ width: 128, height: 900, depth: 512, renderMode: 'minip' }), 900);
  assert.equal(raycastStepCount({ width: 4096, height: 128, depth: 128, renderMode: 'mip' }), MAX_RAYCAST_STEPS);
});
