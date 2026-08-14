// Per-slice region anchors for the atlas view.
//
// Single source of truth = the same per-slice label bytes the 2D compositor
// paints (a slice of state.regionVoxels, or the decoded regions PNG). Scanning
// that plane keeps every callout anchor in lock-step with the rendered figure
// for ANY loaded modality/body part, with no precomputed sidecar required.
//
// For each present label the anchor is the deepest-interior point (the maximum of
// a distance transform), so the dot lands in the thick bulk of the structure's
// largest blob — robust to concave shapes, holes, and scattered speckle — rather
// than on a stray edge pixel.

import { readImageByteData } from '../overlay/overlay-data.js';
import { regionLabelName } from '../region-meta.js';

const MAX_LABEL = 253; // 254/255 are reserved/avoided by the slice compositor
const DEFAULT_MIN_AREA_PX = 8; // drop single-pixel speckle from the callouts
const DEFAULT_MAX_LABELS = 40; // cap callouts so two columns stay legible

/** Per-slice label bytes (Uint8Array w*h) for the active region overlay, or null. */
export function regionPlaneForSlice(series, sliceIdx, labels) {
  if (!series || !labels?.available) return null;
  const W = series.width | 0;
  const H = series.height | 0;
  const D = series.slices | 0;
  if (!(W > 0) || !(H > 0) || sliceIdx < 0 || sliceIdx >= D) return null;
  const plane = W * H;
  const voxels = labels.voxels;
  if (voxels && voxels.length === plane * D) {
    const start = sliceIdx * plane;
    return voxels.subarray(start, start + plane);
  }
  const img = labels.imgs?.[sliceIdx];
  if (img && img.complete && img.naturalWidth > 0) return readImageByteData(img, W, H);
  return null;
}

function colorForLabel(meta, label) {
  const c = meta?.colors?.[label] ?? meta?.colors?.[String(label)];
  return Array.isArray(c) && c.length === 3 ? c : [170, 170, 170];
}

// Deepest-interior point of `label` within its bounding box: the pixel furthest
// from any non-region pixel (the maximum of a chamfer distance transform). This
// lands the anchor in the thickest part of the structure's largest blob — robust
// to concave shapes, holes, and small disconnected speckle — instead of a stray
// edge pixel near the arithmetic centroid. A 1px background pad makes bbox-border
// pixels measure their true distance to the outside.
function deepestInteriorPoint(plane, W, label, minX, minY, maxX, maxY) {
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const pw = bw + 2;
  const ph = bh + 2;
  const dist = new Float32Array(pw * ph); // 0 = background (incl. the 1px pad)
  const INF = 1e9;
  for (let ly = 0; ly < bh; ly += 1) {
    const srow = (minY + ly) * W + minX;
    const prow = (ly + 1) * pw + 1;
    for (let lx = 0; lx < bw; lx += 1) {
      if (plane[srow + lx] === label) dist[prow + lx] = INF;
    }
  }
  const D1 = 1;
  const D2 = 1.4142136;
  for (let y = 1; y <= bh; y += 1) {
    for (let x = 1; x <= bw; x += 1) {
      const idx = y * pw + x;
      if (dist[idx] === 0) continue;
      dist[idx] = Math.min(dist[idx], dist[idx - 1] + D1, dist[idx - pw] + D1, dist[idx - pw - 1] + D2, dist[idx - pw + 1] + D2);
    }
  }
  let bestX = minX;
  let bestY = minY;
  let bestD = -1;
  for (let y = bh; y >= 1; y -= 1) {
    for (let x = bw; x >= 1; x -= 1) {
      const idx = y * pw + x;
      if (dist[idx] === 0) continue;
      const d = Math.min(dist[idx], dist[idx + 1] + D1, dist[idx + pw] + D1, dist[idx + pw + 1] + D2, dist[idx + pw - 1] + D2);
      dist[idx] = d;
      if (d > bestD) { bestD = d; bestX = minX + (x - 1); bestY = minY + (y - 1); }
    }
  }
  return { x: bestX, y: bestY };
}

/**
 * Regions present on `sliceIdx`, each with a deepest-interior anchor in voxel
 * space. Returns { regions: [{ label, name, color:[r,g,b], cx, cy, areaPx }],
 * hiddenCount } where hiddenCount is how many small regions the cap dropped.
 */
export function presentRegionsForSlice(series, sliceIdx, labels, opts = {}) {
  const minAreaPx = opts.minAreaPx ?? DEFAULT_MIN_AREA_PX;
  const maxLabels = opts.maxLabels ?? DEFAULT_MAX_LABELS;
  const hidden = opts.hiddenLabels instanceof Set ? opts.hiddenLabels : new Set();
  const meta = labels?.meta;
  const plane = opts.plane || regionPlaneForSlice(series, sliceIdx, labels);
  const empty = { regions: [], hiddenCount: 0 };
  if (!plane || !meta) return empty;

  const W = series.width | 0;
  const H = series.height | 0;
  const count = new Float64Array(256);
  // Per-label bounding box (for the distance-transform anchor).
  const minX = new Int32Array(256).fill(W);
  const minY = new Int32Array(256).fill(H);
  const maxX = new Int32Array(256).fill(-1);
  const maxY = new Int32Array(256).fill(-1);
  // Optional per-region base-intensity histogram (indexed [label*256 + value]),
  // used by the 3D overlay to drop labels for structures the transfer function
  // has windowed out — by measuring the fraction of a region's voxels in-window.
  const base = opts.baseBytes && opts.baseBytes.length === W * H ? opts.baseBytes : null;
  const hist = base ? new Uint32Array(256 * 256) : null;

  for (let y = 0, i = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1, i += 1) {
      const label = plane[i];
      if (label === 0 || label > MAX_LABEL) continue;
      count[label] += 1;
      if (x < minX[label]) minX[label] = x;
      if (x > maxX[label]) maxX[label] = x;
      if (y < minY[label]) minY[label] = y;
      if (y > maxY[label]) maxY[label] = y;
      if (base) hist[label * 256 + base[i]] += 1;
    }
  }

  const present = [];
  for (let label = 1; label <= MAX_LABEL; label += 1) {
    if (count[label] < minAreaPx || hidden.has(label)) continue;
    present.push(label);
  }
  if (!present.length) return empty;

  let regions = present.map((label) => {
    const anchor = deepestInteriorPoint(plane, W, label, minX[label], minY[label], maxX[label], maxY[label]);
    // Cumulative voxel count by intensity 0..255, so the 3D overlay can read
    // "voxels in [low,high]" as cdf[hi]-cdf[lo-1] in O(1) on every slider drag.
    let intensityCdf;
    if (base) {
      const cdf = new Uint32Array(256);
      const off = label * 256;
      let acc = 0;
      for (let v = 0; v < 256; v += 1) { acc += hist[off + v]; cdf[v] = acc; }
      intensityCdf = cdf;
    }
    return {
      label,
      name: regionLabelName(meta, label) || `Region ${label}`,
      color: colorForLabel(meta, label),
      cx: anchor.x + 0.5,
      cy: anchor.y + 0.5,
      areaPx: count[label],
      intensityCdf,
    };
  });

  let hiddenCount = 0;
  if (regions.length > maxLabels) {
    regions.sort((a, b) => b.areaPx - a.areaPx);
    hiddenCount = regions.length - maxLabels;
    regions = regions.slice(0, maxLabels);
  }
  regions.sort((a, b) => a.cy - b.cy);
  return { regions, hiddenCount };
}
