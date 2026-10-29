import { $, closeModal } from './dom.js';
import { state } from './core/state.js';
import { inPlanePixelSpacing } from './core/geometry.js';
import { setInvertDisplay, setSliceIndex, setWindowLevel } from './core/state/viewer-commands.js';
import { setColormap } from './colormap.js';
import { setCTWindow } from './view-modes.js';
import { zoomToFit } from './shell/viewport.js';
import { appendMeasurement, drawMeasurements } from './roi/measure.js';
import { appendAngleMeasurement, computeAngle, currentMicroscopyScope } from './roi/angle.js';
import { addROI } from './roi.js';
import { getAnnotationsHere, renderAnnotationList, setAnnotationsHere } from './overlay/annotation.js';
import { clearDrawingEntriesForSlice, drawingEntriesForSeries, nextDrawingEntryId } from './overlay/annotation-graph.js';
import { renderRoiResults, roiResultRows, roiResultsCsv } from './roi/roi-results.js';
import { getRawSliceData } from './raw-slice-data.js';
import { resolveVoxelInspection } from './inspection-readout.js';

const FILE_INPUT_ID = 'voxellab-agent-files';
const FOLDER_INPUT_ID = 'voxellab-agent-folder';
let pendingFiles = [];

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function settle() {
  await frame();
  await frame();
  const running = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
  await Promise.race([Promise.allSettled(running.map((a) => a.finished)), new Promise((r) => setTimeout(r, 1000))]);
  await frame();
}

function activeSeries() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) throw new Error('no study is open; call open first');
  return series;
}

function seriesSummary(series, index) {
  const spacing = inPlanePixelSpacing(series);
  return {
    index,
    slug: series.slug,
    name: series.name,
    description: series.description || '',
    modality: series.modality || '',
    imageDomain: series.imageDomain || 'medical',
    slices: series.slices,
    width: series.width,
    height: series.height,
    pixelSpacingMm: spacing.known ? { row: spacing.rowMm, col: spacing.colMm } : null,
    sliceThicknessMm: Number(series.sliceThickness) || null,
    calibrated: spacing.known,
  };
}

function status() {
  const series = state.manifest?.series || [];
  const active = series[state.seriesIdx];
  return {
    series: series.map(seriesSummary),
    active: active ? {
      index: state.seriesIdx,
      slug: active.slug,
      slice: state.sliceIdx,
      slices: active.slices,
      mode: state.mode,
      window: state.window,
      level: state.level,
      colormap: state.colormap,
      invert: !!state.invertDisplay,
      zoom: state.zoom,
      findings: roiResultRows(state, active).length,
    } : null,
    note: 'Coordinates are image pixels of the active slice, origin top-left. window/level are display units (window 1-512, level 0-255); use preset for CT windows. Research use only.',
  };
}

function refreshDrawings() {
  drawMeasurements();
  renderAnnotationList();
  renderRoiResults();
  window.dispatchEvent(new Event('voxellab:relayout'));
}

function point(value, name) {
  if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) throw new Error(`${name} must be [x, y]`);
  const series = activeSeries();
  const [x, y] = value;
  if (x < 0 || y < 0 || x > series.width || y > series.height) throw new Error(`${name} [${x}, ${y}] is outside the ${series.width}x${series.height} image`);
  return [x, y];
}

async function goToSlice(slice) {
  if (slice == null) return;
  const series = activeSeries();
  if (!Number.isInteger(slice) || slice < 0 || slice >= series.slices) throw new Error(`slice must be an integer 0..${series.slices - 1}`);
  setSliceIndex(slice, series);
  const scrub = $('scrub');
  if (scrub) {
    scrub.value = String(slice);
    scrub.dispatchEvent(new Event('input'));
  }
  await settle();
  await settle();
}

