// Region-of-interest tool.

import { adcDisplayFromNorm } from './adc.js';
import { ellipseInclusion, polygonInclusion } from './roi/roi-geometry.js';
import { samplePlaneIntensity } from './microscopy/microscopy-plane-sampler.js';
import { rawPlaneFor } from './microscopy/microscopy-plane-store.js';
import { rawMicroscopyValueSource } from './microscopy/microscopy-dataset-model.js';
import { inPlanePixelSpacing } from './core/geometry.js';
import { formatAreaFromMm2 } from './core/physical-units.js';
import { CT_HU_LO, CT_HU_RANGE } from './core/constants.js';
import {
  deleteDrawingEntryById,
  drawingEntriesForSeries,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setRoiEntriesForSlice,
} from './overlay/annotation-graph.js';

// Three primitive shapes:
//   · ellipse — drag from one corner to the opposite corner of the
//               bounding box; pixels inside the inscribed ellipse form
//               the ROI
//   · polygon — click to add vertices, double-click or Enter to close
//   · point   — one click, for C/Z/T-scoped counting workflows
//
// For each ROI we compute viewer ROI summary statistics from the
// voxels inside the shape on the current slice:
//   · area in mm² (from pixelSpacing)
//   · pixel count
//   · mean, std, min, max of the stored 8-bit slice PNG values
//   · for DWI ADC: the same stats translated to physical ADC
//     (×10⁻³ mm²/s) using the series stats sidecar
//
// ROIs persist in localStorage per selected-series fingerprint and slice so
// they survive reloads without crossing identically named studies.
//
// The module exposes a small public API the host page wires up:
//   · initROI(deps)          — pass the state + helper functions it needs
//   · toggleROI('ellipse'|'polygon'|'point')  — flip into the tool
//   · drawROIs(svg, ...)     — render all current-slice ROIs into an
//                              existing SVG element
//   · onROIClick(ev)         — mousedown handler on the canvas
//   · onROIMove(ev)          — mousemove during a live ellipse drag
//   · isROIMode()            — is any ROI tool currently active?

const NS = 'http://www.w3.org/2000/svg';

// Internal state. Cleared on module load so a stale "pending" ROI can't
// survive a refresh.
const state = {
  mode:      null,     // null | 'ellipse' | 'polygon' | 'point'
  pending:   null,     // in-progress shape being drawn
  deps:      null,     // injected host dependencies
};

// ---------- persistence ----------
function listHere() {
  const { state: host } = state.deps;
  return roiEntriesForSlice(host, host.manifest.series[host.seriesIdx], host.sliceIdx);
}
function setHere(list) {
  const { state: host } = state.deps;
  setRoiEntriesForSlice(host, host.manifest.series[host.seriesIdx], host.sliceIdx, list);
}

function currentMicroscopyScope() {
  const { state: host } = state.deps;
  const series = host.manifest.series[host.seriesIdx];
  if (series?.imageDomain !== 'microscopy') return null;
  return {
    channelIndex: Number(series.microscopy?.channelIndex || 0),
    channelName: series.microscopy?.channelName || '',
    timeIndex: Number(series.microscopy?.timeIndex || 0),
  };
}

function roiVisibleInCurrentScope(roi) {
  const scope = currentMicroscopyScope();
  if (!scope || !roi.microscopy) return true;
  return Number(roi.microscopy.channelIndex || 0) === scope.channelIndex
    && Number(roi.microscopy.timeIndex || 0) === scope.timeIndex;
}

function sameMicroscopyScope(roi, scope) {
  if (!scope) return !roi.microscopy;
  return Number(roi.microscopy?.channelIndex || 0) === scope.channelIndex
    && Number(roi.microscopy?.timeIndex || 0) === scope.timeIndex;
}

