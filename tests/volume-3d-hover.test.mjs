import assert from 'node:assert/strict';
import { test } from 'node:test';

import { volumeHoverPointVisible } from '../js/volume/volume-hover-visibility.js';

test('3D hover honors axis and arbitrary-plane clipping', () => {
  const uniforms = {
    uClipMin: { value: [0.2, 0, 0] },
    uClipMax: { value: [1, 1, 1] },
    uClipPlaneEnabled: { value: 1 },
    uClipPlane: { value: [0, 0, 1, -0.5] },
  };

  assert.equal(volumeHoverPointVisible([0.1, 0.5, 0.75], 0, uniforms), false);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.25], 0, uniforms), false);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.75], 0, uniforms), true);
});

test('3D hover honors isolated label visibility', () => {
  const labels = new Uint8Array([0, 2, 3]);
  const lut = new Uint8Array(256 * 4);
  lut[2 * 4 + 3] = 255;
  const uniforms = {
    uLabelMode: { value: 1 },
    uIsolate: { value: 1 },
    uLabel: { value: { image: { data: labels } } },
    uLabelLUT: { value: { image: { data: lut } } },
  };

  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 0, uniforms), false);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 1, uniforms), true);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 2, uniforms), false);
});
