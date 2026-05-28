// DOM + button state when switching the active series (used by select-series.js).

import { $, escapeHtml } from './dom.js';
import { state } from './state.js';
import { updateScrubFill } from './cine.js';
import { updateSliceDisplay } from './slice-view.js';
import { syncSliceCountAriaBusy } from './toolbar-chrome.js';
import { getGroupPeers } from './compare.js';
import { canUseMpr3D, capabilityLabel } from './series-capabilities.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { syncZScrubberSlider } from './sync.js';
import { signalPanelReady } from './collapsible-sidebar.js';
import { formatSpacingFromMm, isMicroscopySeries } from './physical-units.js';
import { renderMicroscopyHyperstackControls } from './microscopy-hyperstack-controls.js';

function formatSliceThickness(series) {
  const value = Number(series?.sliceThickness || 0);
  if (isMicroscopySeries(series) && !series?._sliceSpacingKnown) return '—';
  return value > 0 ? formatSpacingFromMm(value, series) : '—';
}

function formatPixelSpacing(pixelSpacing, series) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0)) return '—';
  if (isMicroscopySeries(series) && Math.abs(row - col) > 1e-12) {
    return `${formatSpacingFromMm(row, series)} × ${formatSpacingFromMm(col, series)}`;
  }
  return formatSpacingFromMm(row, series);
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
  if (isMicroscopySeries(series)) {
    rows.splice(1, 0, ['Format', series.microscopy?.format || 'Microscopy']);
    rows.splice(4, 0, ['Axes', `Z ${series.microscopy?.sizeZ || series.slices} · C ${series.microscopy?.sizeC || 1} · T ${series.microscopy?.sizeT || 1}`]);
  }
  meta.innerHTML = rows.map(([k, val]) => `<div class="meta-row"><span class="mk">${escapeHtml(k)}</span><span class="mv">${escapeHtml(String(val))}</span></div>`).join('');
  signalPanelReady('metadata');
  renderMicroscopyHyperstackControls(state);

  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);

  // Single-slice series: hide play/scrub/fps — no slices to scroll through
  const isSingle = series.slices <= 1;
  const scrubBlock = $('scrub').closest('.scrub-block');
  if (scrubBlock) scrubBlock.classList.toggle('hidden', isSingle);

  show('btn-brain', !!series.hasBrain);
  show('btn-seg', overlays.tissue.available);
  show('btn-regions', overlays.labels.available);
  show('btn-sym', overlays.heatmap.available);

  const isVolumetric = canUseMpr3D(series);
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
