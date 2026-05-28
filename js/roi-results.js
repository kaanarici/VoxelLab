import {
  drawingEntriesForSeries,
  measurementEntriesForSlice,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} from './annotation-graph.js';
import { $ } from './dom.js';
import { activateMicroscopyStackPosition } from './microscopy-hyperstack-controls.js';
import { formatAreaFromMm2, formatLengthFromMm, lengthUnitToMm, preferredLengthUnit } from './physical-units.js';
import { state } from './state.js';

let exportWired = false;
let afterResultsMutation = () => {};
const ROI_RESULTS_BUNDLE_SCHEMA = 'voxellab.roiResults.v1';

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value, digits = 2) {
  const n = finiteNumber(value);
  if (n == null) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(digits);
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resultLabel(entry = {}, index = 0) {
  const data = entry.data || {};
  const explicit = textValue(data.label) || textValue(data.text);
  if (explicit) return explicit;
  const id = Number.isFinite(Number(data.id)) ? Number(data.id) : index + 1;
  return entry.kind === 'line' ? `Line ${id}` : `ROI ${id}`;
}

function areaValueInUnit2(areaMm2, unit) {
  const n = finiteNumber(areaMm2);
  if (n == null) return null;
  const scale = 1 / lengthUnitToMm(unit);
  return n * scale * scale;
}

function lengthValueInUnit(lengthMm, unit) {
  const n = finiteNumber(lengthMm);
  if (n == null) return null;
  return n / lengthUnitToMm(unit);
}

function csvAreaHeader(unit) {
  const token = String(unit || 'mm').replace('µ', 'u').replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'unit';
  return token === 'mm' ? 'area_display_mm2' : `area_${token}2`;
}

function csvLengthHeader(unit) {
  const token = String(unit || 'mm').replace('µ', 'u').replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'unit';
  return token === 'mm' ? 'length_display_mm' : `length_${token}`;
}

function csvCell(value) {
  if (value == null || value === '—') return '';
  const raw = String(value);
  const firstMeaningful = raw.trimStart().charAt(0);
  const text = typeof value === 'string' && firstMeaningful && '=+-@'.includes(firstMeaningful) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
  return {
    mean: finiteNumber(stats.mean),
    std: finiteNumber(stats.std),
    min: finiteNumber(stats.min),
    max: finiteNumber(stats.max),
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
  };
}

function cleanPoints(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => Array.isArray(point) ? point.map(finiteNumber) : [])
    .filter((point) => point.length >= 2 && point.every((value) => value != null))
    .map(([x, y]) => [x, y]);
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
  return cleanPoints(data.pts);
}

function valuesForEntry(entry, stats) {
  if (entry.kind === 'line') {
    return {
      mean: null,
      std: null,
      min: null,
      max: null,
      valueUnit: '',
      valueSource: 'linear_measurement',
    };
  }
  return roiStatsForExport(stats);
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
  if (row.kind === 'line') {
    const list = measurementEntriesForSlice(host, series.slug, sliceIdx);
    const item = list.find(entry => Number(entry?.id) === id);
    if (!item) return false;
    item.label = clean;
    setMeasurementEntriesForSlice(host, series.slug, sliceIdx, list);
    return true;
  }
  const list = roiEntriesForSlice(series.slug, sliceIdx);
  const item = list.find(entry => Number(entry?.id) === id);
  if (!item) return false;
  item.label = clean;
  setRoiEntriesForSlice(series.slug, sliceIdx, list);
  return true;
}

export function roiResultRows(host = state, series = host?.manifest?.series?.[host.seriesIdx]) {
  if (!host?.manifest || !series?.slug) return [];
  const unit = preferredLengthUnit(series);
  return drawingEntriesForSeries(host, series.slug)
    .filter((entry) => entry.kind === 'ellipse' || entry.kind === 'polygon' || entry.kind === 'point' || entry.kind === 'line')
    .map((entry, index) => {
      const roi = entry.data || {};
      const stats = roi.stats || {};
      const points = drawingPoints(entry);
      const center = pointCenter(points);
      const values = valuesForEntry(entry, stats);
      const lengthMm = entry.kind === 'line' && roi.spacingKnown !== false && roi.unit !== 'px' ? finiteNumber(roi.mm) : null;
      const lengthPx = entry.kind === 'line' && (roi.spacingKnown === false || roi.unit === 'px') ? finiteNumber(roi.mm) : null;
      const areaMm2 = finiteNumber(stats.area_mm2);
      const areaUnit2 = areaValueInUnit2(areaMm2, unit);
      const microscopy = roi.microscopy || series.microscopy || {};
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
        count: finiteNumber(stats.count),
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
        mean: values.mean,
        std: values.std,
        min: values.min,
        max: values.max,
        valueUnit: values.valueUnit,
        valueSource: values.valueSource,
        createdAt: finiteNumber(roi.createdAt),
      };
    });
}

