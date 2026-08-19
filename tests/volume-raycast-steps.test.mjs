import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  volumeProjectionSamplingSupport,
  MAX_RAYCAST_STEPS,
  raycastStepCount,
} = await import('../js/core/volume-limits.js');

test('raycastStepCount uses the represented voxel diagonal for every render mode', () => {
  const required = Math.ceil(Math.hypot(639, 511, 255)) + 1;
  assert.equal(raycastStepCount({ width: 640, height: 512, depth: 256, renderMode: 'alpha' }), required);
  assert.equal(raycastStepCount({ width: 640, height: 512, depth: 256, renderMode: 'mip' }), required);
});

test('raycastStepCount clamps unsupported volumes at the shader loop bound', () => {
  assert.equal(raycastStepCount({ width: 4096, height: 128, depth: 128, renderMode: 'mip' }), MAX_RAYCAST_STEPS);
});

test('sampled 3D extrema preview fails closed beyond the shader loop budget', () => {
  assert.equal(volumeProjectionSamplingSupport({ width: 2048, height: 1, depth: 1 }).supported, true);
  assert.equal(volumeProjectionSamplingSupport({ width: 2049, height: 1, depth: 1 }).supported, false);
});
