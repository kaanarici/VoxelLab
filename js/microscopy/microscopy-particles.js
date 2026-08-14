// Analyze Particles: label connected foreground regions of a binary mask, measure each
// against the raw source plane, and filter by size/circularity. Pure, no DOM. Mirrors
// ImageJ Analyze > Analyze Particles (default 8-connectivity).

import { samplePlaneIntensity } from './microscopy-plane-sampler.js';

// 8-connected two-pass union-find labeling. Returns { labels: Int32Array (0=bg), count }.
function labelComponents(mask, W, H) {
  const len = W * H;
  const labels = new Int32Array(len);
  const parent = [0];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  let next = 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const neighbors = [];
      if (x > 0 && labels[i - 1]) neighbors.push(labels[i - 1]);                       // W
      if (y > 0 && labels[i - W]) neighbors.push(labels[i - W]);                        // N
      if (x > 0 && y > 0 && labels[i - W - 1]) neighbors.push(labels[i - W - 1]);       // NW
      if (x < W - 1 && y > 0 && labels[i - W + 1]) neighbors.push(labels[i - W + 1]);   // NE
      if (neighbors.length === 0) { labels[i] = next; parent[next] = next; next++; continue; }
      const m = Math.min(...neighbors);
      labels[i] = m;
      for (const nlab of neighbors) union(nlab, m);
    }
  }
  const remap = new Map();
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    let id = remap.get(root);
    if (id === undefined) { id = ++count; remap.set(root, id); }
    labels[i] = id;
  }
  return { labels, count };
}

// Trace the outer outline of `label` as a closed polygon of pixel-CORNER vertices (matching
// ImageJ's wand outline), with collinear runs merged to turn points. Method: collect unit
// boundary edges (FG/non-FG faces) with consistent clockwise orientation (FG inside), then
// link head-to-tail into a cycle. Pixel (x,y) occupies the unit cell [x,x+1]×[y,y+1].
function traceOutline(labels, W, H, label, startX, startY) {
  const fg = (x, y) => x >= 0 && x < W && y >= 0 && y < H && labels[y * W + x] === label;
  const next = new Map();
  const link = (x1, y1, x2, y2) => next.set(`${x1},${y1}`, [x2, y2]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (labels[y * W + x] !== label) continue;
      if (!fg(x, y - 1)) link(x, y, x + 1, y);             // top edge, FG below
      if (!fg(x + 1, y)) link(x + 1, y, x + 1, y + 1);     // right edge, FG left
      if (!fg(x, y + 1)) link(x + 1, y + 1, x, y + 1);     // bottom edge, FG above
      if (!fg(x - 1, y)) link(x, y + 1, x, y);             // left edge, FG right
    }
  }
  // The top-left pixel's top-left corner is on the outer outline; start the walk there.
  const start = [startX, startY];
  const raw = [];
  let cur = start;
  const cap = next.size + 4;
  do {
    raw.push(cur);
    const nx = next.get(`${cur[0]},${cur[1]}`);
    if (!nx) break;
    cur = nx;
  } while (!(cur[0] === start[0] && cur[1] === start[1]) && raw.length < cap);

  // Merge collinear consecutive vertices into turn points.
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[(i - 1 + raw.length) % raw.length];
    const here = raw[i];
    const after = raw[(i + 1) % raw.length];
    const turn = (here[0] - prev[0]) * (after[1] - here[1]) - (here[1] - prev[1]) * (after[0] - here[0]);
    if (turn !== 0) merged.push(here);
  }
  return merged.length >= 3 ? merged : raw;
}

// Faithful port of ImageJ PolygonRoi.getTracedPerimeter(): staircase length with a per-corner
// correction so digitized boundaries approximate the true perimeter. `verts` are turn points;
// pw/ph are pixel width/height (1 when uncalibrated). The correction term and corner-toggle
// logic match ImageJ source exactly — including the anisotropic (pw≠ph) correction
// (pw+ph)−√(pw²+ph²), which a (pw+ph)/2·(2−√2) approximation gets wrong for non-square pixels.
function tracedPerimeter(verts, pw = 1, ph = 1) {
  const n = verts.length;
  if (n < 2) return 0;
  let sumdx = 0, sumdy = 0, nCorners = 0;
  let dx1 = verts[0][0] - verts[n - 1][0];
  let dy1 = verts[0][1] - verts[n - 1][1];
  let side1 = Math.abs(dx1) + Math.abs(dy1);
  let corner = false;
  for (let i = 0; i < n; i++) {
    const nexti = (i + 1) % n;
    const dx2 = verts[nexti][0] - verts[i][0];
    const dy2 = verts[nexti][1] - verts[i][1];
    sumdx += Math.abs(dx1);
    sumdy += Math.abs(dy1);
    const side2 = Math.abs(dx2) + Math.abs(dy2);
    if (side1 > 1 || !corner) { corner = true; nCorners++; } else { corner = false; }
    dx1 = dx2; dy1 = dy2; side1 = side2;
  }
  return sumdx * pw + sumdy * ph - (nCorners * ((pw + ph) - Math.hypot(pw, ph)));
}