export function roiResultsCsv(rows, series = state.manifest?.series?.[state.seriesIdx]) {
  const unit = preferredLengthUnit(series || {});
  const areaHeader = csvAreaHeader(unit);
  const lengthHeader = csvLengthHeader(unit);
  const headers = [
    'roi',
    'roi_object_id',
    'series',
    'series_slug',
    'slice',
    'z_index0',
    'kind',
    'label',
    'x_px',
    'y_px',
    'count',
    lengthHeader,
    'length_mm',
    'length_px',
    'channel',
    'channel_index0',
    'time',
    'time_index0',
    areaHeader,
    'area_mm2',
    'pixels',
    'mean',
    'std',
    'min',
    'max',
    'value_unit',
    'value_source',
    'created_at',
  ];
  const lines = [headers.join(',')];
  for (const row of rows || []) {
    lines.push([
      row.index,
      row.objectId || row.id,
      row.seriesName,
      row.seriesSlug,
      row.slice,
      row.sliceIdx,
      row.kind,
      row.label,
      row.xPx,
      row.yPx,
      row.count,
      row.lengthUnitValue,
      row.lengthMm,
      row.lengthPx,
      row.channelName || row.channelIndex,
      row.channelZeroIndex,
      row.timeIndex,
      row.timeZeroIndex,
      row.areaUnit2,
      row.areaMm2,
      row.pixels,
      row.mean,
      row.std,
      row.min,
      row.max,
      row.valueUnit,
      row.valueSource,
      row.createdAt ? new Date(row.createdAt).toISOString() : '',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function calibrationForBundle(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing.map(finiteNumber) : [];
  const xyKnown = spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0 && series._spacingKnown !== false;
  const zMm = finiteNumber(series.sliceSpacing || series.sliceThickness);
  return {
    xyKnown,
    rowMm: xyKnown ? spacing[0] : null,
    colMm: xyKnown ? spacing[1] : null,
    zKnown: zMm != null && zMm > 0 && series._sliceSpacingKnown !== false,
    zMm: zMm != null && zMm > 0 && series._sliceSpacingKnown !== false ? zMm : null,
    displayUnit: preferredLengthUnit(series),
  };
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

function sourceForBundle(series = {}) {
  const microscopy = series.microscopy || {};
  const source = series.microscopyDataset?.source || {};
  return {
    imageDomain: series.imageDomain || '',
    format: source.originalFormat || series.sequence || '',
    sourceFiles: microscopy.sourceFiles || [],
    dataset: microscopyDatasetProvenance(series),
    warnings: [
      ...(source.warnings || []),
      ...(microscopy.sequenceWarnings || []),
    ].filter(Boolean),
  };
}

export function roiResultsBundle(rows, series = state.manifest?.series?.[state.seriesIdx]) {
  return {
    schema: ROI_RESULTS_BUNDLE_SCHEMA,
    exportedAt: new Date().toISOString(),
    series: {
      slug: series?.slug || '',
      name: series?.name || series?.slug || '',
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
      count: row.count,
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
      pixels: row.pixels,
      mean: row.mean,
      std: row.std,
      min: row.min,
      max: row.max,
      valueUnit: row.valueUnit,
      valueSource: row.valueSource,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
    })),
  };
}

function bundleMatchesActiveSeries(bundle, series = {}) {
  const expected = bundle?.series || {};
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

function rowToRoiEntry(row, id) {
  const points = cleanPoints(row.points);
  const shape = ['polygon', 'ellipse', 'point'].includes(row.kind) ? row.kind : '';
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
      mean: finiteNumber(row.mean),
      std: finiteNumber(row.std),
      min: finiteNumber(row.min),
      max: finiteNumber(row.max),
    },
    createdAt: Date.parse(row.createdAt) || Date.now(),
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
    createdAt: Date.parse(row.createdAt) || Date.now(),
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

export function importRoiResultsBundle(bundle, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const match = bundleMatchesActiveSeries(bundle, series);
  const calibrationMatch = match.ok ? bundleCalibrationMatchesActiveSeries(bundle, series) : { ok: true, reason: '' };
  if (!series?.slug || bundle?.schema !== ROI_RESULTS_BUNDLE_SCHEMA || !match.ok || !calibrationMatch.ok) {
    return { ok: false, count: 0, reason: match.reason || calibrationMatch.reason || 'series_mismatch' };
  }
  let count = 0;
  let rejectedIncompatible = 0;
  const rowsBySlice = new Map();
  const measurementRowsBySlice = new Map();
  const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
  const sizeC = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 'c')?.size) || finiteNumber(series.microscopy?.sizeC) || 0;
  const sizeT = finiteNumber(series.microscopyDataset?.axes?.find(axis => axis?.name === 't')?.size) || finiteNumber(series.microscopy?.sizeT) || 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const sliceIdx = normalizeBundleSliceIndex(row, series);
    const channelIndex = normalizeBundleChannelIndex(row, series, sizeC);
    const timeIndex = normalizeBundleTimeIndex(row, sizeT);
    if (series.imageDomain === 'microscopy') {
      if (sliceIdx == null) {
        rejectedIncompatible += 1;
        continue;
      }
      if (sizeC > 0 && channelIndex != null && (channelIndex < 0 || channelIndex >= sizeC)) {
        rejectedIncompatible += 1;
        continue;
      }
      if (sizeC > 0 && channelIndex == null && hasBundleChannelProvenance(row)) {
        rejectedIncompatible += 1;
        continue;
      }
      if (sizeT > 0 && timeIndex != null && (timeIndex < 0 || timeIndex >= sizeT)) {
        rejectedIncompatible += 1;
        continue;
      }
      if (sizeT > 0 && timeIndex == null && finiteNumber(row.time) != null) {
        rejectedIncompatible += 1;
        continue;
      }
    }
    const normalizedRow = {
      ...row,
      channel: textValue(row.channel) || channelNameForIndex(series, channelIndex),
      channelIndex,
      timeIndex,
    };
    if (row.kind === 'line') {
      const existing = measurementRowsBySlice.get(sliceIdx) || measurementEntriesForSlice(host, series.slug, sliceIdx).slice();
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
    const existing = rowsBySlice.get(sliceIdx) || roiEntriesForSlice(series.slug, sliceIdx).slice();
    if (row.roiObjectId && existing.some((item) => (
      item.importedObjectId === row.roiObjectId || `roi:${series.slug}|${sliceIdx}:${item.id}` === row.roiObjectId
    ))) continue;
    const entry = rowToRoiEntry(normalizedRow, nextDrawingEntryId(existing));
    if (!entry) continue;
    existing.push(entry);
    rowsBySlice.set(sliceIdx, existing);
    count += 1;
  }
  for (const [sliceIdx, list] of measurementRowsBySlice) setMeasurementEntriesForSlice(host, series.slug, sliceIdx, list);
  for (const [sliceIdx, list] of rowsBySlice) setRoiEntriesForSlice(series.slug, sliceIdx, list);
  if (count > 0) return { ok: true, count, reason: rejectedIncompatible > 0 ? 'partial_incompatible_rows' : '' };
  return { ok: false, count: 0, reason: rejectedIncompatible > 0 ? 'incompatible_bundle_rows' : 'no_importable_rois' };
}

function rowMatchesCurrentScope(row, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (row.sliceIdx !== host?.sliceIdx) return false;
  if (series?.imageDomain !== 'microscopy') return true;
  if (row.channelZeroIndex == null && row.timeZeroIndex == null) return true;
  return Number(series.microscopy?.channelIndex || 0) === Number(row.channelZeroIndex || 0)
    && Number(series.microscopy?.timeIndex || 0) === Number(row.timeZeroIndex || 0);
}

export function activateRoiResultRow(row, host = state) {
  if (!row) return false;
  if (row.channelZeroIndex != null || row.timeZeroIndex != null) {
    const series = host?.manifest?.series?.[host.seriesIdx];
    if (series?.imageDomain === 'microscopy') {
      activateMicroscopyStackPosition(row.channelZeroIndex || 0, row.timeZeroIndex || 0, host);
    }
  }
  const maxSlice = Math.max(0, Number(host?.imgs?.length || 0) - 1);
  host.sliceIdx = Math.min(maxSlice, Math.max(0, Math.floor(Number(row.sliceIdx) || 0)));
  return true;
}

function metricNode(label, value) {
  const wrap = document.createElement('div');
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('b');
  valueEl.textContent = value;
  wrap.append(labelEl, valueEl);
  return wrap;
}

function rowNode(row, host = state) {
  const context = [
    `Z ${row.slice}`,
    row.channelName ? `C${row.channelIndex} ${row.channelName}` : (row.channelIndex ? `C${row.channelIndex}` : ''),
    row.timeIndex ? `T${row.timeIndex}` : '',
  ].filter(Boolean).join(' · ');
  const rowEl = document.createElement('div');
  rowEl.className = `roi-result-row${rowMatchesCurrentScope(row, host) ? ' is-current' : ''}`;
  rowEl.dataset.roiResultRow = '';
  rowEl.dataset.roiObjectId = row.objectId || row.id || '';
  rowEl.dataset.slice = String(row.sliceIdx);
  rowEl.role = 'button';
  rowEl.tabIndex = 0;
  rowEl.setAttribute('aria-label', `Show ${row.label || `ROI ${row.index}`} at ${context || `Z ${row.slice}`}`);
  rowEl.addEventListener('click', () => activateRoiResultRow(row, host));
  rowEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activateRoiResultRow(row, host);
  });

  const top = document.createElement('div');
  top.className = 'roi-result-top';
  const name = document.createElement('span');
  name.className = 'roi-result-name';
  name.textContent = row.label || (row.kind === 'line' ? `Line ${row.index}` : `ROI ${row.index}`);
  name.contentEditable = 'plaintext-only';
  name.spellcheck = false;
  name.role = 'textbox';
  name.setAttribute('aria-label', `Result label for ${row.kind}`);
  name.addEventListener('click', event => event.stopPropagation());
  name.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      name.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      name.textContent = row.label || (row.kind === 'line' ? `Line ${row.index}` : `ROI ${row.index}`);
      name.blur();
    }
  });
  name.addEventListener('blur', () => {
    if (!setRoiResultLabel(row, name.textContent, host)) {
      name.textContent = row.label || (row.kind === 'line' ? `Line ${row.index}` : `ROI ${row.index}`);
      return;
    }
    afterResultsMutation();
    renderRoiResults(host);
  });
  const kind = document.createElement('span');
  kind.className = 'roi-result-kind';
  kind.textContent = row.kind;
  top.append(name, kind);

  const contextEl = document.createElement('div');
  contextEl.className = 'roi-result-context';
  contextEl.textContent = context;

  const metrics = document.createElement('div');
  metrics.className = 'roi-result-metrics';
  metrics.append(
    metricNode('Area', row.areaDisplay),
    metricNode('Length', row.lengthDisplay || '—'),
    metricNode('Count', row.count == null ? '—' : String(row.count)),
    metricNode('Pixels', row.pixels == null ? '—' : String(row.pixels)),
    metricNode('Mean', formatNumber(row.mean)),
    metricNode('Std', formatNumber(row.std)),
    metricNode('Min', formatNumber(row.min)),
    metricNode('Max', formatNumber(row.max)),
  );

  const foot = document.createElement('div');
  foot.className = 'roi-result-foot';
  foot.textContent = row.valueSource === 'linear_measurement'
    ? (row.lengthMm == null ? 'Uncalibrated pixel length' : 'Calibrated length')
    : (row.valueSource === 'physical_adc' ? row.valueUnit : 'Display-domain 8-bit intensity');

  rowEl.append(top, contextEl, metrics, foot);
  return rowEl;
}

