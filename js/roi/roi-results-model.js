// ROI results data model: turns annotation-graph entries into calibrated
// result rows, builds/validates/imports the JSON sidecar bundle, and resolves
// which stack position a row lives at. No DOM, no file I/O — those live in
// roi-results-table.js / roi-results-export.js.

import {
  angleEntriesForSlice,
  drawingEntriesForSeries,
  measurementEntriesForSlice,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} from '../overlay/annotation-graph.js';
import { formatAreaFromMm2, formatLengthFromMm, lengthUnitToMm, preferredLengthUnit } from '../core/physical-units.js';
import { microscopyCalibrationTrustText } from '../microscopy/microscopy-provenance-text.js';
import { ROI_RESULTS_BUNDLE_SCHEMA } from '../sidecar-schemas.js';
import { seriesPersistenceKey } from '../series/series-identity.js';
import { state } from '../core/state.js';
import { roiCircularityValue, roiCoordinateValues, roiPerimeterValues } from './roi-results-geometry.js';
import { formatNumber, intDenForRow, intDenMm2ForRow, isIntensityValueSource, rawIntDenForRow } from './roi-results-metrics.js';

export function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null) return n;
  }
  return null;
}

export function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function rowCreatedAt(value) {
  const explicit = finiteNumber(value);
  if (explicit != null) return explicit;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function resultLabel(entry = {}, index = 0) {
  const data = entry.data || {};
  const explicit = textValue(data.label) || textValue(data.text);
  if (explicit) return explicit;
  const id = Number.isFinite(Number(data.id)) ? Number(data.id) : index + 1;
  if (entry.kind === 'angle') return `Angle ${id}`;
  if (entry.kind === 'line') return `Line ${id}`;
  if (entry.kind === 'polyline') return `PolyLine ${id}`;
  return `ROI ${id}`;
}

function areaValueInUnit2(areaMm2, unit) {
  const n = finiteNumber(areaMm2);
  if (n == null) return null;
  const scale = 1 / lengthUnitToMm(unit);
  return n * scale * scale;
}

export function lengthValueInUnit(lengthMm, unit) {
  const n = finiteNumber(lengthMm);
  if (n == null) return null;
  return n / lengthUnitToMm(unit);
}

function roiStatsForExport(stats = {}) {
  if (stats.adc) {
    return {
      mean: finiteNumber(stats.adc.mean),
      std: finiteNumber(stats.adc.std),
      min: finiteNumber(stats.adc.min),
      max: finiteNumber(stats.adc.max),
      valueUnit: stats.adc.unit || 'ADC',
      valueSource: 'physical_adc',
    };
  }
  if (stats.valueSource === 'raw_16bit' || stats.valueSource === 'raw_scalar') {
    return {
      mean: finiteNumber(stats.mean),
      std: finiteNumber(stats.std),
      min: finiteNumber(stats.min),
      max: finiteNumber(stats.max),
      valueUnit: 'raw',
      valueSource: stats.valueSource,
    };
  }
  if (stats.valueSource === 'hounsfield') {
    return {
      mean: finiteNumber(stats.mean),
      std: finiteNumber(stats.std),
      min: finiteNumber(stats.min),
      max: finiteNumber(stats.max),
      valueUnit: 'HU',
      valueSource: 'hounsfield',
    };
  }
  return {
    mean: finiteNumber(stats.mean),
    std: finiteNumber(stats.std),
    min: finiteNumber(stats.min),
    max: finiteNumber(stats.max),
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
  };
}

export function cleanPoints(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => Array.isArray(point) ? point.map(finiteNumber) : [])
    .filter((point) => point.length >= 2 && point.every((value) => value != null))
    .map(([x, y]) => [x, y]);
}

// ROI geometry uses canvas edge coordinates: width/height are valid right/bottom
// edges, and ROI stat sampling clamps to the last real pixel before indexing.
function pointsFitImageBounds(points = [], series = {}) {
  const width = finiteNumber(series.width);
  const height = finiteNumber(series.height);
  if (!(width > 0) || !(height > 0)) return true;
  return points.every(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height);
}

function pointCenter(points = []) {
  const cleaned = cleanPoints(points);
  if (!cleaned.length) return { x: null, y: null };
  const sum = cleaned.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return { x: sum[0] / cleaned.length, y: sum[1] / cleaned.length };
}

function drawingPoints(entry = {}) {
  const data = entry.data || {};
  if (entry.kind === 'line') return cleanPoints([[data.x1, data.y1], [data.x2, data.y2]]);
  if (entry.kind === 'angle') return cleanPoints([[data.p1?.x, data.p1?.y], [data.vertex?.x, data.vertex?.y], [data.p3?.x, data.p3?.y]]);
  return cleanPoints(data.pts);
}