// ---------- stats ----------
//
// For each ROI we walk the bounding box of the shape, test each pixel
// for inclusion, and accumulate statistics from the stored 8-bit slice
// PNG data. This is the same display-domain source the hover readout
// uses. Only the ADC branch below converts back into physical units.
function computeStats(pts, shape) {
  const { state: host, getRawSliceData } = state.deps;
  const series = host.manifest.series[host.seriesIdx];
  if (shape === 'polyline') {
    const spacing = inPlanePixelSpacing(series);
    let lengthPx = 0;
    let lengthMm = 0;
    for (let index = 1; index < pts.length; index += 1) {
      const [x1, y1] = pts[index - 1];
      const [x2, y2] = pts[index];
      lengthPx += Math.hypot(x2 - x1, y2 - y1);
      if (spacing.known) lengthMm += Math.hypot((x2 - x1) * spacing.colMm, (y2 - y1) * spacing.rowMm);
    }
    return { length_px: lengthPx, length_mm: spacing.known ? lengthMm : null };
  }
  const W = series.width, H = series.height;
  const raw = getRawSliceData(host.sliceIdx);   // Uint8Array RGBA of the stored slice PNG
  // D1b: microscopy ROIs measure the retained raw single-channel plane (Fiji "Mean gray
  // value") when one is available; everything else keeps the 8-bit display-domain path.
  const rawPlane = series.imageDomain === 'microscopy'
    ? rawPlaneFor(host, series, series.microscopy?.channelIndex || 0, series.microscopy?.timeIndex || 0, host.sliceIdx)
    : null;
  const useRaw = !!(rawPlane && rawPlane.width === W && rawPlane.height === H);
  // CT: measure true Hounsfield from the band-encoded hrVoxels (the .raw the 3D
  // path uses), not the percentile-windowed display PNG. Accurate within the
  // [-1024, +2048] band the volume carries; beyond that it's clamped like hover.
  const isCtHu = series.modality === 'CT' && host.hrVoxels?.length === W * H * series.slices;
  const zBase = host.sliceIdx * W * H;
  if (!useRaw && !isCtHu && !raw) return null;
  const valueAt = useRaw
    ? (px, py) => rawPlane.pixels[py * W + px]
    : isCtHu
      ? (px, py) => CT_HU_LO + host.hrVoxels[zBase + py * W + px] * CT_HU_RANGE
      : (px, py) => raw[(py * W + px) * 4];

  if (shape === 'point') {
    let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity;
    for (const [x, y] of pts) {
      const px = Math.max(0, Math.min(W - 1, Math.round(x)));
      const py = Math.max(0, Math.min(H - 1, Math.round(y)));
      const v = valueAt(px, py);
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!n) return null;
    const mean = sum / n;
    const variance = Math.max(0, sum2 / n - mean * mean);
    const stats = { pixels: n, mean, std: Math.sqrt(variance), min, max, count: n };
    if (useRaw) { stats.valueSource = rawMicroscopyValueSource(series); stats.valueUnit = 'raw'; }
    else if (isCtHu) { stats.valueSource = 'hounsfield'; stats.valueUnit = 'HU'; }
    return stats;
  }

  // Bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX = Math.max(0, Math.floor(minX));
  maxX = Math.min(W - 1, Math.ceil(maxX));
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(H - 1, Math.ceil(maxY));

  // Inclusion test per shape
  const inside = shape === 'ellipse'
    ? ellipseInclusion(pts)
    : polygonInclusion(pts);

  let n, sum, sum2, min, max;
  if (useRaw) {
    ({ n, sum, sum2, min, max } = samplePlaneIntensity(rawPlane, inside, { minX, maxX, minY, maxY }));
  } else {
    n = 0; sum = 0; sum2 = 0; min = Infinity; max = -Infinity;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (!inside(px + 0.5, py + 0.5)) continue;
        const v = valueAt(px, py);
        n++;
        sum  += v;
        sum2 += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (n === 0) return null;

  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  const std = Math.sqrt(variance);
  const spacing = inPlanePixelSpacing(series);
  const areaMm2 = spacing.known ? n * spacing.rowMm * spacing.colMm : null;

  const stats = {
    pixels: n,
    mean, std, min, max,
  };
  if (useRaw) { stats.valueSource = rawMicroscopyValueSource(series); stats.valueUnit = 'raw'; }
  else if (isCtHu) { stats.valueSource = 'hounsfield'; stats.valueUnit = 'HU'; }
  if (Number.isFinite(areaMm2)) stats.area_mm2 = areaMm2;

  // Physical ADC translation if we're on DWI ADC and the rescale info
  // is available. Use the hrVoxels if present (more precise); otherwise
  // skip — the 8-bit path is too lossy for a meaningful ADC number.
  if (series.slug === 'dwi_adc' && host.stats && host.stats.adc && host.hrVoxels) {
    const adc = host.stats.adc;
    const hr = host.hrVoxels;
    let hsum = 0, hsum2 = 0, hn = 0, hmin = Infinity, hmax = -Infinity;
    const z = host.sliceIdx;
    const zBase = z * W * H;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (!inside(px + 0.5, py + 0.5)) continue;
        const display = adcDisplayFromNorm(adc, hr[zBase + py * W + px]);
        if (!Number.isFinite(display)) continue;
        hsum  += display;
        hsum2 += display * display;
        if (display < hmin) hmin = display;
        if (display > hmax) hmax = display;
        hn++;
      }
    }
    if (hn > 0) {
      const hmean = hsum / hn;
      const hvar  = Math.max(0, hsum2 / hn - hmean * hmean);
      stats.adc = {
        mean: hmean, std: Math.sqrt(hvar), min: hmin, max: hmax, pixels: hn,
        unit: '×10⁻³ mm²/s',
      };
    }
  }

  return stats;
}

