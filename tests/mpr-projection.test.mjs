import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  clampSlabThicknessMm,
  createMprProjection,
  maximumAccurateSlabThicknessMm,
  normalizeMprProjectionMode,
  projectDiscreteSlabLabel,
  projectVolumeSample,
  projectionCacheToken,
} = await import('../js/mpr/mpr-projection.js');

test('projection helpers normalize mode and slab thickness bounds', () => {
  assert.equal(normalizeMprProjectionMode('mip'), 'mip');
  assert.equal(normalizeMprProjectionMode('bad'), 'thin');
  assert.equal(clampSlabThicknessMm(-5), 0);
  assert.equal(clampSlabThicknessMm(999), 160);
});

test('createMprProjection derives slab sampling from plane normal and spacing', () => {
  const projection = createMprProjection(
    { mode: 'avg', slabThicknessMm: 6 },
    { row: 1, col: 1, slice: 2 },
    { axisU: [1, 0, 0], axisV: [0, 1, 0] },
  );

  assert.equal(projection.mode, 'avg');
  assert.equal(projection.sampleCount % 2, 1, 'slab sampling must include the selected plane center');
  assert.deepEqual(projection.slabStep, [0, 0, 0.5]);
  assert.equal(projectionCacheToken(projection), `avg:6:${projection.sampleCount}`);
});

test('thick-slab MIP includes a one-voxel maximum at the selected plane center', () => {
  const dims = { W: 1, H: 1, D: 81 };
  const vox = new Float32Array(dims.D);
  vox[40] = 1;
  const projection = createMprProjection(
    { mode: 'mip', slabThicknessMm: 40 },
    { row: 0.5, col: 0.5, slice: 0.5 },
    { axisU: [1, 0, 0], axisV: [0, 1, 0] },
  );
  const sampler = (volume, _x, _y, z) => volume[Math.max(0, Math.min(dims.D - 1, Math.round(z)))];

  assert.equal(projection.sampleCount % 2, 1);
  assert.equal(projectVolumeSample(vox, 0, 0, 40, dims, sampler, projection), 1);
});

test('slab AVG excludes out-of-volume support instead of repeating edge voxels', () => {
  const dims = { W: 1, H: 1, D: 3 };
  const vox = Float32Array.from([10, 20, 30]);
  const sampler = (volume, _x, _y, z) => volume[Math.round(z)];
  const projection = { mode: 'avg', sampleCount: 3, slabStep: [0, 0, 1] };

  assert.equal(projectVolumeSample(vox, 0, 0, 0, dims, sampler, projection), 15);
});

test('accurate slab limit scales down for microscopic calibration instead of undersampling', () => {
  const medical = maximumAccurateSlabThicknessMm({ row: 0.5, col: 0.5, slice: 0.5 });
  const microscopy = maximumAccurateSlabThicknessMm({ row: 0.0005, col: 0.0005, slice: 0.001 });

  assert.ok(medical > 40);
  assert.ok(microscopy > 0 && microscopy < 1);
  assert.equal(clampSlabThicknessMm(40, { row: 0.0005, col: 0.0005, slice: 0.001 }), microscopy);
});

test('createMprProjection uses physical-space plane normal for anisotropic voxels', () => {
  const projection = createMprProjection(
    { mode: 'avg', slabThicknessMm: 6 },
    { row: 1, col: 1, slice: 3 },
    { axisU: [1, 0, 0], axisV: [0, 1, 1] },
  );
  const axisUPhysical = [1, 0, 0];
  const axisVPhysical = [0, 1, 3];
  const stepPhysical = [
    projection.slabStep[0],
    projection.slabStep[1],
    projection.slabStep[2] * 3,
  ];

  assert.ok(Math.abs(stepPhysical[0] * axisUPhysical[0] + stepPhysical[1] * axisUPhysical[1] + stepPhysical[2] * axisUPhysical[2]) < 1e-6);
  assert.ok(Math.abs(stepPhysical[0] * axisVPhysical[0] + stepPhysical[1] * axisVPhysical[1] + stepPhysical[2] * axisVPhysical[2]) < 1e-6);
});

test('projectVolumeSample supports avg, mip, and minip slab aggregation', () => {
  const dims = { W: 1, H: 1, D: 3 };
  const vox = Float32Array.from([0.1, 0.5, 0.9]);
  const sampler = (volume, _x, _y, z) => volume[Math.max(0, Math.min(2, Math.round(z)))];
  const avgProjection = {
    mode: 'avg',
    slabThicknessMm: 2,
    sampleCount: 3,
    slabStep: [0, 0, 1],
  };
  const mipProjection = { ...avgProjection, mode: 'mip' };
  const minipProjection = { ...avgProjection, mode: 'minip' };

  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, avgProjection) - 0.5) < 1e-6);
  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, mipProjection) - 0.9) < 1e-6);
  assert.ok(Math.abs(projectVolumeSample(vox, 0, 0, 1, dims, sampler, minipProjection) - 0.1) < 1e-6);
});

test('projectDiscreteSlabLabel follows MIP/minIP winner and nearest AVG nonzero label', () => {
  const dims = { W: 1, H: 1, D: 3 };
  const base = Float32Array.from([0.9, 0.5, 0.1]);
  const labels = Uint8Array.from([7, 0, 3]);
  const sampler = (volume, _x, _y, z) => volume[Math.max(0, Math.min(2, Math.round(z)))];
  const projection = {
    mode: 'mip',
    slabThicknessMm: 2,
    sampleCount: 3,
    slabStep: [0, 0, 1],
  };

  assert.equal(projectDiscreteSlabLabel(labels, base, 0, 0, 1, dims, sampler, projection), 7);
  assert.equal(projectDiscreteSlabLabel(labels, base, 0, 0, 1, dims, sampler, { ...projection, mode: 'minip' }), 3);
  assert.equal(projectDiscreteSlabLabel(labels, base, 0, 0, 1, dims, sampler, { ...projection, mode: 'avg' }), 7);
});
