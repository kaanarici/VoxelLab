import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryFromSeries } from '../js/core/geometry.js';
import { applyAffineToPositions } from '../js/mesh/mesh-transform.js';

test('identity spacing + IPP offset: voxel coords shift by firstIPP', () => {
  const series = {
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    slices: 4,
    orientation: [1, 0, 0, 0, 1, 0],
    firstIPP: [10, 20, 30],
    lastIPP: [10, 20, 33],
  };
  const geo = geometryFromSeries(series);
  const out = applyAffineToPositions(new Float32Array([2, 3, 1]), geo.affineLps);
  assert.deepEqual([...out].map((v) => Math.round(v * 1e6) / 1e6), [12, 23, 31]);
});

test('anisotropic spacing pins the col->X / row->Y axis pairing', () => {
  // colSpacing = pixelSpacing[1] = 2 scales X; rowSpacing = pixelSpacing[0] = 5 scales Y.
  const series = {
    pixelSpacing: [5, 2],
    sliceSpacing: 4,
    slices: 3,
    orientation: [1, 0, 0, 0, 1, 0],
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 8],
  };
  const geo = geometryFromSeries(series);
  // vertex.x=column=3 -> 6mm X; vertex.y=row=2 -> 10mm Y; vertex.z=slice=1 -> 4mm Z.
  const out = applyAffineToPositions(new Float32Array([3, 2, 1]), geo.affineLps);
  assert.deepEqual([...out].map((v) => Math.round(v * 1e6) / 1e6), [6, 10, 4]);
});

test('non-identity IOP rotates correctly (column dir along -Y)', () => {
  // row = (0,1,0), col = (-1,0,0): a 90-degree in-plane rotation.
  const series = {
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    slices: 2,
    orientation: [0, 1, 0, -1, 0, 0],
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
  };
  const geo = geometryFromSeries(series);
  // column=1 along row dir (0,1,0); row=0; slice=0 -> patient (0,1,0).
  const out = applyAffineToPositions(new Float32Array([1, 0, 0]), geo.affineLps);
  assert.deepEqual([...out].map((v) => Math.round(v * 1e6) / 1e6), [0, 1, 0]);
});
