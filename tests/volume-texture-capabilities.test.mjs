import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  rendererMax3DTextureSize,
  volumeTextureSizeSupport,
} from '../js/volume/volume-texture-capabilities.js';

test('rendererMax3DTextureSize reads the live WebGL capability and fails closed', () => {
  const gl = {
    MAX_3D_TEXTURE_SIZE: 0x8073,
    getParameter(parameter) {
      assert.equal(parameter, this.MAX_3D_TEXTURE_SIZE);
      return 2048;
    },
    isContextLost: () => false,
  };
  assert.equal(rendererMax3DTextureSize({ getContext: () => gl }), 2048);
  assert.equal(rendererMax3DTextureSize({ getContext: () => ({ ...gl, isContextLost: () => true }) }), 0);
  assert.equal(rendererMax3DTextureSize(null), 0);
});

test('volumeTextureSizeSupport rejects invalid and oversized volume dimensions', () => {
  assert.equal(volumeTextureSizeSupport({ W: 2048, H: 2, D: 1 }, 2048).supported, true);
  assert.match(volumeTextureSizeSupport({ W: 2049, H: 1, D: 1 }, 2048).reason, /exceeds/i);
  assert.match(volumeTextureSizeSupport({ W: 0, H: 1, D: 1 }, 2048).reason, /invalid/i);
  assert.match(volumeTextureSizeSupport({ W: 1, H: 1, D: 1 }, 0).reason, /unavailable/i);
});
