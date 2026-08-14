import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampClipPlaneDepth,
  clipPlaneContainsPoint,
  volumeClipPlane,
} from '../js/volume/volume-clip-plane.js';
import { VOLUME_RAYCAST_FRAGMENT_SHADER } from '../js/volume/volume-raycast-shaders.js';

const unitVolume = {
  dims: { W: 11, H: 11, D: 11 },
  spacing: { row: 1, col: 1, slice: 1 },
};

test('volumeClipPlane moves an axial plane through the normalized volume', () => {
  const plane = volumeClipPlane({ ...unitVolume, yaw: 45, pitch: 0, depth: 0.36 });
  assert.equal(clipPlaneContainsPoint(plane, [0.5, 0.5, 0.35]), false);
  assert.equal(clipPlaneContainsPoint(plane, [0.5, 0.5, 0.36]), true);
  assert.equal(clipPlaneContainsPoint(plane, [0.5, 0.5, 1]), true);
});

test('volumeClipPlane honors physical anisotropy for arbitrary orientations', () => {
  const plane = volumeClipPlane({
    dims: { W: 5, H: 7, D: 9 },
    spacing: { row: 2, col: 0.5, slice: 3 },
    yaw: 45,
    pitch: 36.3,
    depth: 0.5,
  });
  assert.ok(plane.every(Number.isFinite));
  assert.equal(clipPlaneContainsPoint(plane, [0.5, 0.5, 0.5]), true);
  assert.notEqual(clipPlaneContainsPoint(plane, [0, 0, 0]), clipPlaneContainsPoint(plane, [1, 1, 1]));
});

test('volumeClipPlane inversion retains the opposite half-space', () => {
  const normal = volumeClipPlane({ ...unitVolume, yaw: 0, pitch: 0, depth: 0.5 });
  const inverted = volumeClipPlane({ ...unitVolume, yaw: 0, pitch: 0, depth: 0.5, invert: true });
  assert.equal(clipPlaneContainsPoint(normal, [0.5, 0.5, 0.75]), true);
  assert.equal(clipPlaneContainsPoint(normal, [0.5, 0.5, 0.25]), false);
  assert.equal(clipPlaneContainsPoint(inverted, [0.5, 0.5, 0.75]), false);
  assert.equal(clipPlaneContainsPoint(inverted, [0.5, 0.5, 0.25]), true);
});

test('clip plane depth clamps invalid and out-of-range values', () => {
  assert.equal(clampClipPlaneDepth(-4), 0);
  assert.equal(clampClipPlaneDepth(4), 1);
  assert.equal(clampClipPlaneDepth('bad'), 0.5);
});

test('every volume raycast mode applies the arbitrary plane predicate', () => {
  assert.match(VOLUME_RAYCAST_FRAGMENT_SHADER, /uniform vec4\s+uClipPlane/);
  assert.match(VOLUME_RAYCAST_FRAGMENT_SHADER, /uniform int\s+uClipPlaneEnabled/);
  assert.equal((VOLUME_RAYCAST_FRAGMENT_SHADER.match(/clippedByObliquePlane\(p\)/g) || []).length, 3);
});
