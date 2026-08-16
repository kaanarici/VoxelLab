// Cached overlay PNG pixel reads shared by 2D slice, compare, and overlay-volume builds.

import { localByteSliceData } from '../series/local-byte-slice.js';

const cache = new WeakMap();
let canvas = null;
let ctx = null;

function ensureCanvas(w, h) {
  if (!canvas) {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return ctx;
}

/** Return cached RGBA pixel data for one overlay image at the requested dimensions. */
export function readOverlayData(img, w, h) {
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  const hit = cache.get(img);
  const key = `${w}x${h}`;
  if (hit?.has(key)) return hit.get(key).rgba;

  const directBytes = localByteSliceData(img);
  if (directBytes) {
    if (directBytes.length !== w * h) return null;
    const rgba = new Uint8ClampedArray(directBytes.length * 4);
    for (let index = 0, offset = 0; index < directBytes.length; index += 1, offset += 4) {
      const value = directBytes[index];
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
    const sizes = hit || new Map();
    sizes.set(key, { rgba, bytes: directBytes });
    cache.set(img, sizes);
    return rgba;
  }

  const draw = ensureCanvas(w, h);
  draw.clearRect(0, 0, w, h);
  draw.drawImage(img, 0, 0, w, h);
  const rgba = draw.getImageData(0, 0, w, h).data;
  const bytes = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) bytes[p] = rgba[i];
  const sizes = hit || new Map();
  sizes.set(key, { rgba, bytes });
  cache.set(img, sizes);
  return rgba;
}

export function readImageByteData(img, w, h) {
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  const directBytes = localByteSliceData(img);
  if (directBytes) return directBytes.length === w * h ? directBytes : null;
  const hit = cache.get(img);
  const key = `${w}x${h}`;
  if (hit?.has(key)) return hit.get(key).bytes;
  readOverlayData(img, w, h);
  return cache.get(img)?.get(key)?.bytes || null;
}