function valuesForEntry(entry, stats) {
  if (entry.kind === 'line' || entry.kind === 'polyline' || entry.kind === 'angle') {
    return {
      mean: null,
      std: null,
      min: null,
      max: null,
      rawIntDen: null,
      valueUnit: '',
      valueSource: entry.kind === 'angle' ? 'angular_measurement' : 'linear_measurement',
    };
  }
  const values = roiStatsForExport(stats);
  values.rawIntDen = firstFinite(stats.raw_int_den, stats.rawIntDen);
  values.intDen = firstFinite(stats.int_den, stats.intDen);
  values.intDenMm2 = firstFinite(stats.int_den_mm2, stats.intDenMm2);
  values.rawIntDen ??= isIntensityValueSource(values.valueSource)
    && finiteNumber(values.mean) != null
    && finiteNumber(stats?.pixels) != null
    ? values.mean * stats.pixels
    : null;
  return values;
}

function perimeterValuesForEntry(entry = {}, points = [], series = {}, unit = 'mm') {
  const stats = entry.data?.stats || {};
  const perimeter = roiPerimeterValues({ kind: entry.kind, points, series, stats });
  return {
    perimeterMm: perimeter.mm,
    perimeterPx: perimeter.px,
    perimeterUnitValue: lengthValueInUnit(perimeter.mm, unit),
    perimeterDisplay: perimeter.mm == null ? (perimeter.px == null ? '—' : `${formatNumber(perimeter.px)} px`) : formatLengthFromMm(perimeter.mm, series),
  };
}

function rowEntryLocalId(row = {}) {
  const match = String(row.localEntryId || row.id || row.objectId || '').match(/:(\d+)$/);
  return finiteNumber(match?.[1]) ?? finiteNumber(row.index);
}

export function setRoiResultLabel(row, label, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const sliceIdx = Math.max(0, Math.floor(Number(row?.sliceIdx) || 0));
  const id = rowEntryLocalId(row);
  if (!series?.slug || id == null) return false;
  const clean = textValue(label);
  if (row.kind === 'angle') {
    const list = angleEntriesForSlice(host, series, sliceIdx);
    const item = list.find(entry => Number(entry?.id) === id);
    if (!item) return false;
    item.label = clean;
    setAngleEntriesForSlice(host, series, sliceIdx, list);
    return true;
  }
  if (row.kind === 'line') {
    const list = measurementEntriesForSlice(host, series, sliceIdx);
    const item = list.find(entry => Number(entry?.id) === id);
    if (!item) return false;
    item.label = clean;
    setMeasurementEntriesForSlice(host, series, sliceIdx, list);
    return true;
  }
  const list = roiEntriesForSlice(host, series, sliceIdx);
  const item = list.find(entry => Number(entry?.id) === id);
  if (!item) return false;
  item.label = clean;
  setRoiEntriesForSlice(host, series, sliceIdx, list);
  return true;
}

