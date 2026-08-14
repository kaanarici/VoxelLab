// DOM + button state when switching the active series (used by select-series.js).

import { $, escapeHtml } from '../dom.js';
import { notify } from '../notify.js';
import { state } from '../core/state.js';
import { acquisitionPlane } from '../core/view-orientation.js';
import { updateScrubFill } from '../cine.js';
import { updateSliceDisplay } from '../slice-view.js';
import { syncSliceCountAriaBusy } from '../shell/toolbar-chrome.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { syncZScrubberSlider } from '../sync.js';
import { signalPanelReady } from '../collapsible-sidebar.js';
import { formatSpacingFromMm, isMicroscopySeries } from '../core/physical-units.js';
import {
  microscopyCalibrationSourceText,
  microscopyCalibrationTrustText,
  microscopySequenceOrderText,
  microscopySourceWarningsText,
  microscopyStorageProvenanceText,
  microscopyStreamProvenanceText,
} from '../microscopy/microscopy-provenance-text.js';
import { getRegistrationQuality, getRegistrationRecord } from '../metadata.js';
import { canUseMpr3D, capabilityBlockReason, capabilityLabel, geometryKindForSeries } from './series-capabilities.js';
import { getGroupPeers } from './compare.js';

// TR/TE only exist for MR; a CT/other series reports an em-dash rather than a
// meaningless "0 ms", which metaRowHtml then dims as an empty value.
function formatMs(value) {
  return Number(value) > 0 ? `${value} ms` : '—';
}

function formatSliceThickness(series) {
  const value = Number(series?.sliceThickness || 0);
  if (isMicroscopySeries(series) && !series?._sliceSpacingKnown) return '—';
  return value > 0 ? formatSpacingFromMm(value, series) : '—';
}

export function formatPixelSpacing(pixelSpacing, series) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0)) return '—';
  if (Math.abs(row - col) > 1e-12) {
    return `${formatSpacingFromMm(row, series)} × ${formatSpacingFromMm(col, series)}`;
  }
  return formatSpacingFromMm(row, series);
}

function microscopySourceFilesText(series = {}) {
  const files = series.microscopyDataset?.source?.files || series.microscopy?.sourceFiles || [];
  return sourceFileListText(files, { emptyText: '—', pathSegments: 1 });
}

function sourceFilesText(series = {}) {
  const files = series.sourceFiles || [];
  return sourceFileListText(files, { emptyText: '', pathSegments: 2 });
}

export function sourceFileMetadataRow(series = {}) {
  const text = sourceFilesText(series);
  if (!text) return null;
  const count = Array.isArray(series.sourceFiles) ? series.sourceFiles.filter(Boolean).length : 0;
  return [count > 1 ? 'Source files' : 'Source file', text];
}

export function sourceFileListText(files = [], { emptyText = '', pathSegments = 2 } = {}) {
  const names = files.map(item =>
    String(item || '').split(/[\\/]/).filter(Boolean).slice(-pathSegments).join('/')
  ).filter(Boolean);
  if (!names.length) return emptyText;
  if (names.length === 1) return names[0];
  const preview = names.slice(0, 2).join(', ');
  const hidden = names.length - 2;
  return `${names.length} files (${preview}${hidden > 0 ? `, plus ${hidden} more` : ''})`;
}

// Longest directory shared by every source path (filenames dropped), so a
// many-slice series collapses to one readable folder instead of thousands of UIDs.
function commonSourceDir(paths) {
  const dirs = paths.map(path => path.split('/').slice(0, -1));
  if (!dirs.length) return '';
  let shared = dirs[0];
  for (const dir of dirs.slice(1)) {
    let i = 0;
    while (i < shared.length && i < dir.length && shared[i] === dir[i]) i += 1;
    shared = shared.slice(0, i);
    if (!shared.length) break;
  }
  return shared.join('/');
}

// Full, untruncated path text for the hover tooltip. The metadata cell only shows
// the compact last-segments form; this reveals what truncation hides. The singleton
// tooltip is single-line, so a multi-slice series resolves to its full common folder
// rather than an unbounded list of per-slice paths.
export function sourceFilesTooltip(files = []) {
  const paths = (files || []).map(item => String(item || '').replaceAll('\\', '/')).filter(Boolean);
  if (!paths.length) return '';
  if (paths.length === 1) return paths[0];
  const dir = commonSourceDir(paths);
  return dir ? `${paths.length} files in ${dir}/` : `${paths.length} files · e.g. ${paths[0]}`;
}

const EMPTY_META_VALUE = '—';

// Render one metadata row. A third tuple element may carry { tip, truncate }:
// `tip` exposes the full value on the singleton data-tip tooltip, `truncate`
// clamps the value to one ellipsised line (long file paths / DICOM UIDs), and a
// tip turns the value into a click/Enter-to-copy target (data-copy + role button).
// Missing values render as a dimmed em-dash instead of "0 ms"/blank noise.
export function metaRowHtml([k, val, opts = {}]) {
  const raw = val == null ? '' : String(val).trim();
  const isEmpty = raw === '' || raw === EMPTY_META_VALUE;
  const value = isEmpty ? EMPTY_META_VALUE : raw;
  const rowClass = opts.truncate ? 'meta-row meta-row--truncate' : 'meta-row';
  const mvClass = isEmpty ? 'mv mv-empty' : 'mv';
  let attrs = '';
  // Only non-empty tip rows get the tooltip + copy affordance; an em-dash has
  // nothing to reveal or copy.
  if (opts.tip && !isEmpty) {
    const tip = String(opts.tip);
    attrs = ` data-tip="${escapeHtml(tip)}" data-tip-pos="left"`
      + ` data-copy="${escapeHtml(tip)}" role="button" tabindex="0"`
      + ` aria-label="${escapeHtml(`Copy ${k}: ${tip}`)}"`;
  }
  return `<div class="${rowClass}"><span class="mk">${escapeHtml(k)}</span><span class="${mvClass}"${attrs}>${escapeHtml(value)}</span></div>`;
}