// ---------- rendering ----------
export function drawROIs(svg) {
  // Remove only the ROI elements from the SVG — leave the measurement
  // ruler elements alone. We mark ours with class="roi-group".
  svg.querySelectorAll('.roi-group').forEach(el => el.remove());

  const list = listHere().filter(roiVisibleInCurrentScope);
  list.forEach((roi, i) => renderOne(svg, roi, i));

  // Live preview of an in-progress shape
  if (state.pending) {
    renderPending(svg, state.pending);
  }
}

function renderOne(svg, roi, i) {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'roi-group');

  if (roi.shape === 'point') {
    for (const [x, y] of roi.pts) {
      const mark = document.createElementNS(NS, 'circle');
      mark.setAttribute('cx', x); mark.setAttribute('cy', y);
      mark.setAttribute('r', 3.5);
      mark.setAttribute('class', 'roi-shape roi-point');
      g.appendChild(mark);
    }
  } else if (roi.shape === 'ellipse') {
    const [[x1, y1], [x2, y2]] = roi.pts;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    const el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy);
    el.setAttribute('rx', rx); el.setAttribute('ry', ry);
    el.setAttribute('class', 'roi-shape');
    g.appendChild(el);
  } else if (roi.shape === 'polyline') {
    const polyline = document.createElementNS(NS, 'polyline');
    polyline.setAttribute('points', roi.pts.map(p => p.join(',')).join(' '));
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('class', 'roi-shape');
    g.appendChild(polyline);
  } else {
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', roi.pts.map(p => p.join(',')).join(' '));
    poly.setAttribute('class', 'roi-shape');
    g.appendChild(poly);
  }

  // Stats label at the top-right of the bounding box
  const xs = roi.pts.map(p => p[0]), ys = roi.pts.map(p => p[1]);
  const lx = Math.max(...xs);
  const ly = Math.min(...ys) - 6;
  const txt = document.createElementNS(NS, 'text');
  txt.setAttribute('x', lx);
  txt.setAttribute('y', ly);
  txt.setAttribute('text-anchor', 'start');
  txt.setAttribute('class', 'roi-label');
  const s = roi.stats || {};
  let line = (typeof roi.label === 'string' && roi.label.trim())
    || (typeof roi.text === 'string' && roi.text.trim())
    || `ROI ${i + 1}`;
  if (roi.shape === 'point') line += ` · count ${Number.isFinite(s.count) ? s.count : roi.pts.length}`;
  if (roi.shape === 'polyline') {
    const length = Number.isFinite(s.length_mm) ? `${s.length_mm.toFixed(2)} mm` : `${Number(s.length_px || 0).toFixed(1)} px`;
    line += ` · ${length}`;
  }
  if (Number.isFinite(s.area_mm2)) line += ` · ${formatAreaFromMm2(s.area_mm2, state.deps.state.manifest.series[state.deps.state.seriesIdx])}`;
  if (s.adc) {
    line += ` · ${s.adc.mean.toFixed(2)} ±${s.adc.std.toFixed(2)} ×10⁻³ mm²/s`;
  } else if (Number.isFinite(s.mean) && Number.isFinite(s.std)) {
    line += ` · μ${s.mean.toFixed(0)} ±${s.std.toFixed(0)}`;
  }
  txt.textContent = line;
  g.appendChild(txt);

  // Delete × button, same pattern as measurements
  const [dx, dy] = [lx + 8, ly - 10];
  const btnR = 8;
  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('cx', dx); bg.setAttribute('cy', dy);
  bg.setAttribute('r', btnR);
  bg.setAttribute('class', 'roi-del-bg');
  g.appendChild(bg);
  const x1 = dx - 3, x2 = dx + 3, y1 = dy - 3, y2 = dy + 3;
  const c1 = document.createElementNS(NS, 'line');
  c1.setAttribute('x1', x1); c1.setAttribute('y1', y1);
  c1.setAttribute('x2', x2); c1.setAttribute('y2', y2);
  c1.setAttribute('class', 'roi-del-x');
  g.appendChild(c1);
  const c2 = document.createElementNS(NS, 'line');
  c2.setAttribute('x1', x2); c2.setAttribute('y1', y1);
  c2.setAttribute('x2', x1); c2.setAttribute('y2', y2);
  c2.setAttribute('class', 'roi-del-x');
  g.appendChild(c2);
  const hit = document.createElementNS(NS, 'circle');
  hit.setAttribute('cx', dx); hit.setAttribute('cy', dy);
  hit.setAttribute('r', btnR);
  hit.setAttribute('class', 'roi-del-hit');
  hit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const cur = listHere();
    // Shape: roi.id is a per-slice monotonic integer like 1, 2, 3.
    const next = (roi.id != null)
      ? deleteDrawingEntryById(cur, roi.id)
      : cur.filter((_, idx) => idx !== i);
    if (next.length !== cur.length) {
      setHere(next);
      drawROIs(svg);
      state.deps.onROIChange?.();
    }
  });
  g.appendChild(hit);

  svg.appendChild(g);
}

