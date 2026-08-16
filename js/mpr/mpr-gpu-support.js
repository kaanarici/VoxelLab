import { volumeTextureSizeSupport } from '../volume/volume-texture-capabilities.js';
import { MAX_ACCURATE_SLAB_SAMPLES } from './mpr-projection.js';

export function gpuMprInputSupport({
  dims,
  projection = null,
  vox = null,
  max3DTextureSize,
  floatLinearFiltering = true,
} = {}) {
  const texture = volumeTextureSizeSupport(dims, max3DTextureSize);
  if (!texture.supported) return texture;
  const expected = Number(dims.W) * Number(dims.H) * Number(dims.D);
  if (!vox || vox.length !== expected) {
    return { supported: false, reason: 'volume data does not match its dimensions', maximum: texture.maximum };
  }
  if (projection?.sampleCount > MAX_ACCURATE_SLAB_SAMPLES) {
    return { supported: false, reason: 'slab projection exceeds the accurate GPU sample budget', maximum: texture.maximum };
  }
  if (vox instanceof Float32Array && !floatLinearFiltering) {
    return { supported: false, reason: 'linear Float32 volume filtering is unavailable', maximum: texture.maximum };
  }
  return texture;
}