export function roiResultRows(host = state, series = host?.manifest?.series?.[host.seriesIdx]) {
  if (!host?.manifest || !series?.slug) return [];
  const unit = preferredLengthUnit(series);
  return drawingEntriesForSeries(host, series)
    .filter((entry) => entry.kind === 'ellipse' || entry.kind === 'polygon' || entry.kind === 'polyline' || entry.kind === 'point' || entry.kind === 'line' || entry.kind === 'angle')
    .map((entry, index) => {
      const roi = entry.data || {};
      const stats = roi.stats || {};
      const points = drawingPoints(entry);
      const center = pointCenter(points);
      const coordinates = roiCoordinateValues(center, series);
      const values = valuesForEntry(entry, stats);
      const angleDeg = entry.kind === 'angle' ? finiteNumber(roi.deg) : null;
      const lengthMm = entry.kind === 'line' && roi.spacingKnown !== false && roi.unit !== 'px'
        ? finiteNumber(roi.mm)
        : entry.kind === 'polyline' ? finiteNumber(stats.length_mm) : null;
      const lengthPx = entry.kind === 'line' && (roi.spacingKnown === false || roi.unit === 'px')
        ? finiteNumber(roi.mm)
        : entry.kind === 'polyline' ? finiteNumber(stats.length_px) : null;
      const areaMm2 = finiteNumber(stats.area_mm2);
      const areaUnit2 = areaValueInUnit2(areaMm2, unit);
      const perimeter = perimeterValuesForEntry(entry, points, series, unit);
      const intDen = values.intDen ?? (isIntensityValueSource(values.valueSource) && values.mean != null && areaUnit2 != null ? values.mean * areaUnit2 : null);
      const intDenMm2 = values.intDenMm2 ?? (isIntensityValueSource(values.valueSource) && values.mean != null && areaMm2 != null ? values.mean * areaMm2 : null);
      const circularity = entry.kind === 'ellipse' || entry.kind === 'polygon'
        ? roiCircularityValue({
          areaMm2,
          pixels: finiteNumber(stats.pixels),
          perimeterMm: perimeter.perimeterMm,
          perimeterPx: perimeter.perimeterPx,
        })
        : null;
      const microscopy = roi.microscopy || series.microscopy || {};
      const source = series.microscopyDataset?.source || {};
      const channelZeroIndex = Number.isFinite(Number(microscopy.channelIndex)) ? Number(microscopy.channelIndex) : null;
      const timeZeroIndex = Number.isFinite(Number(microscopy.timeIndex)) ? Number(microscopy.timeIndex) : null;
      return {
        index: Number.isFinite(Number(roi.id)) ? Number(roi.id) : index + 1,
        objectId: roi.importedObjectId || entry.id,
        id: entry.id,
        localEntryId: entry.id,
        seriesName: series.name || series.slug,
        seriesSlug: series.slug,
        sliceIdx: entry.sliceIdx,
        slice: entry.sliceIdx + 1,
        kind: entry.kind,
        label: resultLabel(entry, index),
        channelZeroIndex,
        timeZeroIndex,
        channelIndex: channelZeroIndex != null ? channelZeroIndex + 1 : '',
        channelName: microscopy.channelName || '',
        timeIndex: timeZeroIndex != null ? timeZeroIndex + 1 : '',
        points,
        xPx: center.x,
        yPx: center.y,
        xMm: coordinates.xMm, yMm: coordinates.yMm,
        xUnitValue: lengthValueInUnit(coordinates.xMm, unit), yUnitValue: lengthValueInUnit(coordinates.yMm, unit),
        count: finiteNumber(stats.count),
        angleDeg,
        lengthMm,
        lengthPx,
        lengthUnit: unit,
        lengthUnitValue: lengthValueInUnit(lengthMm, unit),
        lengthDisplay: lengthMm == null ? (lengthPx == null ? '—' : `${formatNumber(lengthPx)} px`) : formatLengthFromMm(lengthMm, series),
        pixels: finiteNumber(stats.pixels),
        areaMm2,
        areaUnit2,
        areaUnit: `${unit}²`,
        areaDisplay: areaMm2 == null ? '—' : formatAreaFromMm2(areaMm2, series),
        perimeterMm: perimeter.perimeterMm,
        perimeterPx: perimeter.perimeterPx,
        perimeterUnitValue: perimeter.perimeterUnitValue,
        perimeterDisplay: perimeter.perimeterDisplay,
        circularity,
        mean: values.mean,
        std: values.std,
        min: values.min,
        max: values.max,
        rawIntDen: values.rawIntDen,
        intDen,
        intDenMm2,
        valueUnit: values.valueUnit,
        valueSource: values.valueSource,
        sourceFormat: source.originalFormat || series.sequence || '',
        sourceFiles: microscopy.sourceFiles || source.files || [],
        createdAt: finiteNumber(roi.createdAt),
      };
    });
}

export function calibrationForBundle(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing.map(finiteNumber) : [];
  const xyKnown = spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0 && series._spacingKnown !== false;
  const zMm = finiteNumber(series.sliceSpacing || series.sliceThickness);
  const zKnown = zMm != null && zMm > 0 && series._sliceSpacingKnown !== false;
  return {
    xyKnown,
    rowMm: xyKnown ? spacing[0] : null,
    colMm: xyKnown ? spacing[1] : null,
    zKnown,
    zMm: zKnown ? zMm : null,
    displayUnit: preferredLengthUnit(series),
    source: calibrationSourceForBundle(series, xyKnown),
    trust: microscopyCalibrationTrustText(series, spacing),
  };
}

function calibrationSourceForBundle(series = {}, xyKnown = false) {
  if (!xyKnown) return '';
  if (series.microscopy?.calibrationSource === 'manual') return 'manual';
  const format = String(series.microscopyDataset?.source?.originalFormat || series.sequence || '').trim();
  if (/^tiff sequence$/i.test(format)) return 'manual';
  return 'metadata';
}

function numericArray(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(finiteNumber)
    .filter(value => value != null);
}