function renderPending(svg, pending) {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'roi-group roi-pending');
  if (pending.shape === 'ellipse' && pending.pts.length === 2) {
    const [[x1, y1], [x2, y2]] = pending.pts;
    const el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', (x1 + x2) / 2);
    el.setAttribute('cy', (y1 + y2) / 2);
    el.setAttribute('rx', Math.abs(x2 - x1) / 2);
    el.setAttribute('ry', Math.abs(y2 - y1) / 2);
    el.setAttribute('class', 'roi-shape roi-pending-shape');
    g.appendChild(el);
  } else if (pending.shape === 'polygon' && pending.pts.length >= 1) {
    if (pending.pts.length >= 2) {
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', pending.pts.map(p => p.join(',')).join(' '));
      line.setAttribute('class', 'roi-shape roi-pending-shape');
      g.appendChild(line);
    }
    for (const [px, py] of pending.pts) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('r', 3);
      dot.setAttribute('class', 'roi-dot');
      g.appendChild(dot);
    }
  }
  svg.appendChild(g);
}

// ---------- tool activation ----------
export function initROI(deps) {
  state.deps = deps;
}

export function toggleROI(mode) {
  if (state.deps?.state?.mode !== '2d' && state.mode !== mode) return state.mode;
  if (state.mode === mode) {
    state.mode = null;
    state.pending = null;
  } else {
    state.mode = mode;
    state.pending = null;
  }
  if (state.mode) void ensureCtHuVolume();
  state.deps.onROIChange?.();
  return state.mode;
}

export function clearROIMode() {
  state.mode = null;
  state.pending = null;
  state.deps?.onROIChange?.();
  return state.mode;
}

export function isROIMode() {
  return state.mode !== null;
}

export function currentROIMode() {
  return state.mode;
}

export function cancelROI() {
  state.pending = null;
  state.deps.onROIChange?.();
}

