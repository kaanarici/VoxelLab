// Bridge from Analyze Particles output into the existing ROI-results table. Each detected
// object becomes a polygon ROI entry so CSV/JSON/PNG/ImageJ-ROI-ZIP export and the results
// panel all work unchanged. Measurements carry the raw_16bit domain (D1b).

import { nextDrawingEntryId, roiEntriesForSlice, setRoiEntriesForSlice } from '../overlay/annotation-graph.js';
import { datasetSpacingMm } from './microscopy-dataset-model.js';
import { projectStack } from './microscopy-projection.js';
import { computeThreshold, applyThreshold } from './microscopy-threshold.js';
import { analyzeParticles } from './microscopy-particles.js';

export function particleObjectToEntry(object, index, id, ctx) {
  const { channelIndex, channelName, timeIndex, slug, sliceIdx, createdAt } = ctx;
  const mean = object.mean;
  const area = object.area;
  return {
    id,
    shape: 'polygon',
    label: `Particle ${index + 1}`,
    pts: object.polygon.map(([x, y]) => [x, y]),
    microscopy: { channelIndex, channelName: channelName || '', timeIndex },
    stats: {
      pixels: area,
      count: area,
      area_mm2: object.areaMm2 ?? null,
      perimeter_mm: object.perimeterMm ?? null,
      perimeter_px: object.perimeterPx,
      // ImageJ traced-perimeter values are authoritative for particles; the ROI table must
      // not recompute a plain euclidean perimeter from the staircase polygon.
      perimeterMethod: 'imagej-traced',
      circularity: object.circularity,
      mean,
      std: object.std,
      min: object.min,
      max: object.max,
      // Pre-populate raw integrated density so the row honors it directly; calibrated
      // IntDen columns derive from the raw mean in roiResultRows when spacing is known.
      raw_int_den: mean * area,
      int_den_mm2: object.areaMm2 != null ? mean * object.areaMm2 : null,
      valueSource: 'raw_16bit',
      valueUnit: 'raw',
    },
    source: 'analyze-particles',
    createdAt,
    importedObjectId: `particles:${slug}|${sliceIdx}|c${channelIndex}|t${timeIndex}:${index + 1}`,
  };
}

// Appends particle objects to the active slice's ROI entries. Returns the stable object ids
// (used by the recipe operation descriptor for deterministic replay).
export function applyParticleResults(host, series, {
  sliceIdx, channelIndex = 0, channelName = '', timeIndex = 0, objects = [], createdAt = Date.now(),
} = {}) {
  const list = roiEntriesForSlice(series.slug, sliceIdx).slice();
  const ids = [];
  objects.forEach((object, index) => {
    const entry = particleObjectToEntry(object, index, nextDrawingEntryId(list), {
      channelIndex, channelName, timeIndex, slug: series.slug, sliceIdx, createdAt,
    });
    list.push(entry);
    ids.push(entry.importedObjectId);
  });
  setRoiEntriesForSlice(series.slug, sliceIdx, list);
  return ids;
}

function columnPlanes(host, series, channelIndex, timeIndex) {
  return host?._localMicroscopyPlanes?.[series.slug]?.[`${channelIndex | 0}|${timeIndex | 0}`] || null;
}

// Resolves the raw source plane for analysis: a Z-projection over the C/T column, or the
// single active Z plane. Returns null when raw planes were not retained (fail closed).
function resolveSourcePlane(host, series, { channelIndex, timeIndex, sliceIdx, projection }) {
  const column = columnPlanes(host, series, channelIndex, timeIndex);
  if (!column || !column.length) return null;
  if (projection && projection.mode) {
    return projectStack(column, { mode: projection.mode, zRange: projection.zRange || null });
  }
  return column[sliceIdx | 0] || null;
}

function recordAnalysisOp(host, slug, descriptor) {
  if (!host._microscopyAnalysisLog) host._microscopyAnalysisLog = {};
  (host._microscopyAnalysisLog[slug] ||= []).push(descriptor);
}

