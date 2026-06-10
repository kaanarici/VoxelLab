// Capture path for microscopy workflow recipes: snapshots the active series'
// view, stack position, channel display state, and embedded measurement/ROI
// bundles into a portable recipe. Also hosts the shared series-shape and
// numeric primitives consumed by the replay path (recipe-replay.js).

import { state } from '../core/state.js';
import {
  drawingEntriesForSeries,
} from '../overlay/annotation-graph.js';
import { normalizeLengthUnit } from '../core/physical-units.js';
import {
  roiResultRows,
  roiResultsBundle,
} from '../roi/roi-results.js';
import {
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_V2,
} from '../sidecar-schemas.js';
import { ensureMicroscopyComposite } from './microscopy-channel-composite.js';
import { finiteDisplayRange } from './microscopy-display-range.js';
import { microscopyCalibrationTrustText } from './microscopy-provenance-text.js';

export function finitePositiveInteger(value, fallback = 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function finiteInteger(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

export function channelCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 'c')?.size
      ?? series.microscopy?.sizeC
      ?? series.microscopyDataset?.channels?.length
      ?? 1,
    1,
  );
}

export function timeCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 't')?.size
      ?? series.microscopy?.sizeT
      ?? 1,
    1,
  );
}

export function depthCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 'z')?.size
      ?? series.microscopy?.sizeZ
      ?? series.slices
      ?? 1,
    1,
  );
}

export function hasKnownXYCalibration(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  return spacing.length >= 2 && Number(spacing[0]) > 0 && Number(spacing[1]) > 0 && series._spacingKnown !== false;
}

export function finitePositiveNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function recipeCalibrationState(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  const rowMm = finitePositiveNumber(spacing[0]);
  const colMm = finitePositiveNumber(spacing[1]);
  const zMm = finitePositiveNumber(series.sliceSpacing || series.sliceThickness);
  const xyKnown = rowMm != null && colMm != null && series._spacingKnown !== false;
  const zKnown = zMm != null && series._sliceSpacingKnown !== false;
  return {
    xyKnown,
    rowMm: xyKnown ? rowMm : null,
    colMm: xyKnown ? colMm : null,
    zKnown,
    zMm: zKnown ? zMm : null,
    displayUnit: normalizeLengthUnit(series.microscopy?.physicalUnit || series.physicalUnit || 'µm'),
    trust: microscopyCalibrationTrustText(series, spacing),
  };
}

