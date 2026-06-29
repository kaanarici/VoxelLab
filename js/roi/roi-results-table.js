// ROI results panel UI: renders the result-row list and wires the export /
// import controls. Data shaping lives in roi-results-model.js and
// serialization in roi-results-export.js; this module is the only DOM surface.

import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { formatNumber } from './roi-results-metrics.js';
import {
  activateRoiResultRow,
  importRoiResultsBundle,
  roiResultsImportFailureText,
  roiResultRows,
  roiResultsImportStatusText,
  rowMatchesCurrentScope,
  setRoiResultLabel,
} from './roi-results-model.js';
import {
  exportImageJRoiZip,
  exportRoiResultsCsv,
  exportRoiResultsJson,
  imageJRoiRows,
} from './roi-results-export.js';
import {
  exportMicroscopyEvidencePackage,
  microscopyEvidencePackageFailureText,
} from './microscopy-evidence-package.js';

let exportWired = false;
let afterResultsMutation = () => {};

function metricNode(label, value) {
  const wrap = document.createElement('div');
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('b');
  valueEl.textContent = value;
  wrap.append(labelEl, valueEl);
  return wrap;
}

function rowSourceProvenanceText(row = {}) {
  const format = String(row.sourceFormat || '').trim();
  const files = (Array.isArray(row.sourceFiles) ? row.sourceFiles : [])
    .map(item => String(item || '').split(/[\\/]/).filter(Boolean).pop())
    .filter(Boolean);
  const fileText = files.length === 1
    ? files[0]
    : files.length > 1
    ? `${files.length} files`
    : '';
  return [format, fileText].filter(Boolean).join(' · ');
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
  const fallbackName = row.kind === 'angle' ? `Angle ${row.index}` : (row.kind === 'line' ? `Line ${row.index}` : `ROI ${row.index}`);
  name.textContent = row.label || fallbackName;
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
      name.textContent = row.label || fallbackName;
      name.blur();
    }
  });
  name.addEventListener('blur', () => {
    if (!setRoiResultLabel(row, name.textContent, host)) {
      name.textContent = row.label || fallbackName;
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
    metricNode('Angle', row.angleDeg == null ? '—' : `${formatNumber(row.angleDeg)}°`),
    metricNode('Area', row.areaDisplay),
    metricNode('Center', row.xUnitValue == null || row.yUnitValue == null ? '—' : `${formatNumber(row.xUnitValue)}, ${formatNumber(row.yUnitValue)} ${row.lengthUnit}`),
    metricNode('Perimeter', row.perimeterDisplay),
    metricNode('Circularity', formatNumber(row.circularity, 3)),
    metricNode('Length', row.lengthDisplay || '—'),
    metricNode('Count', row.count == null ? '—' : String(row.count)),
    metricNode('Pixels', row.pixels == null ? '—' : String(row.pixels)),
    metricNode('Mean', formatNumber(row.mean)),
    metricNode('Std', formatNumber(row.std)),
    metricNode('Min', formatNumber(row.min)),
    metricNode('Max', formatNumber(row.max)),
    metricNode('IntDen', formatNumber(row.intDen)),
    metricNode('RawIntDen', formatNumber(row.rawIntDen)),
  );

  const foot = document.createElement('div');
  foot.className = 'roi-result-foot';
  let footText = '';
  if (row.valueSource === 'linear_measurement') {
    footText = row.lengthMm == null ? 'Uncalibrated pixel length' : 'Calibrated length';
  } else if (row.valueSource === 'angular_measurement') {
    footText = 'Calibrated angle';
  } else if (row.valueSource === 'physical_adc') {
    footText = row.valueUnit;
  } else if (row.valueSource === 'raw_16bit') {
    footText = 'Raw intensity (16-bit measurement)';
  } else if (row.valueSource === 'hounsfield') {
    footText = 'Hounsfield units (CT, ±band-limited)';
  } else {
    footText = 'Display-domain 8-bit intensity';
  }
  const provenance = rowSourceProvenanceText(row);
  foot.textContent = provenance ? `${footText} · ${provenance}` : footText;

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
  const imagejExportButton = $('roi-results-imagej-export');
  const evidenceExportButton = $('roi-results-evidence-export');
  const jsonImportButton = $('roi-results-json-import');
  const analysisOps = host?._microscopyAnalysisLog?.[series?.slug] || [];
  if (count) count.textContent = String(rows.length);
  if (exportButton) exportButton.disabled = rows.length === 0;
  if (jsonExportButton) jsonExportButton.disabled = rows.length === 0;
  if (imagejExportButton) imagejExportButton.disabled = imageJRoiRows(rows).length === 0;
  if (evidenceExportButton) evidenceExportButton.disabled = series?.imageDomain !== 'microscopy' || rows.length === 0 || !analysisOps.length;
  if (jsonImportButton) jsonImportButton.disabled = !series?.slug;
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'rp-empty rp-empty--compact rp-empty--left';
    const title = document.createElement('div');
    title.className = 'rp-empty-title';
    title.textContent = 'No ROI results';
    const hint = document.createElement('div');
    hint.className = 'rp-empty-hint';
    hint.textContent = 'Draw a ROI, line, or angle measurement to collect calibrated result rows.';
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

export function initRoiResultsPanel(host = state, { onImport = () => {}, onChange = null } = {}) {
  if (exportWired) return;
  exportWired = true;
  afterResultsMutation = onChange || onImport;
  $('roi-results-export')?.addEventListener('click', () => {
    if (!exportRoiResultsCsv(host)) {
      setImportStatus('Draw ROI rows before exporting');
    } else {
      setImportStatus('');
    }
  });
  $('roi-results-json-export')?.addEventListener('click', () => {
    if (!exportRoiResultsJson(host)) {
      setImportStatus('Draw ROI rows before exporting');
    } else {
      setImportStatus('');
    }
  });
  $('roi-results-imagej-export')?.addEventListener('click', async () => {
    try {
      if (!await exportImageJRoiZip(host)) setImportStatus('Draw supported ROI rows or angle measurements before exporting ImageJ ROI ZIP');
      else setImportStatus('');
    } catch (error) {
      setImportStatus(`ImageJ ROI ZIP export failed: ${error?.message || error}`);
    }
  });
  $('roi-results-evidence-export')?.addEventListener('click', async () => {
    try {
      const result = await exportMicroscopyEvidencePackage(host);
      if (!result.ok) setImportStatus(microscopyEvidencePackageFailureText(result.reason));
      else setImportStatus('');
    } catch (error) {
      setImportStatus(`Microscopy evidence package export failed: ${error?.message || error}`);
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
      setImportStatus(roiResultsImportStatusText(result));
      onImport();
      renderRoiResults(host);
    } catch (error) {
      setImportStatus(roiResultsImportFailureText(error?.message));
    }
  });
  renderRoiResults(host);
}
