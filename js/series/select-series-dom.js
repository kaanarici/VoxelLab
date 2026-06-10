// DOM + button state when switching the active series (used by select-series.js).

import { $, escapeHtml } from '../dom.js';
import { state } from '../core/state.js';
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
} from '../microscopy/microscopy-provenance-text.js';
import { canUseMpr3D, capabilityBlockReason, capabilityLabel, geometryKindForSeries } from './series-capabilities.js';
import { getGroupPeers } from './compare.js';

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
  const rows = sourceParts.length ? [['DICOM source', sourceParts.join(' · ')]] : [];
  if (series.frameOfReferenceUID) rows.push(['Frame of reference', series.frameOfReferenceUID]);
  return rows;
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
    ['Sequence', series.sequence || '—'],
    ['Dimensions', `${series.width} × ${series.height}`],
    ['Slices', series.slices],
    ['Slice thickness', formatSliceThickness(series)],
    ['Pixel spacing', formatPixelSpacing(pixelSpacing, series)],
    ['3D status', capabilityLabel(series)],
    ['TR', `${series.tr} ms`],
    ['TE', `${series.te} ms`],
  ];
  const isVolumetric = canUseMpr3D(series);
  if (!isVolumetric) rows.splice(6, 0, ['3D reason', capabilityBlockReason(series)]);
  if (isMicroscopySeries(series)) {
    const sequenceOrderText = microscopySequenceOrderText(series);
    rows.splice(1, 0, ['Format', series.microscopy?.format || 'Microscopy']);
    rows.splice(4, 0, ['Axes', `Z ${series.microscopy?.sizeZ || series.slices} · C ${series.microscopy?.sizeC || 1} · T ${series.microscopy?.sizeT || 1}`]);
    rows.splice(6, 0, ['Calibration', microscopyCalibrationSourceText(series, pixelSpacing)]);
    rows.splice(7, 0, ['Spacing trust', microscopyCalibrationTrustText(series, pixelSpacing)]);
    rows.splice(8, 0, ['Source files', microscopySourceFilesText(series)]);
    if (sequenceOrderText) rows.splice(9, 0, ['Sequence order', sequenceOrderText]);
    rows.splice(sequenceOrderText ? 10 : 9, 0, ['Source warnings', microscopySourceWarningsText(series)]);
  } else {
    rows.splice(5, 0, ['Calibration', seriesCalibrationText(series, pixelSpacing)]);
    rows.splice(6, 0, ['Spacing trust', seriesCalibrationTrustText(series, pixelSpacing)]);
    const sourceFileRow = sourceFileMetadataRow(series);
    const provenanceRows = sourceFileRow ? [sourceFileRow] : [];
    provenanceRows.push(...dicomProvenanceRows(series));
    rows.splice(7, 0, ...provenanceRows);
  }
  meta.innerHTML = rows.map(([k, val]) => `<div class="meta-row"><span class="mk">${escapeHtml(k)}</span><span class="mv">${escapeHtml(String(val))}</span></div>`).join('');
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
