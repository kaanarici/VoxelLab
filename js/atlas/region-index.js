import { state } from '../core/state.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { presentRegionsForSlice } from './atlas-anchors.js';

let _cache = { key: '', slices: null, D: 0 };
let _backfill = 0;

function indexKey(series, labels) {
  const srcLen = labels.voxels?.length || (labels.imgs ? labels.imgs.length : 0);
  const hrLen = state.hrVoxels?.length || 0;
  return `${series.slug}|${srcLen}|${hrLen}`;
}

function baseSlice(series, z) {
  const W = series.width | 0;
  const H = series.height | 0;
  const D = series.slices | 0;
  const plane = W * H;
  if (!(plane > 0) || z < 0 || z >= D) return null;
  const off = z * plane;
  const hr = state.hrVoxels;
  if (hr && hr.length === plane * D) {
    const out = new Uint8Array(plane);
    for (let i = 0; i < plane; i += 1) {
      const v = hr[off + i] * 255;
      out[i] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
    }
    return out;
  }
  if (state.voxels && state.voxels.length === plane * D) return state.voxels.subarray(off, off + plane);
  return null;
}

function computeSlice(series, labels, z) {
  if (!labels.available || !labels.meta) return [];
  const { regions } = presentRegionsForSlice(series, z, labels, { baseBytes: baseSlice(series, z) });
  return regions;
}

const idle = globalThis.requestIdleCallback instanceof Function
  ? globalThis.requestIdleCallback
  : (cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 32);
const cancelIdle = globalThis.cancelIdleCallback instanceof Function ? globalThis.cancelIdleCallback : clearTimeout;

function scheduleBackfill(series, labels, key) {
  let cursor = 0;
  const step = (deadline) => {
    if (_cache.key !== key || !_cache.slices) return;
    while (cursor < _cache.D) {
      if (!_cache.slices[cursor]) {
        const s = computeSlice(series, labels, cursor);
        if (s.length) _cache.slices[cursor] = s;
      }
      cursor += 1;
      if (deadline.timeRemaining && deadline.timeRemaining() < 2) break;
    }
    _backfill = cursor < _cache.D ? idle(step) : 0;
  };
  _backfill = idle(step);
}

function ensureCache(series, labels) {
  const key = indexKey(series, labels);
  if (_cache.key === key && _cache.slices) return;
  if (_backfill) { cancelIdle(_backfill); _backfill = 0; }
  _cache = { key, slices: new Array(series.slices | 0), D: series.slices | 0 };
  scheduleBackfill(series, labels, key);
}

export function regionsForSlice(series, z) {
  const labels = activeOverlayStateForSeries(series).labels;
  ensureCache(series, labels);
  if (z < 0 || z >= _cache.D) return [];
  const cached = _cache.slices[z];
  if (cached) return cached;
  const s = computeSlice(series, labels, z);
  if (s.length) _cache.slices[z] = s;
  return s;
}

export function invalidateRegionIndex() {
  if (_backfill) { cancelIdle(_backfill); _backfill = 0; }
  _cache = { key: '', slices: null, D: 0 };
}
