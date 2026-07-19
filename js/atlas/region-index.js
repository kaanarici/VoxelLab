// Single source of per-slice region geometry for the anatomy-label overlays
// (2D + 3D). The expensive per-slice scan (centroids + snap + intensity
// histogram) runs ONCE per slice and is cached for the whole series, with the
// remaining slices filled in during idle time — so scrubbing is an O(k) lookup
// instead of a full re-scan every step (the old scrub-lag source).
//
// Regions are stored UNFILTERED (hidden labels are NOT removed here) so toggling
// a label's visibility never invalidates the scan cache; consumers filter at
// lookup. Empty results are not cached (the slice's region image may not have
// decoded yet) so they get retried until data is present.

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

// Base intensity for slice z from the SAME volume the raycaster renders (HR
// Float32 in [0,1] quantized to 0..255 when present, else the uint8 base), so the
// 3D transfer-function cull matches what's on screen. Null when no base volume.
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

const idle = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 32);
const cancelIdle = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;

// Warm the remaining slices when the main thread is idle so the first scrub-
// through is already cached. Chunked + cooperative; bails if the cache rotated.
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

/** All regions on slice z (unfiltered by hidden labels), cached. O(1) once warm. */
export function regionsForSlice(series, z) {
  const labels = activeOverlayStateForSeries(series).labels;
  ensureCache(series, labels);
  if (z < 0 || z >= _cache.D) return [];
  const cached = _cache.slices[z];
  if (cached) return cached;
  const s = computeSlice(series, labels, z);
  if (s.length) _cache.slices[z] = s; // don't cache empties — image may still be decoding
  return s;
}

/** Drop the whole index (region data / base volume / meta changed). */
export function invalidateRegionIndex() {
  if (_backfill) { cancelIdle(_backfill); _backfill = 0; }
  _cache = { key: '', slices: null, D: 0 };
}