// One delegated listener on the persistent #meta container survives innerHTML
// re-renders on every series change. Clicking (or Enter/Space on) a [data-copy]
// value writes the full path/UID to the clipboard and confirms via a toast.
export function wireMetaCopy(meta) {
  if (meta.dataset.copyWired === '1') return;
  meta.dataset.copyWired = '1';
  const copy = async (el) => {
    const text = el.getAttribute('data-copy');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied to clipboard', { id: 'meta-copy', duration: 1500 });
    } catch {
      notify('Copy failed — clipboard unavailable', { id: 'meta-copy', duration: 2500 });
    }
  };
  meta.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-copy]');
    if (el) copy(el);
  });
  meta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest?.('[data-copy]');
    if (!el) return;
    e.preventDefault();
    copy(el);
  });
}

export function seriesCalibrationText(series = {}, pixelSpacing = []) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0) || series._spacingKnown === false) {
    if (series._niftiSpatialUnit) return `Uncalibrated (NIfTI unit ${series._niftiSpatialUnit})`;
    if (series.dicomImportKind || series.sourceSeriesUID || series.sourceStudyUID) return 'Uncalibrated (DICOM pixel spacing missing)';
    return 'Uncalibrated (pixel spacing missing)';
  }
  if (series._niftiSpatialUnit) return `NIfTI metadata (${series._niftiSpatialUnit})`;
  if (series.dicomImportKind || series.sourceSeriesUID || series.sourceStudyUID) return 'DICOM metadata';
  return 'Metadata calibrated';
}

export function seriesCalibrationTrustText(series = {}, pixelSpacing = []) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0) || series._spacingKnown === false) {
    if (series._niftiSpatialUnit) return `Unknown · NIfTI spatial unit ${series._niftiSpatialUnit}`;
    if (series.dicomImportKind || series.sourceSeriesUID || series.sourceStudyUID) return 'Unknown · DICOM pixel spacing missing';
    return 'Unknown · pixel spacing missing';
  }
  const kind = geometryKindForSeries(series);
  if (kind === 'volumeStack' || kind === 'derivedVolume') return 'Trusted voxel metadata';
  if (kind === 'projectionSet' || kind === 'ultrasoundSource') return 'Trusted pixel metadata · reconstruction required';
  return 'Trusted XY metadata · 2D only';
}

function dicomProvenanceRows(series = {}) {
  if (!(series.dicomImportKind || series.sourceSeriesUID || series.sourceStudyUID || series.frameOfReferenceUID)) return [];
  const sourceParts = [];
  if (series.dicomImportKind) sourceParts.push(`Import ${series.dicomImportKind}`);
  if (series.sourceStudyUID) sourceParts.push(`Study ${series.sourceStudyUID}`);
  if (series.sourceSeriesUID) sourceParts.push(`Series ${series.sourceSeriesUID}`);
  const sourceText = sourceParts.join(' · ');
  // DICOM UIDs run 50–64 chars and overflow the narrow rail like raw paths, so the
  // same clamp-plus-tooltip treatment keeps the full UID reachable on hover.
  const rows = sourceParts.length ? [['DICOM source', sourceText, { tip: sourceText, truncate: true }]] : [];
  if (series.frameOfReferenceUID) {
    rows.push(['Frame of reference', series.frameOfReferenceUID, { tip: series.frameOfReferenceUID, truncate: true }]);
  }
  return rows;
}

function rtDoseSummaryText(summary = {}) {
  return `dimensions ${summary.rows} × ${summary.cols} × ${summary.frames} · scaling ${summary.doseGridScaling} · units ${summary.doseUnits || 'unknown'} · type ${summary.doseType || 'unknown'} · summation ${summary.doseSummationType || 'unknown'}`;
}

export function rtDoseMetadataRows(series = {}, attachments = state._localRtDoseBySlug[series?.slug]) {
  const summaries = Array.isArray(attachments)
    ? attachments.map(item => item?.summary).filter(summary => summary?.format === 'rtdose-summary-v1')
    : [];
  if (!summaries.length) return [];
  const rows = [['RT Dose attachments', String(summaries.length)]];
  for (const [index, summary] of summaries.entries()) {
    rows.push([summaries.length === 1 ? 'RT Dose metadata' : `RT Dose ${index + 1}`, rtDoseSummaryText(summary)]);
  }
  rows.push(['RT Dose boundary', 'metadata only, dose grid is not decoded or rendered']);
  return rows;
}

