import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraViewChanged, matricesChanged } from '../js/atlas/atlas-camera-change.js';

test('matricesChanged reports projection-only edits the way ortho zoom does', () => {
  const last = new Float64Array(16);
  const first = new Float64Array(16);
  first[0] = 1;
  assert.equal(matricesChanged(first, last), true);
  assert.equal(matricesChanged(first, last), false);
  const zoomed = Float64Array.from(first);
  zoomed[0] = 2;
  assert.equal(matricesChanged(zoomed, last), true);
});

test('cameraViewChanged treats projectionMatrix as camera motion', () => {
  const lastWorld = new Float64Array(16);
  const lastProj = new Float64Array(16);
  const identity = {
    matrixWorld: { elements: new Float64Array(16) },
    projectionMatrix: { elements: new Float64Array(16) },
  };
  identity.matrixWorld.elements[0] = 1;
  identity.projectionMatrix.elements[0] = 1;
  assert.equal(cameraViewChanged(identity, lastWorld, lastProj), true);
  assert.equal(cameraViewChanged(identity, lastWorld, lastProj), false);
  identity.projectionMatrix.elements[0] = 2;
  assert.equal(cameraViewChanged(identity, lastWorld, lastProj), true, 'ortho zoom must count as motion');
  identity.matrixWorld.elements[12] = 0.4;
  assert.equal(cameraViewChanged(identity, lastWorld, lastProj), true, 'orbit still counts as motion');
});