export function renderRoiResults(host = state) {
  const root = $('roi-results');
  if (!root) return [];
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = roiResultRows(host, series);
  const count = $('roi-results-count');
  const exportButton = $('roi-results-export');
  const jsonExportButton = $('roi-results-json-export');
  const jsonImportButton = $('roi-results-json-import');
  if (count) count.textContent = String(rows.length);
  if (exportButton) exportButton.disabled = rows.length === 0;
  if (jsonExportButton) jsonExportButton.disabled = rows.length === 0;
  if (jsonImportButton) jsonImportButton.disabled = !series?.slug;
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'rp-empty rp-empty--compact rp-empty--left';
    const title = document.createElement('div');
    title.className = 'rp-empty-title';
    title.textContent = 'No ROI results';
    const hint = document.createElement('div');
    hint.className = 'rp-empty-hint';
    hint.textContent = 'Draw an ellipse or polygon ROI to collect calibrated area and intensity rows.';
    empty.append(title, hint);
    root.replaceChildren(empty);
    return rows;
  }
  const list = document.createElement('div');
  list.className = 'roi-results-list';
  list.replaceChildren(...rows.map((row) => rowNode(row, host)));
  root.replaceChildren(list);
  return rows;
}

function setImportStatus(text) {
  const status = $('roi-results-status');
  if (status) status.textContent = text || '';
}