export function measurementRows(series, host = state) {
  return drawingEntriesForSeries(host, series?.slug || '')
    .filter((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon' || entry?.kind === 'point' || entry?.kind === 'line');
}

function angleMeasurementRows(series, host = state) {
  return drawingEntriesForSeries(host, series?.slug || '').filter((entry) => entry?.kind === 'angle');
}

function channelRecipeState(series = {}) {
  const count = channelCount(series);
  return Array.from({ length: count }, (_, index) => {
    const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === index) || {};
    const color = String(channel.displayColor || channel.color || '').toUpperCase();
    return {
      index,
      name: channel.name || `Channel ${index + 1}`,
      color: /^#[0-9A-F]{6}$/.test(color) ? color : '',
      displayRange: finiteDisplayRange(channel.displayRange),
      displayRangeSource: channel.displayRangeSource || '',
    };
  });
}

export function cleanPoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function cleanAnglePoints(entry = {}) {
  const p1 = cleanPoint(entry.p1);
  const vertex = cleanPoint(entry.vertex);
  const p3 = cleanPoint(entry.p3);
  return p1 && vertex && p3 ? { p1, vertex, p3 } : null;
}

export function angleObjectId(series, sliceIdx, entry = {}, index = 0) {
  return `angle:${series?.slug || ''}|${sliceIdx}:${entry?.id ?? index}`;
}

function isoDateOrEmpty(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

export function channelNameForIndex(series, index) {
  const channel = series?.microscopyDataset?.channels?.find((item) => Number(item?.index) === index);
  return channel?.name || `Channel ${index + 1}`;
}

function angleMeasurementsBundle(rows, series = {}) {
  const sizeC = channelCount(series);
  const sizeT = timeCount(series);
  return {
    rows: (rows || []).map((row, index) => {
      const entry = row?.data || {};
      const microscopy = entry.microscopy || {};
      const sliceIndex = Math.max(0, finiteInteger(row?.sliceIdx, 0));
      const channelIndex = Math.max(0, Math.min(sizeC - 1, finiteInteger(microscopy.channelIndex, series?.microscopy?.channelIndex || 0)));
      const timeIndex = Math.max(0, Math.min(sizeT - 1, finiteInteger(microscopy.timeIndex, series?.microscopy?.timeIndex || 0)));
      const points = cleanAnglePoints(entry);
      return {
        angleObjectId: row?.id || angleObjectId(series, sliceIndex, entry, index),
        sliceIndex,
        label: String(entry.label || '').trim(),
        angleDeg: Number(entry.deg),
        points,
        channelIndex,
        channelName: microscopy.channelName || channelNameForIndex(series, channelIndex),
        timeIndex,
        createdAt: isoDateOrEmpty(entry.createdAt),
      };
    }).filter((row) => Number.isFinite(row.angleDeg) && row.points),
  };
}

export function activeSeries(host = state) {
  return host?.manifest?.series?.[host.seriesIdx] || null;
}

export function captureMicroscopyWorkflowRecipe(host = state) {
  const series = activeSeries(host);
  if (!series || series.imageDomain !== 'microscopy') return null;
  const measurements = measurementRows(series, host);
  const angles = angleMeasurementRows(series, host);
  const resultRows = roiResultRows(host, series).filter(row => row.kind !== 'angle');
  const embeddedRoiResults = resultRows.length > 0 ? roiResultsBundle(resultRows, series) : null;
  const angleBundle = angles.length > 0 ? angleMeasurementsBundle(angles, series) : null;
  const embeddedAngleMeasurements = angleBundle?.rows?.length ? angleBundle : null;
  const requiresTrusted = measurements.some((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon');
  const countC = channelCount(series);
  const currentC = Math.max(0, Math.min(countC - 1, finiteInteger(series.microscopy?.channelIndex, 0)));
  const currentT = Math.max(0, Math.min(timeCount(series) - 1, finiteInteger(series.microscopy?.timeIndex, 0)));
  const composite = ensureMicroscopyComposite(series, countC);
  const analysisOps = Array.isArray(host?._microscopyAnalysisLog?.[series.slug])
    ? host._microscopyAnalysisLog[series.slug]
    : [];
  return {
    schema: analysisOps.length ? MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_V2 : MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    kind: 'microscopy-workflow-recipe',
    createdAt: new Date().toISOString(),
    target: {
      imageDomain: 'microscopy',
      slug: series.slug || '',
      name: series.name || series.slug || '',
      sourceFormat: series.microscopyDataset?.source?.originalFormat || series.sequence || '',
      geometry: {
        width: finitePositiveInteger(series.width, 1),
        height: finitePositiveInteger(series.height, 1),
        slices: finitePositiveInteger(series.slices, 1),
        sizeZ: depthCount(series),
        sizeC: countC,
        sizeT: timeCount(series),
      },
    },
    requirements: {
      calibrationRequired: hasKnownXYCalibration(series),
      measurementPrerequisite: measurements.length > 0 || angles.length > 0 ? 'results-present' : 'none',
      analysisOpsPresent: analysisOps.length > 0,
    },
    analysisOps: analysisOps.length ? analysisOps : null,
    calibration: recipeCalibrationState(series),
    view: {
      window: Number(host.window),
      level: Number(host.level),
      invertDisplay: !!host.invertDisplay,
      colormap: String(host.colormap || 'grayscale'),
      sliceIndex: Math.max(0, finiteInteger(host.sliceIdx, 0)),
    },
    stack: {
      channelIndex: currentC,
      timeIndex: currentT,
      compositeEnabled: !!composite.enabled,
      compositeChannels: Array.from({ length: countC }, (_, index) => composite.channels[index] !== false),
    },
    channels: channelRecipeState(series),
    roiResults: embeddedRoiResults,
    angleMeasurements: embeddedAngleMeasurements,
    exportPreferences: {
      csv: true,
      jsonBundle: true,
      overlayPng: true,
      embeddedRoiResults: !!embeddedRoiResults,
      embeddedAngleMeasurements: !!embeddedAngleMeasurements,
      requireTrustedMeasurements: requiresTrusted,
    },
  };
}