function microscopyDatasetProvenance(series = {}) {
  const dataset = series.microscopyDataset || {};
  return {
    axes: (dataset.axes || []).map(axis => ({
      name: axis?.name || '',
      type: axis?.type || '',
      size: finiteNumber(axis?.size),
      unit: axis?.unit || '',
      scale: finiteNumber(axis?.scale) ?? 0,
      known: !!axis?.known,
    })),
    channels: (dataset.channels || []).map(channel => ({
      index: finiteNumber(channel?.index),
      name: channel?.name || '',
      color: channel?.color || null,
      displayColor: channel?.displayColor || '',
      displayColorSource: channel?.displayColorSource || '',
      lut: channel?.lut || '',
      emissionWavelength: finiteNumber(channel?.emissionWavelength),
      emissionWavelengthUnit: channel?.emissionWavelengthUnit || '',
      displayRange: numericArray(channel?.displayRange),
      displayRangeSource: channel?.displayRangeSource || '',
    })),
    pixel: dataset.pixel ? {
      type: dataset.pixel.type || '',
      samplesPerPixel: finiteNumber(dataset.pixel.samplesPerPixel),
      endianness: dataset.pixel.endianness || '',
      min: finiteNumber(dataset.pixel.min),
      max: finiteNumber(dataset.pixel.max),
    } : null,
    levels: (dataset.levels || []).map(level => ({
      level: finiteNumber(level?.level),
      path: level?.path || '',
      width: finiteNumber(level?.width),
      height: finiteNumber(level?.height),
      tileWidth: finiteNumber(level?.tileWidth),
      tileHeight: finiteNumber(level?.tileHeight),
      chunkShape: level?.chunkShape || null,
      downsample: finiteNumber(level?.downsample),
    })),
    planes: (dataset.planes || []).map(plane => ({
      c: finiteNumber(plane?.c),
      z: finiteNumber(plane?.z),
      t: finiteNumber(plane?.t),
      level: finiteNumber(plane?.level),
      pageIndex: finiteNumber(plane?.pageIndex),
      width: finiteNumber(plane?.width),
      height: finiteNumber(plane?.height),
    })),
  };
}

export function sourceForBundle(series = {}) {
  const microscopy = series.microscopy || {};
  const source = series.microscopyDataset?.source || {};
  return {
    imageDomain: series.imageDomain || '',
    format: source.originalFormat || series.sequence || '',
    sourceFiles: microscopy.sourceFiles || [],
    dataset: microscopyDatasetProvenance(series),
    warnings: [...new Set([
      ...(source.warnings || []),
      ...(microscopy.sequenceWarnings || []),
    ].filter(Boolean))],
  };
}

export function roiResultsBundle(rows, series = state.manifest?.series?.[state.seriesIdx]) {
  return {
    schema: ROI_RESULTS_BUNDLE_SCHEMA,
    exportedAt: new Date().toISOString(),
    series: {
      slug: series?.slug || '',
      name: series?.name || series?.slug || '',
      persistenceKey: seriesPersistenceKey(series, state.manifest),
      width: finiteNumber(series?.width),
      height: finiteNumber(series?.height),
      slices: finiteNumber(series?.slices),
    },
    source: sourceForBundle(series || {}),
    calibration: calibrationForBundle(series || {}),
    rows: (rows || []).map((row) => ({
      roi: row.index,
      roiObjectId: row.objectId || row.id || '',
      slice: row.slice,
      sliceIndex: row.sliceIdx,
      kind: row.kind,
      label: row.label || '',
      points: cleanPoints(row.points),
      xPx: row.xPx,
      yPx: row.yPx,
      xMm: row.xMm, yMm: row.yMm,
      xUnitValue: row.xUnitValue, yUnitValue: row.yUnitValue,
      count: row.count,
      angleDeg: row.angleDeg,
      lengthDisplay: row.lengthDisplay,
      lengthUnit: row.lengthUnit,
      lengthUnitValue: row.lengthUnitValue,
      lengthMm: row.lengthMm,
      lengthPx: row.lengthPx,
      channel: row.channelName || row.channelIndex || '',
      channelIndex: row.channelZeroIndex,
      time: row.timeIndex || '',
      timeIndex: row.timeZeroIndex,
      areaDisplay: row.areaDisplay,
      areaUnit: row.areaUnit,
      areaUnit2: row.areaUnit2,
      areaMm2: row.areaMm2,
      perimeterDisplay: row.perimeterDisplay,
      perimeterUnitValue: row.perimeterUnitValue,
      perimeterMm: row.perimeterMm,
      perimeterPx: row.perimeterPx,
      circularity: row.circularity,
      pixels: row.pixels,
      mean: row.mean,
      std: row.std,
      min: row.min,
      max: row.max,
      rawIntDen: rawIntDenForRow(row),
      intDen: intDenForRow(row),
      intDenMm2: intDenMm2ForRow(row),
      valueUnit: row.valueUnit,
      valueSource: row.valueSource,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
    })),
  };
}