// Runs the full threshold → Analyze Particles chain on the active plane (optionally a
// Z-projection), writes rows, and records a serializable operation descriptor. The descriptor
// is the Tier-2 seam: the same {op, inputs, params} can later be dispatched to a PyImageJ
// backend and cross-validated. Threshold resolvedValue is captured numerically so replay is
// deterministic. Returns { ok, descriptor, objectIds, summary } or { ok:false, reason }.
export function runParticleAnalysis(host, series, config = {}) {
  const {
    channelIndex = 0, timeIndex = 0, sliceIdx = 0, channelName = '',
    projection = null, threshold = {}, particle = {}, createdAt = Date.now(), record = true,
  } = config;
  const plane = resolveSourcePlane(host, series, { channelIndex, timeIndex, sliceIdx, projection });
  if (!plane) return { ok: false, reason: 'no_raw_plane' };

  const thr = computeThreshold(plane, threshold);
  const mask = applyThreshold(plane, thr);
  const spacing = datasetSpacingMm(series.microscopyDataset || {});
  const known = spacing.rowMm > 0 && spacing.colMm > 0;
  const sizeRange = particle.sizeRange || [1, Infinity];
  const circularityRange = particle.circularityRange || [0, 1];
  const excludeEdges = !!particle.excludeEdges;
  const { objects, summary, labeledMask } = analyzeParticles(mask, plane, { sizeRange, circularityRange, excludeEdges }, {
    rowMm: spacing.rowMm, colMm: spacing.colMm, known,
  });
  const objectIds = applyParticleResults(host, series, {
    sliceIdx, channelIndex, channelName, timeIndex, objects, createdAt,
  });

  const log = host?._microscopyAnalysisLog?.[series.slug] || [];
  const descriptor = {
    op: 'analyze-particles',
    opId: `${series.slug}:ap:${log.length}`,
    createdAt,
    inputs: { seriesId: series.slug, c: channelIndex, z: sliceIdx, t: timeIndex, level: 0 },
    calibration: { xyKnown: known, rowMm: spacing.rowMm || 0, colMm: spacing.colMm || 0 },
    measurementDomain: 'raw_16bit',
    params: {
      projection: projection && projection.mode ? { mode: projection.mode, zRange: projection.zRange || null } : null,
      threshold: {
        method: thr.method, resolvedValue: thr.resolvedValue, darkBackground: thr.darkBackground,
        pixelMin: thr.pixelMin, pixelMax: thr.pixelMax, histogramBins: thr.histogramBins,
      },
      // maxSize unbounded is stored as null (Infinity is not JSON-serializable).
      particle: {
        connectivity: 8,
        sizeRangePx: [sizeRange[0], Number.isFinite(sizeRange[1]) ? sizeRange[1] : null],
        circularityRange,
        excludeEdges,
      },
    },
    outputRoiObjectIds: objectIds,
  };
  if (record) recordAnalysisOp(host, series.slug, descriptor);
  return {
    ok: true, descriptor, objectIds, summary, labeledMask, mask,
    width: plane.width, height: plane.height, threshold: thr,
  };
}

// Re-runs an analysis op from its descriptor (recipe replay). Does not re-record into the log.
export function replayAnalysisOp(host, series, descriptor, { createdAt = Date.now() } = {}) {
  const p = descriptor?.params || {};
  const max = p.particle?.sizeRangePx?.[1];
  return runParticleAnalysis(host, series, {
    channelIndex: descriptor?.inputs?.c || 0,
    timeIndex: descriptor?.inputs?.t || 0,
    sliceIdx: descriptor?.inputs?.z ?? 0,
    projection: p.projection || null,
    threshold: { method: 'manual', value: p.threshold?.resolvedValue, darkBackground: p.threshold?.darkBackground !== false },
    particle: {
      sizeRange: [p.particle?.sizeRangePx?.[0] ?? 1, max == null ? Infinity : max],
      circularityRange: p.particle?.circularityRange || [0, 1],
      excludeEdges: !!p.particle?.excludeEdges,
    },
    createdAt,
    record: false,
  });
}