export function exportRoiResultsCsv(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = roiResultRows(host, series);
  if (!rows.length) return false;
  const calibration = calibrationForBundle(series || {});
  const requiresCalibration = rows.some((row) => row.kind === 'ellipse' || row.kind === 'polygon');
  if (series?.imageDomain === 'microscopy' && requiresCalibration && !calibration.xyKnown) return false;
  const blob = new Blob([roiResultsCsv(rows, series)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `voxellab-roi-results-${series.slug || 'series'}.csv`);
  return true;
}

export function exportRoiResultsJson(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = roiResultRows(host, series);
  if (!rows.length) return false;
  const calibration = calibrationForBundle(series || {});
  const requiresCalibration = rows.some((row) => row.kind === 'ellipse' || row.kind === 'polygon');
  if (series?.imageDomain === 'microscopy' && requiresCalibration && !calibration.xyKnown) return false;
  const body = `${JSON.stringify(roiResultsBundle(rows, series), null, 2)}\n`;
  const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `voxellab-roi-results-${series.slug || 'series'}.json`);
  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function initRoiResultsPanel(host = state, { onImport = () => {}, onChange = null } = {}) {
  if (exportWired) return;
  exportWired = true;
  afterResultsMutation = onChange || onImport;
  $('roi-results-export')?.addEventListener('click', () => {
    if (!exportRoiResultsCsv(host)) {
      const rows = roiResultRows(host);
      if (!rows.length) setImportStatus('Draw ROI rows before exporting');
      else setImportStatus('Set XY calibration before exporting area ROI results');
    } else {
      setImportStatus('');
    }
  });
  $('roi-results-json-export')?.addEventListener('click', () => {
    if (!exportRoiResultsJson(host)) {
      const rows = roiResultRows(host);
      if (!rows.length) setImportStatus('Draw ROI rows before exporting');
      else setImportStatus('Set XY calibration before exporting area ROI results');
    } else {
      setImportStatus('');
    }
  });
  $('roi-results-json-import')?.addEventListener('click', () => {
    $('roi-results-json-import-input')?.click();
  });
  $('roi-results-json-import-input')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const result = importRoiResultsBundle(JSON.parse(await file.text()), host);
      if (!result.ok) throw new Error(result.reason || 'invalid_bundle');
      setImportStatus(`Imported ${result.count} result row${result.count === 1 ? '' : 's'}`);
      onImport();
      renderRoiResults(host);
    } catch (error) {
      setImportStatus(
        error?.message === 'no_importable_rois'
          ? 'ROI bundle had no importable geometry'
          : error?.message === 'incompatible_bundle_rows'
          ? 'ROI bundle rows are incompatible with this microscopy stack'
          : error?.message === 'bundle_axis_mismatch'
          ? 'ROI bundle C/Z/T dimensions do not match this microscopy stack'
          : error?.message === 'bundle_calibration_mismatch'
          ? 'ROI bundle calibration does not match this microscopy stack'
          : 'ROI bundle did not match this series',
      );
    }
  });
  renderRoiResults(host);
}