function bundleMatchesActiveSeries(bundle, series = {}, manifest = state.manifest) {
  const expected = bundle?.series || {};
  const expectedPersistenceKey = textValue(expected.persistenceKey);
  if (!expectedPersistenceKey) return { ok: false, reason: 'legacy_identity_unconfirmed' };
  if (expectedPersistenceKey !== seriesPersistenceKey(series, manifest)) return { ok: false, reason: 'series_identity_mismatch' };
  if (!expected.slug && !expected.name) return { ok: false, reason: 'series_mismatch' };
  const identityMatches = expected.slug === series.slug || expected.name === (series.name || series.slug);
  const widthMatches = finiteNumber(expected.width) == null || finiteNumber(expected.width) === finiteNumber(series.width);
  const heightMatches = finiteNumber(expected.height) == null || finiteNumber(expected.height) === finiteNumber(series.height);
  const sliceMatches = finiteNumber(expected.slices) == null || finiteNumber(expected.slices) === finiteNumber(series.slices);
  const expectedDomain = bundle?.source?.imageDomain || '';
  const domainMatches = !expectedDomain || expectedDomain === (series.imageDomain || '');
  const expectedAxes = bundle?.source?.dataset?.axes || [];
  const seriesAxes = series.microscopyDataset?.axes || [];
  const axisMismatch = expectedAxes.some((axis) => {
    const name = String(axis?.name || '');
    if (!name || !['c', 'z', 't'].includes(name)) return false;
    const expectedSize = finiteNumber(axis?.size);
    if (expectedSize == null) return false;
    const live = seriesAxes.find(item => item?.name === name);
    return finiteNumber(live?.size) !== expectedSize;
  });
  if (!identityMatches || !widthMatches || !heightMatches || !sliceMatches || !domainMatches) {
    return { ok: false, reason: 'series_mismatch' };
  }
  if (axisMismatch) {
    return { ok: false, reason: 'bundle_axis_mismatch' };
  }
  return { ok: true, reason: '' };
}

function bundleCalibrationMatchesActiveSeries(bundle, series = {}) {
  if (series.imageDomain !== 'microscopy') return { ok: true, reason: '' };
  const expected = bundle?.calibration || {};
  if (!expected.xyKnown) return { ok: true, reason: '' };
  const rowMm = finiteNumber(expected.rowMm);
  const colMm = finiteNumber(expected.colMm);
  const live = calibrationForBundle(series);
  const matches = live.xyKnown
    && rowMm != null
    && colMm != null
    && Math.abs(live.rowMm - rowMm) <= 1e-9
    && Math.abs(live.colMm - colMm) <= 1e-9;
  return matches ? { ok: true, reason: '' } : { ok: false, reason: 'bundle_calibration_mismatch' };
}

export function validateRoiResultsBundleForSeries(bundle, series = state.manifest?.series?.[state.seriesIdx], manifest = state.manifest) {
  const match = bundleMatchesActiveSeries(bundle, series, manifest);
  const calibrationMatch = match.ok ? bundleCalibrationMatchesActiveSeries(bundle, series) : { ok: true, reason: '' };
  if (!series?.slug || bundle?.schema !== ROI_RESULTS_BUNDLE_SCHEMA || !match.ok || !calibrationMatch.ok) {
    return { ok: false, reason: match.reason || calibrationMatch.reason || 'series_mismatch' };
  }
  return { ok: true, reason: '' };
}

function rowToRoiEntry(row, id) {
  const points = cleanPoints(row.points);
  const shape = ['polygon', 'polyline', 'ellipse', 'point'].includes(row.kind) ? row.kind : '';
  if (!shape || points.length < (shape === 'point' ? 1 : 2)) return null;
  return {
    id,
    shape,
    label: textValue(row.label),
    pts: points,
    microscopy: {
      channelIndex: finiteNumber(row.channelIndex) ?? 0,
      channelName: row.channel || '',
      timeIndex: finiteNumber(row.timeIndex) ?? 0,
    },
    stats: {
      pixels: finiteNumber(row.pixels),
      count: finiteNumber(row.count),
      area_mm2: finiteNumber(row.areaMm2),
      perimeter_mm: finiteNumber(row.perimeterMm),
      perimeter_px: finiteNumber(row.perimeterPx),
      circularity: finiteNumber(row.circularity),
      length_mm: finiteNumber(row.lengthMm),
      length_px: finiteNumber(row.lengthPx),
      mean: finiteNumber(row.mean),
      std: finiteNumber(row.std),
      min: finiteNumber(row.min),
      max: finiteNumber(row.max),
      raw_int_den: finiteNumber(row.rawIntDen),
      int_den: finiteNumber(row.intDen),
      int_den_mm2: finiteNumber(row.intDenMm2),
    },
    createdAt: rowCreatedAt(row.createdAt),
    importedObjectId: row.roiObjectId || '',
  };
}

