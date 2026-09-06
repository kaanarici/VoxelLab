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

export function mapWindowLevelByte(value, window = state.window, level = state.level) {
  const lo = level - window / 2;
  const range = Math.max(1, window);
  let idx = (((value - lo) / range) * 255 + 0.5) | 0;
  if (idx < 0) idx = 0;
  else if (idx > 255) idx = 255;
  return idx;
}

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
    _fusedU32[v] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
}

export function applyWindowLevelWithColormap(d) {
  ensureFusedLUT();
  const len = d.length;

  const u32 = new Uint32Array(d.buffer, d.byteOffset, len >> 2);
  for (let i = 0, n = u32.length; i < n; i++) {

    u32[i] = _fusedU32[d[i << 2]];
  }
}

export function getFusedWLLut() {
  ensureFusedLUT();
  return { r: _fusedR, g: _fusedG, b: _fusedB, key: _fusedKey };
}

export function getFusedWLU32() {
  ensureFusedLUT();
  return _fusedU32;
}
