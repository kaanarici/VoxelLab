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
  const hidden = new Int32Array(8);
  hidden[0] = 1 << 3;
  const uniforms = {
    uLabelMode: { value: 1 },
    uIsolate: { value: 1 },
    uLabel: { value: { image: { data: labels } } },
    uHiddenLabels: { value: hidden },
  };

  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 0, uniforms), false);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 1, uniforms), true);
  assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], 2, uniforms), false);
});


test('packed visibility masks address every label without changing adjacent labels', () => {
  const hidden = new Int32Array(8);
  const labels = Uint8Array.from({ length: 256 }, (_, index) => index);
  const uniforms = {
    uLabelMode: { value: 2 }, uIsolate: { value: 0 },
    uLabel: { value: { image: { data: labels } } }, uHiddenLabels: { value: hidden },
  };
  for (let label = 0; label < 256; label += 1) {
    hidden.fill(0);
    hidden[label >>> 5] |= 1 << (label & 31);
    assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], label, uniforms), false);
    assert.equal(volumeHoverPointVisible([0.5, 0.5, 0.5], (label + 1) % 256, uniforms), true);
  }
});
