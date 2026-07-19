// ROI results serialization + file download: CSV/JSON sidecar and ImageJ ROI
// ZIP. Pulls calibrated rows and the bundle shape from roi-results-model.js;
// the panel UI (roi-results-table.js) only triggers these exporters.

import { preferredLengthUnit } from '../core/physical-units.js';
import { state } from '../core/state.js';
import { microscopySourceWarningLabels } from '../microscopy/microscopy-provenance-text.js';
import {
  calibrationForBundle,
  roiResultRows,
  roiResultsBundle,
  sourceForBundle,
} from './roi-results-model.js';
import { intDenForRow, intDenMm2ForRow, rawIntDenForRow } from './roi-results-metrics.js';

function csvUnitToken(unit) {
  return String(unit || 'mm').replace('µ', 'u').replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'unit';
}

function csvAreaHeader(unit) {
  const token = csvUnitToken(unit);
  return token === 'mm' ? 'area_display_mm2' : `area_${token}2`;
}

function csvLengthHeader(unit) {
  const token = csvUnitToken(unit);
  return token === 'mm' ? 'length_display_mm' : `length_${token}`;
}

function csvPerimeterHeader(unit) {
  const token = csvUnitToken(unit);
  return token === 'mm' ? 'perimeter_display_mm' : `perimeter_${token}`;
}

function csvCoordinateHeader(axis, unit) {
  const token = csvUnitToken(unit);
  return token === 'mm' ? `${axis}_display_mm` : `${axis}_${token}`;
}
function csvCell(value) {
  if (value == null || value === '—') return '';
  const raw = String(value);
  const firstMeaningful = raw.trimStart().charAt(0);
  const text = typeof value === 'string' && firstMeaningful && '=+-@'.includes(firstMeaningful) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvSourceWarnings(series = {}, source = {}) {
  const labels = microscopySourceWarningLabels(series);
  return (labels.length ? labels : source.warnings || []).join(';');
}

export function roiResultsCsv(rows, series = state.manifest?.series?.[state.seriesIdx]) {
  const unit = preferredLengthUnit(series || {});
  const areaHeader = csvAreaHeader(unit);
  const lengthHeader = csvLengthHeader(unit);
  const perimeterHeader = csvPerimeterHeader(unit);
  const source = sourceForBundle(series || {});
  const calibration = calibrationForBundle(series || {});
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
    'angle_deg',
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
    'source_format',
    'source_files',
    'source_warnings',
    'xy_spacing_row_mm',
    'xy_spacing_col_mm',
    'z_spacing_mm',
    'calibration_unit',
    'calibration_source',
    'spacing_trust',
    'raw_int_den',
    perimeterHeader,
    'perimeter_mm',
    'perimeter_px',
    'circularity',
    csvCoordinateHeader('x', unit), csvCoordinateHeader('y', unit), 'x_mm', 'y_mm',
    'int_den',
    'int_den_mm2',
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
      row.angleDeg,
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
      source.format,
      source.sourceFiles.join(';'),
      csvSourceWarnings(series || {}, source),
      calibration.xyKnown ? calibration.rowMm : '',
      calibration.xyKnown ? calibration.colMm : '',
      calibration.zKnown ? calibration.zMm : '',
      calibration.displayUnit,
      calibration.source,
      calibration.trust,
      rawIntDenForRow(row),
      row.perimeterUnitValue,
      row.perimeterMm,
      row.perimeterPx,
      row.circularity,
      row.xUnitValue, row.yUnitValue, row.xMm, row.yMm,
      intDenForRow(row),
      intDenMm2ForRow(row),
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function imageJRoiRows(rows = []) {
  return rows.filter((row) => row.kind === 'ellipse' || row.kind === 'polygon' || row.kind === 'polyline' || row.kind === 'point' || row.kind === 'line' || row.kind === 'angle');
}

function imageJRoiExportRows(host = state, series = host?.manifest?.series?.[host.seriesIdx]) {
  return imageJRoiRows(roiResultRows(host, series));
}

export function exportRoiResultsCsv(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = roiResultRows(host, series);
  if (!rows.length) return false;
  const blob = new Blob([roiResultsCsv(rows, series)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `voxellab-roi-results-${series.slug || 'series'}.csv`);
  return true;
}

export function exportRoiResultsJson(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = roiResultRows(host, series);
  if (!rows.length) return false;
  const body = `${JSON.stringify(roiResultsBundle(rows, series), null, 2)}\n`;
  const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `voxellab-roi-results-${series.slug || 'series'}.json`);
  return true;
}

export async function exportImageJRoiZip(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const rows = imageJRoiExportRows(host, series);
  if (!rows.length) return false;
  const { imageJRoiZip } = await import('../microscopy/imagej-roi.js');
  const zip = imageJRoiZip(rows);
  if (!zip) return false;
  const blob = new Blob([zip], { type: 'application/zip' });
  downloadBlob(blob, `voxellab-imagej-rois-${series?.slug || 'series'}.zip`);
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