async function setMode(mode) {
  const current = state.mode;
  const want = mode === '2d' ? '2d' : mode;
  if (want === 'mpr' && current !== 'mpr') $('btn-mpr')?.click();
  else if (want === '3d' && !['3d', 'mpr3d'].includes(current)) $('btn-3d')?.click();
  else if (want === '2d') {
    if (current === 'mpr') $('btn-mpr')?.click();
    else if (current === '3d' || current === 'mpr3d') $('btn-3d')?.click();
    else if (current === 'cmp') $('btn-compare')?.click();
  }
  for (let i = 0; i < 40 && state.mode !== want && !(want === '3d' && state.mode === 'mpr3d'); i++) await new Promise((r) => setTimeout(r, 50));
}

function ensureInputs() {
  for (const [id, folder] of [[FILE_INPUT_ID, false], [FOLDER_INPUT_ID, true]]) {
    if ($(id)) continue;
    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    input.multiple = true;
    input.hidden = true;
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => { pendingFiles.push(...input.files); });
    document.body.append(input);
  }
  pendingFiles = [];
  return { files: `#${FILE_INPUT_ID}`, folder: `#${FOLDER_INPUT_ID}` };
}

async function openPending(selectSeries) {
  const files = pendingFiles;
  pendingFiles = [];
  if (!files.length) throw new Error('no files were selected');
  const before = state.manifest.series.length;
  const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
  const { handleLocalImport } = await import('./intake/run-local-import.js');
  await showStudyUploadModal(selectSeries);
  await handleLocalImport(files, $('upload-status'), $('upload-modal'), selectSeries);
  const message = $('upload-status')?.textContent?.trim() || '';
  if ($('upload-modal')?.classList.contains('visible')) closeModal('upload-modal');
  await settle();
  const added = state.manifest.series.length - before;
  if (added <= 0) throw new Error(message || 'nothing could be opened from those files');
  const list = state.manifest.series;
  return { opened: list.slice(before).map((series, i) => seriesSummary(series, before + i)), active: status().active };
}

async function measure({ from, to, slice }) {
  await goToSlice(slice);
  const series = activeSeries();
  const [x1, y1] = point(from, 'from');
  const [x2, y2] = point(to, 'to');
  const spacing = inPlanePixelSpacing(series);
  const lengthPx = Math.hypot(x2 - x1, y2 - y1);
  const distance = Math.hypot((x2 - x1) * spacing.colMm, (y2 - y1) * spacing.rowMm);
  appendMeasurement(`${series.slug}|${state.sliceIdx}`, {
    x1, y1, x2, y2,
    mm: distance,
    unit: spacing.known ? 'mm' : 'px',
    spacingKnown: spacing.known,
    microscopy: currentMicroscopyScope(),
  });
  refreshDrawings();
  return { slice: state.sliceIdx, lengthPx, lengthMm: spacing.known ? distance : null, calibrated: spacing.known };
}

async function angle({ points, slice }) {
  await goToSlice(slice);
  const series = activeSeries();
  if (!Array.isArray(points) || points.length !== 3) throw new Error('points must be three [x, y] pairs: arm, vertex, arm');
  const [p1, vertex, p3] = points.map((p, i) => point(p, `points[${i}]`)).map(([x, y]) => ({ x, y }));
  const deg = computeAngle(p1, vertex, p3, series);
  appendAngleMeasurement(`${series.slug}|${state.sliceIdx}`, { p1, vertex, p3, deg, microscopy: currentMicroscopyScope() });
  refreshDrawings();
  return { slice: state.sliceIdx, degrees: deg };
}

async function roi({ "shape": roiKind, center, radii, points, slice }) {
  await goToSlice(slice);
  activeSeries();
  let pts;
  if (roiKind === 'ellipse') {
    const [cx, cy] = point(center, 'center');
    const [rx, ry = rx] = Array.isArray(radii) ? radii : [radii];
    if (!(rx > 0) || !(ry > 0)) throw new Error('radii must be positive [rx, ry]');
    pts = [[cx - rx, cy - ry], [cx + rx, cy + ry]];
  } else if (roiKind === 'polygon') {
    if (!Array.isArray(points) || points.length < 3) throw new Error('polygon needs at least three points');
    pts = points.map((p, i) => point(p, `points[${i}]`));
  } else {
    throw new Error('shape must be ellipse or polygon');
  }
  const entry = await addROI(roiKind, pts);
  if (!entry) throw new Error('ROI statistics are unavailable for this slice');
  refreshDrawings();
  return { slice: state.sliceIdx, id: entry.id, "shape": roiKind, stats: { ...entry.stats, valueUnit: entry.stats.valueUnit || 'display value (0-255)' } };
}