function rowToMeasurementEntry(row, id) {
  const points = cleanPoints(row.points);
  if (row.kind !== 'line' || points.length < 2) return null;
  const lengthMm = finiteNumber(row.lengthMm);
  const lengthPx = finiteNumber(row.lengthPx);
  if (lengthMm == null && lengthPx == null) return null;
  const calibrated = lengthMm != null;
  return {
    id,
    x1: points[0][0],
    y1: points[0][1],
    x2: points[1][0],
    y2: points[1][1],
    mm: calibrated ? lengthMm : lengthPx,
    unit: calibrated ? 'mm' : 'px',
    spacingKnown: calibrated,
    label: textValue(row.label),
    microscopy: {
      channelIndex: finiteNumber(row.channelIndex) ?? 0,
      channelName: row.channel || '',
      timeIndex: finiteNumber(row.timeIndex) ?? 0,
    },
    importedObjectId: row.roiObjectId || '',
    createdAt: rowCreatedAt(row.createdAt),
  };
}

function rowToAngleEntry(row, id) {
  const points = cleanPoints(row.points);
  const angleDeg = finiteNumber(row.angleDeg);
  if (row.kind !== 'angle' || points.length !== 3 || angleDeg == null) return null;
  return {
    id,
    p1: { x: points[0][0], y: points[0][1] },
    vertex: { x: points[1][0], y: points[1][1] },
    p3: { x: points[2][0], y: points[2][1] },
    deg: angleDeg,
    label: textValue(row.label),
    microscopy: {
      channelIndex: finiteNumber(row.channelIndex) ?? 0,
      channelName: row.channel || '',
      timeIndex: finiteNumber(row.timeIndex) ?? 0,
    },
    importedObjectId: row.roiObjectId || '',
    createdAt: rowCreatedAt(row.createdAt),
  };
}

function normalizeMicroscopyScopeIndex(value, size = 0) {
  const n = finiteNumber(value);
  if (n == null) return null;
  const idx = Math.floor(n);
  if (!(size > 0)) return idx;
  if (idx >= 0 && idx < size) return idx;
  if (idx - 1 >= 0 && idx - 1 < size) return idx - 1;
  return idx;
}

function normalizeBundleSliceIndex(row = {}, series = {}) {
  const slices = Math.max(1, Math.floor(finiteNumber(series.slices) || 1));
  if (finiteNumber(row.sliceIndex) != null) {
    const idx = Math.floor(finiteNumber(row.sliceIndex));
    return idx >= 0 && idx < slices ? idx : null;
  }
  if (finiteNumber(row.slice) != null) {
    const idx = Math.floor(finiteNumber(row.slice)) - 1;
    return idx >= 0 && idx < slices ? idx : null;
  }
  return 0;
}

function channelIndexFromDisplay(value, series = {}, sizeC = 0) {
  const displayNumber = finiteNumber(value);
  if (displayNumber != null) {
    const idx = Math.floor(displayNumber) - 1;
    return !(sizeC > 0) || (idx >= 0 && idx < sizeC) ? idx : null;
  }
  const raw = textValue(value);
  const displayMatch = raw.match(/^C\s*(\d+)$/i);
  if (displayMatch) return channelIndexFromDisplay(displayMatch[1], series, sizeC);
  const clean = raw.toLowerCase();
  if (!clean) return null;
  const channels = series.microscopyDataset?.channels || [];
  const match = channels.find(channel => textValue(channel?.name).toLowerCase() === clean);
  return match ? finiteNumber(match.index) : null;
}

function normalizeBundleChannelIndex(row = {}, series = {}, sizeC = 0) {
  if (finiteNumber(row.channelIndex) != null) return normalizeMicroscopyScopeIndex(row.channelIndex, sizeC);
  return channelIndexFromDisplay(row.channel, series, sizeC);
}

function hasBundleChannelProvenance(row = {}) {
  return finiteNumber(row.channelIndex) != null || finiteNumber(row.channel) != null || !!textValue(row.channel);
}

function channelNameForIndex(series = {}, channelIndex = null) {
  if (channelIndex == null) return '';
  const channels = series.microscopyDataset?.channels || [];
  const match = channels.find(channel => finiteNumber(channel?.index) === channelIndex);
  return textValue(match?.name);
}

