// Bridge from Analyze Particles output into the existing ROI-results table. Each detected
// object becomes a polygon ROI entry so CSV/JSON/PNG/ImageJ-ROI-ZIP export and the results
// panel all work unchanged. Measurements retain their source scalar domain (D1b).

import {
  measurementEntriesForSlice,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setRoiEntriesForSlice,
} from '../overlay/annotation-graph.js';
import { inPlanePixelSpacing } from '../core/geometry.js';
import { seriesPersistenceKey } from '../series/series-identity.js';
import { datasetSpacingMm, rawMicroscopyValueSource } from './microscopy-dataset-model.js';
import { projectStack } from './microscopy-projection.js';
import { computeThreshold, applyThreshold } from './microscopy-threshold.js';
import { analyzeParticles } from './microscopy-particles.js';
import { pixelwiseColocalization, sampleLineProfile } from './microscopy-quantification.js';

export function particleObjectToEntry(object, index, id, ctx) {
  const { channelIndex, channelName, timeIndex, slug, sliceIdx, createdAt, valueSource = 'raw_16bit' } = ctx;
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
      valueSource,
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
  sliceIdx, channelIndex = 0, channelName = '', timeIndex = 0, objects = [], createdAt = Date.now(), valueSource = 'raw_16bit',
} = {}) {
  const list = roiEntriesForSlice(host, series, sliceIdx).slice();
  const ids = [];
  objects.forEach((object, index) => {
    const entry = particleObjectToEntry(object, index, nextDrawingEntryId(list), {
      channelIndex, channelName, timeIndex, slug: series.slug, sliceIdx, createdAt, valueSource,
    });
    list.push(entry);
    ids.push(entry.importedObjectId);
  });
  setRoiEntriesForSlice(host, series, sliceIdx, list);
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

function analysisIdentity(host, series) {
  return seriesPersistenceKey(series, host?.manifest || {});
}

function analysisLogForSeries(host, series) {
  const identity = analysisIdentity(host, series);
  return identity ? host?._microscopyAnalysisLog?.[identity] || [] : [];
}

function recordAnalysisOp(host, series, descriptor) {
  const identity = analysisIdentity(host, series);
  if (!identity) return;
  if (!host._microscopyAnalysisLog) host._microscopyAnalysisLog = {};
  (host._microscopyAnalysisLog[identity] ||= []).push(descriptor);
}

function setLatestResult(host, series, key, result) {
  const identity = analysisIdentity(host, series);
  if (!identity) return;
  if (!host._microscopyAnalysisResults) host._microscopyAnalysisResults = {};
  (host._microscopyAnalysisResults[identity] ||= {})[key] = { ...result, seriesPersistenceKey: identity };
}

function activeLine(host, series, sliceIdx, channelIndex, timeIndex) {
  const lines = measurementEntriesForSlice(host, series, sliceIdx).filter((entry) => (
    Number(entry?.microscopy?.channelIndex ?? 0) === Number(channelIndex)
    && Number(entry?.microscopy?.timeIndex ?? 0) === Number(timeIndex)
  ));
  return lines.at(-1) || null;
}

function channelName(series, index) {
  return series?.microscopyDataset?.channels?.find(channel => Number(channel?.index) === Number(index))?.name
    || `Channel ${Number(index) + 1}`;
}

function sameLine(left = {}, right = {}) {
  return ['x1', 'y1', 'x2', 'y2'].every(key => Number(left[key]) === Number(right[key]));
}

export function matchingLineProfileResult(host, series, {
  channelIndex = 0, timeIndex = 0, sliceIdx = 0, sampling = 'nearest',
} = {}) {
  const identity = analysisIdentity(host, series);
  const result = host?._microscopyAnalysisResults?.[identity]?.lineProfile;
  const inputs = result?.descriptor?.inputs || {};
  const params = result?.descriptor?.params || {};
  const line = activeLine(host, series, sliceIdx, channelIndex, timeIndex);
  return result?.seriesPersistenceKey === identity
    && Number(inputs.c) === Number(channelIndex)
    && Number(inputs.t) === Number(timeIndex)
    && Number(inputs.z) === Number(sliceIdx)
    && params.sampling === sampling
    && line
    && sameLine(params.line, line)
    ? result
    : null;
}

export function matchingColocalizationResult(host, series, {
  channelA, channelB, timeIndex = 0, sliceIdx = 0, thresholdA, thresholdB,
} = {}) {
  const identity = analysisIdentity(host, series);
  const result = host?._microscopyAnalysisResults?.[identity]?.colocalization;
  const inputs = result?.descriptor?.inputs || {};
  const params = result?.descriptor?.params || {};
  const ta = Number(thresholdA);
  const tb = Number(thresholdB);
  return result?.seriesPersistenceKey === identity
    && Number.isFinite(ta) && Number.isFinite(tb)
    && Number(inputs.cA) === Number(channelA)
    && Number(inputs.cB) === Number(channelB)
    && Number(inputs.t) === Number(timeIndex)
    && Number(inputs.z) === Number(sliceIdx)
    && Number(params.thresholdA) === ta
    && Number(params.thresholdB) === tb
    ? result
    : null;
}

export function runLineProfile(host, series, {
  channelIndex = 0, timeIndex = 0, sliceIdx = 0, sampling = 'nearest', line = null,
  createdAt = Date.now(), record = true,
} = {}) {
  const plane = resolveSourcePlane(host, series, { channelIndex, timeIndex, sliceIdx, projection: null });
  if (!plane) return { ok: false, reason: 'no_raw_plane' };
  const measurement = line || activeLine(host, series, sliceIdx, channelIndex, timeIndex);
  if (!measurement) return { ok: false, reason: 'no_active_line' };
  const spacing = inPlanePixelSpacing(series);
  const calibrationKnown = spacing.known && series._spacingKnown !== false;
  const result = sampleLineProfile(plane, measurement, {
    sampling,
    rowMm: calibrationKnown ? spacing.rowMm : null,
    colMm: calibrationKnown ? spacing.colMm : null,
  });
  if (!result.ok) return result;
  const log = analysisLogForSeries(host, series);
  const descriptor = {
    op: 'line-profile',
    opId: `${series.slug}:lp:${log.length}`,
    createdAt,
    inputs: { seriesId: series.slug, c: channelIndex, z: sliceIdx, t: timeIndex, level: 0 },
    calibration: { xyKnown: result.calibrated, rowMm: result.calibrated ? spacing.rowMm : null, colMm: result.calibrated ? spacing.colMm : null },
    measurementDomain: rawMicroscopyValueSource(series),
    params: {
      sampling,
      line: {
        measurementId: measurement.measurementId ?? measurement.id ?? null,
        x1: Number(measurement.x1), y1: Number(measurement.y1),
        x2: Number(measurement.x2), y2: Number(measurement.y2),
      },
    },
  };
  setLatestResult(host, series, 'lineProfile', { ...result, descriptor, channelName: channelName(series, channelIndex) });
  if (record) recordAnalysisOp(host, series, descriptor);
  return { ...result, descriptor, objectIds: [] };
}

export function runPixelwiseColocalization(host, series, {
  channelA = 0, channelB = 1, timeIndex = 0, sliceIdx = 0,
  thresholdA, thresholdB, createdAt = Date.now(), record = true,
} = {}) {
  if (Number(channelA) === Number(channelB)) return { ok: false, reason: 'same_channel' };
  const planeA = resolveSourcePlane(host, series, { channelIndex: channelA, timeIndex, sliceIdx, projection: null });
  const planeB = resolveSourcePlane(host, series, { channelIndex: channelB, timeIndex, sliceIdx, projection: null });
  if (!planeA || !planeB) return { ok: false, reason: 'no_raw_plane' };
  const result = pixelwiseColocalization(planeA, planeB, { thresholdA, thresholdB });
  if (!result.ok) return result;
  const log = analysisLogForSeries(host, series);
  const descriptor = {
    op: 'pixelwise-colocalization',
    opId: `${series.slug}:pc:${log.length}`,
    createdAt,
    inputs: { seriesId: series.slug, cA: Number(channelA), cB: Number(channelB), z: sliceIdx, t: timeIndex, level: 0 },
    measurementDomain: rawMicroscopyValueSource(series),
    params: { thresholdA: Number(thresholdA), thresholdB: Number(thresholdB), roiMask: null },
  };
  setLatestResult(host, series, 'colocalization', {
    ...result, descriptor, channelAName: channelName(series, channelA), channelBName: channelName(series, channelB),
  });
  if (record) recordAnalysisOp(host, series, descriptor);
  return { ...result, descriptor, objectIds: [] };
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
    valueSource: rawMicroscopyValueSource(series),
  });

  const log = analysisLogForSeries(host, series);
  const descriptor = {
    op: 'analyze-particles',
    opId: `${series.slug}:ap:${log.length}`,
    createdAt,
    inputs: { seriesId: series.slug, c: channelIndex, z: sliceIdx, t: timeIndex, level: 0 },
    calibration: { xyKnown: known, rowMm: spacing.rowMm || 0, colMm: spacing.colMm || 0 },
    measurementDomain: rawMicroscopyValueSource(series),
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
  if (record) recordAnalysisOp(host, series, descriptor);
  return {
    ok: true, descriptor, objectIds, summary, labeledMask, mask,
    width: plane.width, height: plane.height, threshold: thr,
  };
}

// Re-runs an analysis op from its descriptor (recipe replay). Does not re-record into the log.
export function replayAnalysisOp(host, series, descriptor, { createdAt = Date.now() } = {}) {
  const p = descriptor?.params || {};
  if (descriptor?.op === 'line-profile') {
    return runLineProfile(host, series, {
      channelIndex: descriptor?.inputs?.c || 0,
      timeIndex: descriptor?.inputs?.t || 0,
      sliceIdx: descriptor?.inputs?.z ?? 0,
      sampling: p.sampling,
      line: p.line,
      createdAt,
      record: false,
    });
  }
  if (descriptor?.op === 'pixelwise-colocalization') {
    return runPixelwiseColocalization(host, series, {
      channelA: descriptor?.inputs?.cA,
      channelB: descriptor?.inputs?.cB,
      timeIndex: descriptor?.inputs?.t || 0,
      sliceIdx: descriptor?.inputs?.z ?? 0,
      thresholdA: p.thresholdA,
      thresholdB: p.thresholdB,
      createdAt,
      record: false,
    });
  }
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