async function annotate({ x, y, text, slice }) {
  await goToSlice(slice);
  activeSeries();
  const [px, py] = point([x, y], 'point');
  if (!String(text || '').trim()) throw new Error('text is required');
  const list = getAnnotationsHere();
  const entry = { id: nextDrawingEntryId(list), x: Math.round(px), y: Math.round(py), text: String(text).trim(), createdAt: Date.now() };
  setAnnotationsHere([...list, entry]);
  refreshDrawings();
  return { slice: state.sliceIdx, ...entry };
}

async function pixel({ x, y, slice }) {
  await goToSlice(slice);
  const series = activeSeries();
  const [px, py] = point([x, y], 'point').map(Math.floor);
  const raw = getRawSliceData(state.sliceIdx, series);
  const intensity = raw ? raw[(py * series.width + px) * 4] : null;
  const info = resolveVoxelInspection(series, px, py, state.sliceIdx, { intensity });
  return {
    x: px, y: py, slice: state.sliceIdx,
    displayValue: intensity,
    displayValueUnit: 'display value (0-255) after the series intensity mapping',
    ctHu: info?.ctHu ?? null,
    patientMm: info?.mm ? { x: info.mm[0], y: info.mm[1], z: info.mm[2] } : null,
    lps: info?.lpsText || null,
    region: info?.regionName || null,
    tissue: info?.tissueName || null,
  };
}

async function setView({ slice, window: win, level, preset, invert, colormap, zoom_fit: zoomFit, mode }) {
  activeSeries();
  if (mode) await setMode(mode);
  await goToSlice(slice);
  if (preset) setCTWindow(String(preset).toLowerCase());
  if (win != null || level != null) setWindowLevel(win ?? state.window, level ?? state.level);
  if (invert != null) setInvertDisplay(!!invert);
  if (colormap) setColormap(String(colormap).toLowerCase());
  if (zoomFit) zoomToFit();
  await settle();
  return status();
}

async function selectSeriesBy({ series }, selectSeries) {
  const list = state.manifest?.series || [];
  const index = typeof series === 'number' ? series : list.findIndex((s) => s.slug === series || s.name === series);
  if (!(index >= 0 && index < list.length)) throw new Error(`no series ${JSON.stringify(series)}; see status().series`);
  await selectSeries(index);
  await settle();
  return status();
}

function findings() {
  const series = activeSeries();
  const notes = drawingEntriesForSeries(state, series)
    .filter((entry) => entry.kind === 'note')
    .map(({ sliceIdx, data }) => ({ slice: sliceIdx, x: data.x, y: data.y, text: data.text }));
  return { rows: roiResultRows(state, series), notes };
}

function clear({ all = false } = {}) {
  const series = activeSeries();
  const slices = all ? Array.from({ length: series.slices }, (_, i) => i) : [state.sliceIdx];
  for (const z of slices) clearDrawingEntriesForSlice(state, series, z);
  refreshDrawings();
  return { cleared: all ? 'all slices' : `slice ${state.sliceIdx}` };
}

function exportCsv() {
  const series = activeSeries();
  const rows = roiResultRows(state, series);
  return { rows: rows.length, csv: roiResultsCsv(rows, series) };
}

export async function callAgent(method, params = {}, { selectSeries }) {
  switch (method) {
    case 'status': return status();
    case 'settle': await settle(); return true;
    case 'prepare_import': return ensureInputs();
    case 'open': return openPending(selectSeries);
    case 'select_series': return selectSeriesBy(params, selectSeries);
    case 'set_view': return setView(params);
    case 'pixel': return pixel(params);
    case 'measure': return measure(params);
    case 'angle': return angle(params);
    case 'roi': return roi(params);
    case 'annotate': return annotate(params);
    case 'list_findings': return findings();
    case 'clear': return clear(params);
    case 'export_roi_csv': return exportCsv();
    default: throw new Error(`unknown method ${method}`);
  }
}
