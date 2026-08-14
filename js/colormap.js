// Colormap registry. Each colormap is a 256×4 Uint8Array (RGBA LUT).
// The active colormap replaces the hardcoded grayscale in the W/L
// pixel-walk. Selectable via a dropdown in the toolbar.
//
// General-purpose: works for any modality. PET and functional MR need
// color LUTs; standard radiological grayscale is the default.

import { state } from './core/state.js';
import { setColormap as setColormapState } from './core/state/viewer-commands.js';
import { COLORMAPS } from './colormap-registry.js';

export { COLORMAPS } from './colormap-registry.js';

export function getActiveLUT() {
  return COLORMAPS[state.colormap]?.lut || COLORMAPS.grayscale.lut;
}

export function setColormap(name) {
  if (!COLORMAPS[name]) return;
  setColormapState(name);
}

// Shape: uint8 source intensity 0..255 mapped into a uint8 LUT index 0..255.
export function mapWindowLevelByte(value, window = state.window, level = state.level) {
  const lo = level - window / 2;
  const range = Math.max(1, window);
  let idx = (((value - lo) / range) * 255 + 0.5) | 0;
  if (idx < 0) idx = 0;
  else if (idx > 255) idx = 255;
  return idx;
}

// Fused W/L + colormap: single 256-entry LUT for uint8 canvas pixels; rebuilt when
// window, level, or colormap change.

let _fusedKey = '';
let _fusedR = new Uint8Array(256);
let _fusedG = new Uint8Array(256);
let _fusedB = new Uint8Array(256);
let _fusedU32 = new Uint32Array(256);

function ensureFusedLUT() {
  const key = `${state.window}/${state.level}/${state.colormap}/${state.invertDisplay ? 1 : 0}`;
  if (key === _fusedKey) return;
  _fusedKey = key;

  const cmapLut = getActiveLUT();
  const invert = !!state.invertDisplay;

  for (let v = 0; v < 256; v++) {
    const idx = mapWindowLevelByte(v, state.window, state.level);
    const base = idx * 4;
    const r = invert ? 255 - cmapLut[base] : cmapLut[base];
    const g = invert ? 255 - cmapLut[base + 1] : cmapLut[base + 1];
    const b = invert ? 255 - cmapLut[base + 2] : cmapLut[base + 2];
    _fusedR[v] = r;
    _fusedG[v] = g;
    _fusedB[v] = b;
    _fusedU32[v] = (255 << 24) | (b << 16) | (g << 8) | r;  // ABGR for little-endian
  }
}

// Apply W/L + colormap to an RGBA pixel buffer in place.
// Uses a precomputed 256-entry fused LUT — one array lookup per pixel,
// no per-pixel arithmetic.
export function applyWindowLevelWithColormap(d) {
  ensureFusedLUT();
  const len = d.length;
  // Fast path: Uint32Array bulk writes when possible
  const u32 = new Uint32Array(d.buffer, d.byteOffset, len >> 2);
  for (let i = 0, n = u32.length; i < n; i++) {
    // Read the red channel (first byte in RGBA) — all channels are
    // identical in the source grayscale image.
    u32[i] = _fusedU32[d[i << 2]];
  }
}

// Expose the fused LUT components for callers that need per-channel
// access (e.g. overlay compositing in slice-view.js).
export function getFusedWLLut() {
  ensureFusedLUT();
  return { r: _fusedR, g: _fusedG, b: _fusedB, key: _fusedKey };
}

export function getFusedWLU32() {
  ensureFusedLUT();
  return _fusedU32;
}