// mask: Uint8Array (1=foreground). sourcePlane: { pixels, width, height } raw values.
// opts: { connectivity:8, sizeRange:[minPx,maxPx], circularityRange:[lo,hi], excludeEdges }.
// spacing: { rowMm, colMm, known } from datasetSpacingMm.
export function analyzeParticles(mask, sourcePlane, opts = {}, spacing = {}) {
  const W = sourcePlane.width | 0;
  const H = sourcePlane.height | 0;
  const { sizeRange = [1, Infinity], circularityRange = [0, 1], excludeEdges = false } = opts;
  const { labels, count } = labelComponents(mask, W, H);

  const agg = Array.from({ length: count + 1 }, () => ({
    area: 0, sumX: 0, sumY: 0,
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
    startX: -1, startY: -1,
  }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const lab = labels[y * W + x];
      if (!lab) continue;
      const a = agg[lab];
      a.area++; a.sumX += x; a.sumY += y;
      if (x < a.minX) a.minX = x;
      if (x > a.maxX) a.maxX = x;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
      if (a.startY < 0) { a.startX = x; a.startY = y; } // raster-first = topmost-leftmost
    }
  }

  const known = !!spacing.known && spacing.rowMm > 0 && spacing.colMm > 0;
  const pxAreaMm2 = known ? spacing.rowMm * spacing.colMm : null;
  const objects = [];
  for (let lab = 1; lab <= count; lab++) {
    const a = agg[lab];
    if (a.area < sizeRange[0] || a.area > sizeRange[1]) continue;
    const touchesEdge = a.minX === 0 || a.minY === 0 || a.maxX === W - 1 || a.maxY === H - 1;
    if (excludeEdges && touchesEdge) continue;

    const bbox = { minX: a.minX, maxX: a.maxX, minY: a.minY, maxY: a.maxY };
    const polygon = traceOutline(labels, W, H, lab, a.startX, a.startY);
    // ImageJ traced perimeter + circularity (4π·area/perimeter², capped at 1.0, like ImageJ).
    const perimeterPx = tracedPerimeter(polygon, 1, 1);
    const perimeterMm = known ? tracedPerimeter(polygon, spacing.colMm, spacing.rowMm) : null;
    const areaMm2 = pxAreaMm2 != null ? a.area * pxAreaMm2 : null;
    const circArea = areaMm2 != null ? areaMm2 : a.area;
    const circPerim = perimeterMm != null ? perimeterMm : perimeterPx;
    const circularity = circPerim > 0 ? Math.min(1, (4 * Math.PI * circArea) / (circPerim * circPerim)) : 0;
    if (circularity < circularityRange[0] || circularity > circularityRange[1]) continue;

    const inside = (cx, cy) => labels[((cy | 0) * W) + (cx | 0)] === lab;
    const { n, sum, sum2, min, max } = samplePlaneIntensity(sourcePlane, inside, bbox);
    const mean = n > 0 ? sum / n : 0;
    const std = n > 0 ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;

    objects.push({
      area: a.area,
      areaMm2,
      perimeterPx,
      perimeterMm,
      circularity,
      centroid: { x: a.sumX / a.area, y: a.sumY / a.area },
      bbox: { x: a.minX, y: a.minY, w: a.maxX - a.minX + 1, h: a.maxY - a.minY + 1 },
      mean, std, min, max,
      intDen: mean * a.area,
      polygon,
    });
  }

  const areas = objects.map((o) => o.area);
  const summary = {
    count: objects.length,
    totalArea: areas.reduce((s, v) => s + v, 0),
    meanArea: objects.length ? areas.reduce((s, v) => s + v, 0) / objects.length : 0,
    minArea: objects.length ? Math.min(...areas) : 0,
    maxArea: objects.length ? Math.max(...areas) : 0,
  };
  return { objects, summary, labeledMask: labels };
}