function normalizeBundleTimeIndex(row = {}, sizeT = 0) {
  if (finiteNumber(row.timeIndex) != null) return normalizeMicroscopyScopeIndex(row.timeIndex, sizeT);
  if (finiteNumber(row.time) != null) {
    const idx = Math.floor(finiteNumber(row.time)) - 1;
    return !(sizeT > 0) || (idx >= 0 && idx < sizeT) ? idx : null;
  }
  return null;
}

function rowPointGeometryFitsBundle(row = {}, series = {}) {
  if (!['polygon', 'polyline', 'ellipse', 'point', 'line', 'angle'].includes(row.kind)) return true;
  const points = cleanPoints(row.points);
  if (!points.length) return true;
  return pointsFitImageBounds(points, series);
}

function microscopyBundleRowIssue(row = {}, series = {}, scope = {}) {
  const { sliceIdx, channelIndex, timeIndex, sizeC = 0, sizeT = 0, calibrationTrusted = true } = scope;
  if (sliceIdx == null) return 'slice';
  if (sizeC > 0 && channelIndex != null && (channelIndex < 0 || channelIndex >= sizeC)) return 'channel';
  if (sizeC > 0 && channelIndex == null && hasBundleChannelProvenance(row)) return 'channel';
  if (sizeT > 0 && timeIndex != null && (timeIndex < 0 || timeIndex >= sizeT)) return 'time';
  if (sizeT > 0 && timeIndex == null && finiteNumber(row.time) != null) return 'time';
  if (!rowPointGeometryFitsBundle(row, series)) return 'points';
  if (!calibrationTrusted && row.kind === 'line' && finiteNumber(row.lengthMm) != null && finiteNumber(row.lengthPx) == null) return 'calibration';
  return '';
}

export function roiResultsBundleIncompatibleRowCount(bundle, series = state.manifest?.series?.[state.seriesIdx]) {
  if (series?.imageDomain !== 'microscopy') return 0;
  const rows = Array.isArray(bundle?.rows) ? bundle.rows : [];
  const sizeC = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 'c')?.size) || finiteNumber(series.microscopy?.sizeC) || 0;
  const sizeT = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 't')?.size) || finiteNumber(series.microscopy?.sizeT) || 0;
  const calibrationTrusted = bundle?.calibration?.xyKnown === true;
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const sliceIdx = normalizeBundleSliceIndex(row, series);
    const channelIndex = normalizeBundleChannelIndex(row, series, sizeC);
    const timeIndex = normalizeBundleTimeIndex(row, sizeT);
    if (microscopyBundleRowIssue(row, series, { sliceIdx, channelIndex, timeIndex, sizeC, sizeT, calibrationTrusted })) count += 1;
  }
  return count;
}