function niftiTemporalProvenanceRows(series = {}) {
  const timepoints = Number(series._niftiTimepoints || 0);
  const timeIndex = Number(series._niftiTimeIndex);
  if (!(timepoints > 1) || !Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex >= timepoints) return [];
  const unit = String(series._niftiTemporalUnit || 'unknown');
  const spacing = Number(series._niftiTemporalSpacing);
  const offset = Number(series._niftiTimeOffset);
  const spacingKnown = series._niftiTemporalSpacingKnown === true;
  const rows = [
    ['NIfTI timepoint', `${timeIndex + 1} / ${timepoints} (index ${timeIndex})`],
    ['Temporal spacing', spacingKnown && Number.isFinite(spacing) && spacing > 0 ? `${spacing} ${unit}` : `Unknown (${unit})`],
  ];
  if (Number.isFinite(offset) && offset !== 0) rows.push(['Time origin', `${offset} ${unit}`]);
  return rows;
}

function registrationProvenanceRows(series = {}) {
  const record = getRegistrationRecord(series.slug);
  const quality = record?.quality || getRegistrationQuality(series.slug);
  if (!quality) return [];
  const parts = [record?.source || 'data/registration.json'];
  if (quality.verdict) parts.push(quality.verdict);
  else if (quality.grade && quality.grade !== 'unknown') parts.push(quality.grade);
  if (Number.isFinite(quality.mm)) parts.push(`displacement ${quality.mm.toFixed(quality.mm >= 10 ? 1 : 2)} mm`);
  if (Number.isFinite(quality.rotationDeg)) parts.push(`rotation ${quality.rotationDeg} deg`);
  if (Number.isFinite(quality.dice)) parts.push(`Dice ${quality.dice}`);
  const text = parts.join(' · ');
  return [['Registration', text, { tip: text, truncate: true }]];
}

function hasRegistrationEvidence(series = {}) {
  return !!getRegistrationRecord(series.slug);
}

function seriesMatchesRegistrationRef(series = {}, value = '') {
  const ref = String(value || '').trim();
  if (!ref) return false;
  return [
    series.slug,
    series.sourceSeriesSlug,
    series.sourceSeriesUID,
    series.seriesInstanceUID,
    series.uid,
  ].some(item => String(item || '').trim() === ref);
}

function findManifestRegistrationSeries(manifest = {}, value = '') {
  return (manifest.series || []).find(item => seriesMatchesRegistrationRef(item, value)) || null;
}

function registrationCompareTarget(series = {}) {
  const record = getRegistrationRecord(series.slug);
  const fixed = findManifestRegistrationSeries(state.manifest || {}, record?.referenceSlug);
  if (!fixed || fixed.slug === series.slug) return null;
  return { referenceSlug: fixed.slug, movingSlug: series.slug };
}

function registrationEvidenceActionHtml(series = {}) {
  if (!hasRegistrationEvidence(series)) return '';
  const compareTarget = registrationCompareTarget(series);
  const compareButton = compareTarget ? `
      <button class="roi-results-export" id="registration-evidence-open-compare" type="button" data-tip="Open fixed/moving comparison" data-tip-pos="left" aria-label="Open registration comparison">
        <span>Compare</span>
      </button>
  ` : '';
  return `
    <div class="meta-export-actions registration-evidence-actions">
      ${compareButton}
      <button class="roi-results-export" id="registration-evidence-export-json" type="button" data-tip="Export registration evidence JSON" data-tip-pos="left" aria-label="Export registration evidence JSON">
        <span>Registration JSON</span>
      </button>
    </div>
  `;
}

const CLOUD_MODE_LABELS = {
  standard: 'standard CT/MR processing',
  projection_set_reconstruction: 'projection reconstruction',
  rigid_registration: 'registration/alignment',
  ultrasound_scan_conversion: 'ultrasound scan conversion',
};

const CLOUD_INPUT_LABELS = {
  dicom_volume_stack: 'DICOM volume stack',
  calibrated_projection_set: 'calibrated projection set',
  calibrated_projection_source: 'calibrated projection source',
  dicom_registration_pair: 'DICOM registration pair',
  calibrated_ultrasound_source: 'calibrated ultrasound source',
};

const ENGINE_SOURCE_LABELS = {
  'projection-reconstruction': 'projection reconstruction',
  'rigid-registration': 'registration/alignment',
  'ultrasound-scan-conversion': 'ultrasound scan conversion',
};

function cloudTokenLabel(value, labels = {}) {
  const key = String(value || '').trim();
  return key ? (labels[key] || key.replaceAll('_', ' ')) : '';
}

function compactCloudValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function safeFilenamePart(value, fallback = 'series') {
  const text = String(value || fallback).trim().replace(/[^a-z0-9_.-]+/gi, '_');
  return text || fallback;
}

function downloadJson(payload, filename) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function cloudEngineText(series = {}) {
  const report = series.engineReport && typeof series.engineReport === 'object' ? series.engineReport : null;
  const parts = [];
  const sourceKind = cloudTokenLabel(series.engineSourceKind, ENGINE_SOURCE_LABELS);
  if (sourceKind) parts.push(sourceKind);
  if (report?.backend) parts.push(`backend ${compactCloudValue(report.backend)}`);
  if (report?.geometryModel) parts.push(`geometry ${compactCloudValue(report.geometryModel)}`);
  if (report?.profileId) parts.push(`profile ${compactCloudValue(report.profileId)}`);
  if (report?.mode) parts.push(`mode ${compactCloudValue(report.mode)}`);
  if (report?.probeGeometry) parts.push(`probe ${compactCloudValue(report.probeGeometry)}`);
  if (report?.validation) parts.push(`validation ${compactCloudValue(report.validation)}`);
  return parts.join(' · ');
}