// Mouse-down handler for the canvas. Expected to be called from the host
// page's unified pointer dispatch. Coordinates should already be in the
// canvas's native pixel space.
export function onROIDown(px, py) {
  if (!state.mode) return;

  if (state.mode === 'ellipse') {
    if (!state.pending) {
      state.pending = { shape: 'ellipse', pts: [[px, py], [px, py]] };
    } else {
      // Second click finalizes
      state.pending.pts[1] = [px, py];
      finalize();
    }
  } else if (state.mode === 'polygon') {
    if (!state.pending) {
      state.pending = { shape: 'polygon', pts: [[px, py]] };
    } else {
      state.pending.pts.push([px, py]);
    }
  } else if (state.mode === 'point') {
    appendPointCount(px, py);
    return;
  }
  state.deps.onROIChange?.();
}

export function onROIMove(px, py) {
  if (!state.pending) return false;
  if (state.mode === 'ellipse') {
    state.pending.pts[1] = [px, py];
    return true;
  }
  return false;
}

export function finalizePolygonROI() {
  if (!state.pending || state.mode !== 'polygon') return;
  if (state.pending.pts.length < 3) { state.pending = null; state.deps.onROIChange?.(); return; }
  finalize();
}

// CT ROIs measure Hounsfield from the raw volume; in a 2D-only session it isn't
// loaded yet, so pull it in on demand (cached + shared with 3D/MPR). Taking a
// measurement also lights up the hover HU readout, which reads the same volume.
async function ensureCtHuVolume() {
  const host = state.deps?.state;
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (!series || series.modality !== 'CT' || (!series.hasRaw && !series.rawUrl)) return;
  if (host.hrVoxels?.length === series.width * series.height * series.slices) return;
  try { await (await import('./volume/volume-hr-voxels.js')).ensureHRVoxels(); }
  catch { /* fall back to the 8-bit display path */ }
}

async function finalize() {
  if (!state.pending) return;
  const { pts, shape } = state.pending;
  await ensureCtHuVolume();
  if (!state.pending) return; // cancelled while the volume loaded
  const stats = computeStats(pts, shape);
  if (!stats) { state.pending = null; state.deps.onROIChange?.(); return; }
  const list = listHere();
  list.push({
    id:    nextDrawingEntryId(list),
    shape,
    pts:   pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
    stats,
    microscopy: currentMicroscopyScope(),
    createdAt: Date.now(),
  });
  setHere(list);
  state.pending = null;
  state.deps.onROIChange?.();
}

function appendPointCount(px, py) {
  const list = listHere();
  const scope = currentMicroscopyScope();
  const point = [Math.round(px), Math.round(py)];
  let targetIndex = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].shape === 'point' && sameMicroscopyScope(list[index], scope)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex >= 0) {
    const current = list[targetIndex];
    const next = { ...current, pts: [...(current.pts || []), point] };
    const stats = computeStats(next.pts, 'point');
    if (!stats) return;
    next.stats = stats;
    list[targetIndex] = next;
  } else {
    const stats = computeStats([point], 'point');
    if (!stats) return;
    list.push({
      id: nextDrawingEntryId(list),
      shape: 'point',
      pts: [point],
      stats,
      microscopy: scope,
      createdAt: Date.now(),
    });
  }
  setHere(list);
  state.pending = null;
  state.deps.onROIChange?.();
}

// Re-compute stats for every ROI on the current slice. Used when the
// source data or the underlying slice changes.
export function refreshROIStatsHere() {
  const list = listHere();
  if (!list.length) return;
  for (const roi of list) {
    const fresh = computeStats(roi.pts, roi.shape);
    if (fresh) roi.stats = fresh;
  }
  setHere(list);
}

// Total count across all slices of the current series (for sidebar).
export function countROIs() {
  const { state: host } = state.deps;
  if (!host || !host.manifest) return 0;
  const series = host.manifest.series[host.seriesIdx];
  return drawingEntriesForSeries(host, series)
    .filter((entry) => entry.kind === 'ellipse' || entry.kind === 'polygon' || entry.kind === 'polyline' || entry.kind === 'point')
    .length;
}