export function importRoiResultsBundle(bundle, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const compatibility = validateRoiResultsBundleForSeries(bundle, series, host?.manifest);
  if (!compatibility.ok) return { ok: false, count: 0, reason: compatibility.reason };
  let count = 0;
  let rejectedIncompatible = 0;
  const rowsBySlice = new Map();
  const measurementRowsBySlice = new Map();
  const angleRowsBySlice = new Map();
  const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
  const sizeC = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 'c')?.size) || finiteNumber(series.microscopy?.sizeC) || 0;
  const sizeT = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 't')?.size) || finiteNumber(series.microscopy?.sizeT) || 0;
  const calibrationTrusted = series.imageDomain !== 'microscopy' || bundle?.calibration?.xyKnown === true;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const sliceIdx = normalizeBundleSliceIndex(row, series);
    const channelIndex = normalizeBundleChannelIndex(row, series, sizeC);
    const timeIndex = normalizeBundleTimeIndex(row, sizeT);
    if (series.imageDomain === 'microscopy') {
      if (microscopyBundleRowIssue(row, series, { sliceIdx, channelIndex, timeIndex, sizeC, sizeT, calibrationTrusted })) {
        rejectedIncompatible += 1;
        continue;
      }
    }
    const normalizedRow = {
      ...row,
      ...(!calibrationTrusted ? {
        areaMm2: null,
        perimeterMm: null,
        intDen: null,
        intDenMm2: null,
        lengthMm: null,
      } : {}),
      channel: textValue(row.channel) || channelNameForIndex(series, channelIndex),
      channelIndex,
      timeIndex,
    };
    if (row.kind === 'line') {
      const existing = measurementRowsBySlice.get(sliceIdx) || measurementEntriesForSlice(host, series, sliceIdx).slice();
      if (row.roiObjectId && existing.some((item) => (
        item.importedObjectId === row.roiObjectId || `measure:${series.slug}|${sliceIdx}:${item.id}` === row.roiObjectId
      ))) continue;
      const entry = rowToMeasurementEntry(normalizedRow, nextDrawingEntryId(existing));
      if (!entry) continue;
      existing.push(entry);
      measurementRowsBySlice.set(sliceIdx, existing);
      count += 1;
      continue;
    }
    if (row.kind === 'angle') {
      const existing = angleRowsBySlice.get(sliceIdx) || angleEntriesForSlice(host, series, sliceIdx).slice();
      if (row.roiObjectId && existing.some((item) => (
        item.importedObjectId === row.roiObjectId || `angle:${series.slug}|${sliceIdx}:${item.id}` === row.roiObjectId
      ))) continue;
      const entry = rowToAngleEntry(normalizedRow, nextDrawingEntryId(existing));
      if (!entry) continue;
      existing.push(entry);
      angleRowsBySlice.set(sliceIdx, existing);
      count += 1;
      continue;
    }
    const existing = rowsBySlice.get(sliceIdx) || roiEntriesForSlice(host, series, sliceIdx).slice();
    if (row.roiObjectId && existing.some((item) => (
      item.importedObjectId === row.roiObjectId || `roi:${series.slug}|${sliceIdx}:${item.id}` === row.roiObjectId
    ))) continue;
    const entry = rowToRoiEntry(normalizedRow, nextDrawingEntryId(existing));
    if (!entry) continue;
    existing.push(entry);
    rowsBySlice.set(sliceIdx, existing);
    count += 1;
  }
  for (const [sliceIdx, list] of angleRowsBySlice) setAngleEntriesForSlice(host, series, sliceIdx, list);
  for (const [sliceIdx, list] of measurementRowsBySlice) setMeasurementEntriesForSlice(host, series, sliceIdx, list);
  for (const [sliceIdx, list] of rowsBySlice) setRoiEntriesForSlice(host, series, sliceIdx, list);
  if (count > 0) return { ok: true, count, reason: rejectedIncompatible > 0 ? 'partial_incompatible_rows' : '' };
  return { ok: false, count: 0, reason: rejectedIncompatible > 0 ? 'incompatible_bundle_rows' : 'no_importable_rois' };
}

export function roiResultsImportStatusText(result = {}) {
  const count = Math.max(0, Math.floor(finiteNumber(result.count) || 0));
  const imported = `Imported ${count} result row${count === 1 ? '' : 's'}`;
  return result.reason === 'partial_incompatible_rows' ? `${imported}; skipped incompatible rows` : imported;
}

export function roiResultsImportFailureText(reason = '') {
  if (reason === 'no_importable_rois') return 'ROI bundle had no importable geometry';
  if (reason === 'incompatible_bundle_rows') return 'ROI bundle rows are incompatible with this microscopy stack';
  if (reason === 'bundle_axis_mismatch') return 'ROI bundle C/Z/T dimensions do not match this microscopy stack';
  if (reason === 'bundle_calibration_mismatch') return 'ROI bundle calibration does not match this microscopy stack';
  if (reason === 'legacy_identity_unconfirmed') return 'Legacy ROI bundles are quarantined because they lack a series identity';
  if (reason === 'series_identity_mismatch') return 'ROI bundle belongs to a different study or series';
  return 'ROI bundle did not match this series';
}

export function rowMatchesCurrentScope(row, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (row.sliceIdx !== host?.sliceIdx) return false;
  if (series?.imageDomain !== 'microscopy') return true;
  if (row.channelZeroIndex == null && row.timeZeroIndex == null) return true;
  return Number(series.microscopy?.channelIndex || 0) === Number(row.channelZeroIndex || 0)
    && Number(series.microscopy?.timeIndex || 0) === Number(row.timeZeroIndex || 0);
}

export async function activateRoiResultRow(row, host = state, { isActive = () => true } = {}) {
  if (!row || !isActive()) return false;
  const setSlice = () => {
    if (!isActive()) return false;
    const maxSlice = Math.max(0, Number(host?.imgs?.length || 0) - 1);
    host.sliceIdx = Math.min(maxSlice, Math.max(0, Math.floor(Number(row.sliceIdx) || 0)));
    return true;
  };
  if (row.channelZeroIndex != null || row.timeZeroIndex != null) {
    const series = host?.manifest?.series?.[host.seriesIdx];
    if (series?.imageDomain === 'microscopy') {
      const { activateMicroscopyStackPosition } = await import('../microscopy/microscopy-hyperstack-controls.js');
      if (!isActive()) return false;
      activateMicroscopyStackPosition(row.channelZeroIndex || 0, row.timeZeroIndex || 0, host);
      return setSlice();
    }
  }
  return setSlice();
}