function cloudSourceText(series = {}) {
  const projectionSetId = compactCloudValue(series.sourceProjectionSetId);
  if (projectionSetId) return `projection set ${projectionSetId}`;
  const calibration = series.ultrasoundCalibration && typeof series.ultrasoundCalibration === 'object'
    ? series.ultrasoundCalibration
    : null;
  if (!calibration) return '';
  const parts = ['calibrated ultrasound source'];
  if (calibration.status) parts.push(compactCloudValue(calibration.status));
  if (calibration.mode) parts.push(`mode ${compactCloudValue(calibration.mode)}`);
  if (calibration.probeGeometry) parts.push(`probe ${compactCloudValue(calibration.probeGeometry)}`);
  if (calibration.source) parts.push(`source ${compactCloudValue(calibration.source)}`);
  return parts.join(' · ');
}

function formatNormalizationNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (Math.abs(number) >= 100) return String(Math.round(number));
  return String(Math.round(number * 100) / 100);
}

function normalizationMethodLabel(method) {
  if (method === 'fixed-ct-window') return 'fixed CT window';
  if (method === 'nonzero-voxel-percentile-window') return 'nonzero percentile window';
  return String(method || 'normalization').replaceAll('-', ' ');
}

function normalizationWindowText(record = {}) {
  const window = Array.isArray(record.window) ? record.window : [];
  const lo = formatNormalizationNumber(window[0]);
  const hi = formatNormalizationNumber(window[1]);
  if (!lo || !hi) return '';
  return `${lo} to ${hi}${record.inputUnit ? ` ${record.inputUnit}` : ''}`;
}

function normalizationPartText(label, record = {}) {
  if (!record || typeof record !== 'object') return '';
  const method = normalizationMethodLabel(record.method);
  const range = normalizationWindowText(record);
  if (!range) return `${label} ${method}`;
  return `${label} ${method} ${range}`;
}

function normalizationLosses(normalization = {}) {
  const losses = new Set();
  for (const record of [normalization.previewPng, normalization.rawVolume]) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.knownLosses)) continue;
    for (const loss of record.knownLosses) {
      const text = String(loss || '').trim();
      if (text) losses.add(text);
    }
  }
  return [...losses];
}

function cloudNormalizationText(series = {}) {
  const normalization = series.engineReport?.normalization;
  if (!normalization || typeof normalization !== 'object') return '';
  const parts = [
    normalizationPartText('PNG', normalization.previewPng),
    normalizationPartText('raw', normalization.rawVolume),
  ].filter(Boolean);
  const losses = normalizationLosses(normalization);
  if (losses.length) parts.push(`losses: ${losses.slice(0, 3).join('; ')}`);
  return parts.join(' · ');
}

function cloudProvenanceRows(series = {}) {
  const action = series.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : null;
  const rows = [];
  if (action?.label) {
    const parts = [action.label];
    if (action.resultStatus && action.resultStatus !== 'complete') parts.push(`status ${cloudTokenLabel(action.resultStatus)}`);
    if (action.processingMode) parts.push(cloudTokenLabel(action.processingMode, CLOUD_MODE_LABELS));
    if (action.inputKind) parts.push(`input ${cloudTokenLabel(action.inputKind, CLOUD_INPUT_LABELS)}`);
    const text = parts.join(' · ');
    const rawParts = [];
    if (action.resultStatus && action.resultStatus !== 'complete') rawParts.push(`status ${action.resultStatus}`);
    if (action.processingMode) rawParts.push(`mode ${action.processingMode}`);
    if (action.inputKind) rawParts.push(`input ${action.inputKind}`);
    const tip = rawParts.length ? `${text} (${rawParts.join(' · ')})` : text;
    rows.push(['Cloud action', text, { tip, truncate: true }]);
  }
  const engineText = cloudEngineText(series);
  if (engineText) rows.push(['Cloud engine', engineText, { tip: engineText, truncate: true }]);
  const sourceText = cloudSourceText(series);
  if (sourceText) rows.push(['Cloud source', sourceText, { tip: sourceText, truncate: true }]);
  const normalizationText = cloudNormalizationText(series);
  if (normalizationText) rows.push(['Cloud normalization', normalizationText, { tip: normalizationText, truncate: true }]);
  const jobId = String(action?.jobId || series.sourceJobId || '').trim();
  if (jobId) rows.push(['Cloud job', jobId, { tip: jobId, truncate: true }]);
  const outputs = [];
  if (series.hasRaw || series.rawUrl) outputs.push('raw volume');
  if (series.hasSeg) outputs.push('tissue overlay');
  if (series.hasRegions) outputs.push('anatomy labels');
  if (series.hasSym) outputs.push('symmetry heatmap');
  if (series.hasStats) outputs.push('stats');
  if (series.hasAnalysis) outputs.push('analysis');
  const resultParts = [];
  if (action?.provider) resultParts.push(action.provider);
  if (action?.resultSlug) resultParts.push(`result ${action.resultSlug}`);
  if (outputs.length) resultParts.push(outputs.join(', '));
  if (resultParts.length) {
    const resultText = resultParts.join(' · ');
    rows.push(['Cloud result', resultText, { tip: resultText, truncate: true }]);
  }
  return rows;
}

function hasCloudProvenance(series = {}) {
  return !!(series.cloudAction && typeof series.cloudAction === 'object') || !!String(series.sourceJobId || '').trim();
}

function cloudProvenanceActionHtml(series = {}) {
  if (!hasCloudProvenance(series)) return '';
  return `
    <div class="meta-export-actions cloud-provenance-actions">
      <button class="roi-results-export" id="cloud-provenance-export-json" type="button" data-tip="Export cloud provenance JSON" data-tip-pos="left" aria-label="Export cloud provenance JSON">
        <span>Provenance JSON</span>
      </button>
      <button class="roi-results-export" id="cloud-result-package-json" type="button" data-tip="Export cloud result package JSON" data-tip-pos="left" aria-label="Export cloud result package JSON">
        <span>Package JSON</span>
      </button>
    </div>
  `;
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/i.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function publicBaseFromSeriesUrl(value, slug) {
  const url = httpUrl(value);
  if (!url || !slug) return '';
  const path = url.pathname.replace(/\/+$/, '');
  const markers = [
    `/data/${slug}`,
    `/data/${slug}_`,
    `/${slug}.raw.zst`,
    `/${slug}.raw`,
    '/results/',
  ];
  for (const marker of markers) {
    const index = path.indexOf(marker);
    if (index >= 0) {
      const basePath = path.slice(0, index).replace(/\/+$/, '');
      return `${url.origin}${basePath}`;
    }
  }
  return '';
}

function cloudPublicBaseForSeries(series = {}) {
  const slug = String(series.slug || '').trim();
  const overlayBases = series.overlayUrlBases && typeof series.overlayUrlBases === 'object'
    ? Object.values(series.overlayUrlBases)
    : [];
  const candidates = [
    series.sliceUrlBase,
    series.rawUrl,
    series.statsUrl,
    series.regionMetaUrl,
    series.regionUrlBase,
    ...overlayBases,
  ];
  for (const candidate of candidates) {
    const base = publicBaseFromSeriesUrl(candidate, slug);
    if (base) return base;
  }
  return '';
}

function cloudJobIdForSeries(series = {}) {
  const action = series.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : {};
  return String(action.jobId || series.sourceJobId || series.job_id || '').trim();
}

function cloudResultCompanionUrl(series = {}, filename = '') {
  const jobId = cloudJobIdForSeries(series);
  const base = cloudPublicBaseForSeries(series);
  if (!jobId || !base || !filename) return '';
  return `${base}/results/${encodeURIComponent(jobId)}/${filename}`;
}

function cloudProcessingModeForSeries(series = {}) {
  const action = series.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : {};
  return String(action.processingMode || series.processingMode || '').trim();
}

function hasProjectionCompanion(series = {}) {
  const mode = cloudProcessingModeForSeries(series);
  return mode === 'projection_set_reconstruction' || series.engineSourceKind === 'projection-reconstruction';
}

function hasRegistrationCompanion(series = {}) {
  const mode = cloudProcessingModeForSeries(series);
  return mode === 'rigid_registration' || series.engineSourceKind === 'rigid-registration'
    || !!(series.registration && typeof series.registration === 'object');
}

export function cloudSidecarsForSeries(series = {}) {
  const slug = String(series.slug || '').trim();
  if (!slug) return {};
  const sidecars = {};
  if (series.hasStats) sidecars.stats = series.statsUrl || `data/${slug}_stats.json`;
  if (series.hasAnalysis) sidecars.analysis = `data/${slug}_analysis.json`;
  if (series.hasContext) sidecars.context = `data/${slug}_context.json`;
  if (series.hasAskHistory) sidecars.askHistory = `data/${slug}_asks.json`;
  if (series.hasRegions && series.regionMetaUrl) sidecars.regionMetadata = series.regionMetaUrl;
  const projectionSet = hasProjectionCompanion(series) ? cloudResultCompanionUrl(series, 'projection_set.json') : '';
  if (projectionSet) sidecars.projectionSet = projectionSet;
  const registration = hasRegistrationCompanion(series) ? cloudResultCompanionUrl(series, 'registration.json') : '';
  if (registration) sidecars.registration = registration;
  return sidecars;
}

function cloudOutputsForSeries(series = {}) {
  return {
    previewStack: series.sliceUrlBase ? { urlBase: series.sliceUrlBase, slices: series.slices || 0 } : null,
    rawVolume: series.rawUrl ? { url: series.rawUrl } : (series.hasRaw ? { expected: true } : null),
    overlays: {
      tissue: !!series.hasSeg,
      labels: !!series.hasRegions,
      heatmap: !!series.hasSym,
    },
    sidecars: cloudSidecarsForSeries(series),
  };
}

function sourceProjectionSetForSeries(series = {}, manifest = {}) {
  const id = String(series.sourceProjectionSetId || '').trim();
  if (!id || !Array.isArray(manifest.projectionSets)) return null;
  return manifest.projectionSets.find(record => record?.id === id) || null;
}

function compactAssetBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function stackAssetRecord(kind, label, { urlBase = '', pathBase = '', slices = 0 } = {}) {
  const record = {
    kind,
    label,
    filePattern: '0000.png',
    slices: Number(slices) || 0,
  };
  const cleanUrl = compactAssetBase(urlBase);
  const cleanPath = compactAssetBase(pathBase);
  if (cleanUrl) record.urlBase = cleanUrl;
  else if (cleanPath) record.pathBase = cleanPath;
  return record.urlBase || record.pathBase ? record : null;
}

function cloudResultPackageAssets(series = {}) {
  const slug = String(series.slug || '').trim();
  if (!slug) return [];
  const assets = [];
  const preview = stackAssetRecord('preview-stack', 'Rendered preview PNG stack', {
    urlBase: series.sliceUrlBase,
    slices: series.slices,
  });
  if (preview) assets.push(preview);
  if (series.rawUrl) {
    assets.push({ kind: 'raw-volume', label: 'Raw volume', url: series.rawUrl });
  } else if (series.hasRaw) {
    assets.push({ kind: 'raw-volume', label: 'Raw volume', expected: true });
  }
  const overlayBases = series.overlayUrlBases && typeof series.overlayUrlBases === 'object'
    ? series.overlayUrlBases
    : {};
  if (series.hasSeg) {
    const tissue = stackAssetRecord('tissue-overlay', 'Tissue overlay PNG stack', {
      urlBase: overlayBases[`${slug}_seg`],
      pathBase: `data/${slug}_seg`,
      slices: series.slices,
    });
    if (tissue) assets.push(tissue);
  }
  if (series.hasSym) {
    const heatmap = stackAssetRecord('symmetry-heatmap', 'Symmetry heatmap PNG stack', {
      urlBase: overlayBases[`${slug}_sym`],
      pathBase: `data/${slug}_sym`,
      slices: series.slices,
    });
    if (heatmap) assets.push(heatmap);
  }
  if (series.hasRegions) {
    const labels = stackAssetRecord('anatomy-labels', 'Anatomy label PNG stack', {
      urlBase: series.regionUrlBase || overlayBases[`${slug}_regions`],
      pathBase: `data/${slug}_regions`,
      slices: series.slices,
    });
    if (labels) assets.push(labels);
  }
  const sidecars = cloudSidecarsForSeries(series);
  for (const [kind, path] of Object.entries(sidecars)) {
    const record = { kind: `sidecar-${kind}`, label: kind };
    if (/^https?:\/\//i.test(path)) record.url = path;
    else record.path = path;
    assets.push(record);
  }
  return assets;
}

export function cloudProvenanceExportPayload(series = {}, manifest = {}) {
  const action = series.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : {};
  return {
    schema: 'voxellab.cloud-provenance.v1',
    exportedAt: new Date().toISOString(),
    disclaimer: 'VoxelLab cloud outputs are research and educational artifacts, not clinical output.',
    study: {
      patient: manifest.patient || '',
      studyDate: manifest.studyDate || '',
    },
    series: {
      slug: series.slug || '',
      name: series.name || '',
      description: series.description || '',
      modality: series.modality || '',
      dimensions: {
        width: series.width || 0,
        height: series.height || 0,
        slices: series.slices || 0,
      },
      pixelSpacing: Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [],
      sliceThickness: series.sliceThickness || 0,
      geometryKind: series.geometryKind || '',
      renderability: series.renderability || '',
      sourceProjectionSetId: series.sourceProjectionSetId || '',
      sourceStudyUID: series.sourceStudyUID || '',
      sourceSeriesUID: series.sourceSeriesUID || '',
    },
    action: {
      id: action.id || '',
      label: action.label || 'Cloud result',
      provider: action.provider || 'modal',
      jobId: action.jobId || series.sourceJobId || '',
      processingMode: action.processingMode || '',
      inputKind: action.inputKind || '',
      resultSlug: action.resultSlug || series.slug || '',
      resultStatus: action.resultStatus || 'complete',
    },
    outputs: cloudOutputsForSeries(series),
    sourceProjectionSet: sourceProjectionSetForSeries(series, manifest),
    engineReport: series.engineReport || null,
    sourceFiles: Array.isArray(series.sourceFiles) ? series.sourceFiles : [],
  };
}

export function cloudResultPackagePayload(series = {}, manifest = {}) {
  const provenance = cloudProvenanceExportPayload(series, manifest);
  return {
    schema: 'voxellab.cloud-result-package.v1',
    exportedAt: provenance.exportedAt,
    disclaimer: provenance.disclaimer,
    packageType: 'manifest-only',
    study: provenance.study,
    series: provenance.series,
    action: provenance.action,
    assets: cloudResultPackageAssets(series),
    provenance,
  };
}

function registrationSeriesRef(series = {}) {
  if (!series || typeof series !== 'object') return null;
  return {
    slug: series.slug || '',
    name: series.name || '',
    modality: series.modality || '',
    dimensions: {
      width: series.width || 0,
      height: series.height || 0,
      slices: series.slices || 0,
    },
    pixelSpacing: Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [],
    sliceThickness: series.sliceThickness || 0,
    geometryKind: series.geometryKind || '',
    frameOfReferenceUID: series.frameOfReferenceUID || '',
    sourceStudyUID: series.sourceStudyUID || '',
    sourceSeriesUID: series.sourceSeriesUID || '',
  };
}

function registrationEvidencePayload(series = {}, manifest = {}) {
  const registration = getRegistrationRecord(series.slug) || {};
  const fixed = findManifestRegistrationSeries(manifest, registration.referenceSlug);
  return {
    schema: 'voxellab.registration-evidence.v1',
    exportedAt: new Date().toISOString(),
    disclaimer: 'VoxelLab registration evidence is for research and educational review, not clinical output.',
    study: {
      patient: manifest.patient || '',
      studyDate: manifest.studyDate || '',
    },
    fixedImage: registrationSeriesRef(fixed || { slug: registration.referenceSlug }),
    movingImage: registrationSeriesRef(series),
    registration,
  };
}

function wireRegistrationExports(meta, series) {
  meta.querySelector('#registration-evidence-open-compare')?.addEventListener('click', () => {
    const target = registrationCompareTarget(series);
    if (!target) {
      notify('Fixed image is not loaded for comparison', { id: 'registration-compare-unavailable', duration: 2200 });
      return;
    }
    window.dispatchEvent(new CustomEvent('voxellab:open-registration-compare', { detail: target }));
  });
  const button = meta.querySelector('#registration-evidence-export-json');
  button?.addEventListener('click', () => {
    const payload = registrationEvidencePayload(series, state.manifest || {});
    downloadJson(payload, `voxellab-registration-evidence-${safeFilenamePart(series.slug)}.json`);
    notify('Registration evidence JSON exported', { id: 'registration-evidence-export', duration: 1800 });
  });
}

function wireCloudExports(meta, series) {
  const provenanceButton = meta.querySelector('#cloud-provenance-export-json');
  provenanceButton?.addEventListener('click', () => {
    const payload = cloudProvenanceExportPayload(series, state.manifest || {});
    downloadJson(payload, `voxellab-cloud-provenance-${safeFilenamePart(series.slug)}.json`);
    notify('Cloud provenance JSON exported', { id: 'cloud-provenance-export', duration: 1800 });
  });
  const packageButton = meta.querySelector('#cloud-result-package-json');
  packageButton?.addEventListener('click', () => {
    const payload = cloudResultPackagePayload(series, state.manifest || {});
    downloadJson(payload, `voxellab-cloud-package-${safeFilenamePart(series.slug)}.json`);
    notify('Cloud result package JSON exported', { id: 'cloud-result-package-export', duration: 1800 });
  });
}

/** Hide empty groups and clean up orphan separators in the toolbar. */
export function cleanToolbarSeparators() {
  const controls = document.querySelector('.controls');
  if (!controls) return;

  controls.querySelectorAll('.tool-group, .toolbox').forEach((g) => {
    const btns = g.querySelectorAll('.icon-btn');
    if (!btns.length) return; /* e.g. .tool-group--wl (presets + opacity only) */
    const allHidden = [...btns].every((b) => b.classList.contains('hidden'));
    g.classList.toggle('hidden', allHidden);
  });

  // Single pass: show a separator only between two visible non-sep items
  let pendingSep = null;
  let sawVisible = false;
  for (const el of controls.children) {
    if (el.classList.contains('toolbar-sep')) {
      el.classList.add('hidden');
      if (sawVisible) pendingSep = el;
    } else if (!el.classList.contains('hidden')) {
      if (pendingSep) { pendingSep.classList.remove('hidden'); pendingSep = null; }
      sawVisible = true;
    }
  }
}

/**
 * Updates sidebar highlight, series metadata panel, MPR indices, and overlay toggles.
 */
export function applySelectSeriesDom(i, series, v) {
  const vhName = $('series-name') || $('vh-series-name');
  const vhDesc = $('series-desc') || $('vh-series-desc');
  const headerStudy = document.querySelector('.viewer-header-study');
  const titleWasEmpty = !!(vhName && !vhName.textContent);

  const overlays = activeOverlayStateForSeries(series);
  const listItems = [...document.querySelectorAll('#series-list li[data-series-slug]')];
  const activeItem = listItems.find(el => el.dataset.seriesSlug === series.slug);
  listItems.forEach((el) => {
    el.classList.toggle('active', el.dataset.seriesSlug === series.slug);
  });
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  if (vhName) vhName.textContent = series.name;
  if (vhDesc) vhDesc.textContent = series.description;
  // One fade for name + description together; only on first fill (no strip/re-run on series changes — avoids flash).
  if (headerStudy && titleWasEmpty) {
    headerStudy.classList.remove('ui-fade-in');
    headerStudy.style.opacity = '0';
    void headerStudy.offsetWidth;
    requestAnimationFrame(() => {
      headerStudy.style.removeProperty('opacity');
      headerStudy.classList.add('ui-fade-in');
    });
  }
  $('slice-tot').textContent = series.slices;
  $('scrub').max = series.slices - 1;
  $('scrub').value = state.sliceIdx;
  syncZScrubberSlider(series);
  updateScrubFill();
  updateSliceDisplay(state.sliceIdx + 1);
  syncSliceCountAriaBusy();

  const meta = $('meta');
  const pixelSpacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [0, 0];
  const rows = [
    ['Series description', series.sequence || '—'],
    ['Dimensions', `${series.width} × ${series.height}`],
    ['Slices', series.slices],
    ['Slice thickness', formatSliceThickness(series)],
    ['Pixel spacing', formatPixelSpacing(pixelSpacing, series)],
    ['3D status', capabilityLabel(series)],
    ['TR', formatMs(series.tr)],
    ['TE', formatMs(series.te)],
  ];
  const isVolumetric = canUseMpr3D(series);
  if (!isVolumetric) rows.splice(6, 0, ['3D reason', capabilityBlockReason(series)]);
  if (isMicroscopySeries(series)) {
    const sequenceOrderText = microscopySequenceOrderText(series);
    const storageProvenanceText = microscopyStorageProvenanceText(series);
    const streamProvenanceText = microscopyStreamProvenanceText(series);
    rows.splice(1, 0, ['Format', series.microscopy?.format || 'Microscopy']);
    if (streamProvenanceText) rows.splice(2, 0, ['Streaming', streamProvenanceText]);
    if (storageProvenanceText) rows.splice(2, 0, ['Storage', storageProvenanceText]);
    rows.splice(streamProvenanceText || storageProvenanceText ? 5 : 4, 0, ['Axes', `Z ${series.microscopy?.sizeZ || series.slices} · C ${series.microscopy?.sizeC || 1} · T ${series.microscopy?.sizeT || 1}`]);
    rows.splice(6, 0, ['Calibration', microscopyCalibrationSourceText(series, pixelSpacing)]);
    rows.splice(7, 0, ['Spacing trust', microscopyCalibrationTrustText(series, pixelSpacing)]);
    const microscopyFiles = series.microscopyDataset?.source?.files || series.microscopy?.sourceFiles || [];
    rows.splice(8, 0, ['Source files', microscopySourceFilesText(series), { tip: sourceFilesTooltip(microscopyFiles), truncate: true }]);
    if (sequenceOrderText) rows.splice(9, 0, ['Sequence order', sequenceOrderText]);
    rows.splice(sequenceOrderText ? 10 : 9, 0, ['Source warnings', microscopySourceWarningsText(series)]);
  } else {
    rows.splice(5, 0, ['Calibration', seriesCalibrationText(series, pixelSpacing)]);
    rows.splice(6, 0, ['Spacing trust', seriesCalibrationTrustText(series, pixelSpacing)]);
    const sourceFileRow = sourceFileMetadataRow(series);
    const provenanceRows = sourceFileRow
      ? [[sourceFileRow[0], sourceFileRow[1], { tip: sourceFilesTooltip(series.sourceFiles), truncate: true }]]
      : [];
    provenanceRows.push(...registrationProvenanceRows(series));
    provenanceRows.push(...cloudProvenanceRows(series));
    provenanceRows.push(...dicomProvenanceRows(series));
    provenanceRows.push(...rtDoseMetadataRows(series));
    provenanceRows.push(...niftiTemporalProvenanceRows(series));
    rows.splice(7, 0, ...provenanceRows);
  }
  // Study context (appended so the splice indices above stay stable). Modality is
  // always shown; body part + acquisition plane only when the data actually
  // carries them — never assert a plane without a real patient frame.
  if (series.modality) rows.push(['Modality', series.modality]);
  if (!isMicroscopySeries(series)) {
    if (series._bodyPart) rows.push(['Body part', series._bodyPart]);
    const plane = acquisitionPlane(series);
    if (plane) rows.push(['Acquisition plane', plane]);
  }
  meta.innerHTML = `${rows.map(metaRowHtml).join('')}${registrationEvidenceActionHtml(series)}${cloudProvenanceActionHtml(series)}`;
  wireMetaCopy(meta);
  wireRegistrationExports(meta, series);
  wireCloudExports(meta, series);
  signalPanelReady('metadata');
  v.renderMicroscopyHyperstackControls?.(state);

  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);

  // Single-slice series: hide play/scrub/fps — no slices to scroll through
  const isSingle = series.slices <= 1;
  const scrubBlock = $('scrub').closest('.scrub-block');
  if (scrubBlock) scrubBlock.classList.toggle('hidden', isSingle);

  show('btn-brain', !!series.hasBrain);
  show('btn-seg', overlays.tissue.available);
  show('btn-regions', overlays.labels.available);
  show('btn-sym', overlays.heatmap.available);

  show('btn-3d', isVolumetric);
  show('btn-mpr', isVolumetric);
  if (!isVolumetric && (v.is3dActive() || v.isMprActive())) {
    v.setMode('2d');
  }

  const peers = getGroupPeers();
  const totalSeries = state.manifest.series.length;
  // Show compare when auto-peers exist OR when there are 2+ series the user could pick
  const cmpVisible = peers.length >= 2 || totalSeries >= 2;
  show('cmp-dropdown', cmpVisible);
  show('btn-compare', cmpVisible);

  cleanToolbarSeparators();

  $('btn-brain').classList.toggle('active', state.useBrain);
  $('btn-seg').classList.toggle('active', overlays.tissue.enabled);
  $('btn-regions').classList.toggle('active', overlays.labels.enabled);
  $('btn-sym').classList.toggle('active', overlays.heatmap.enabled);

  $('btn-brain').title = 'Toggle skull-stripped brain (B)';
  $('btn-seg').title = 'Toggle CSF/GM/WM tissue overlay (T)';
  $('btn-regions').title = 'Toggle approximate anatomical regions';
  $('btn-sym').title = 'Toggle left/right symmetry heatmap (Y)';
  $('btn-compare').title = peers.length >= 2
    ? `Compare ${peers.length} co-registered series (c)`
    : totalSeries >= 2
      ? 'Compare — right-click to pick series (c)'
      : '';

  if (state.mode === 'cmp' && peers.length < 2) v.setMode('2d');
}
