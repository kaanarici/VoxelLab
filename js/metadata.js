// Computed metadata derived from DICOM tags and pipeline outputs.
// Everything here is general-purpose — no hardcoded body parts,
// modality assumptions, or series-specific logic. All values are
// derived from what exists in the manifest and data files.

import { $, colorSwatchSvg } from './dom.js';
import { state } from './core/state.js';
import { inPlanePixelSpacing } from './core/geometry.js';
import { signalPanelReady } from './collapsible-sidebar.js';

// registration.json: alignment metrics → compare-mode quality dots.
let _regData = null;

export async function loadRegistrationData() {
  try {
    const r = await fetch('./data/registration.json');
    if (r.ok) _regData = await r.json();
  } catch {}
}

export function getRegistrationQuality(slug) {
  if (!_regData) return null;
  const entry = _regData[slug];
  if (!entry) return null;
  const mm = entry.mean_displacement_mm ?? entry.meanDisp;
  if (mm == null) return null;
  // Green < 1mm, yellow 1-3mm, red > 3mm
  const grade = mm < 1 ? 'good' : mm < 3 ? 'fair' : 'poor';
  return { mm: +mm.toFixed(2), grade, dice: entry.dice };
}

function regionalVolumesEmptyLine(reason) {
  const hint = reason === 'zeroVolume'
    ? 'Labels did not yield any volume above the reporting threshold.'
    : 'No segmentation sidecar for this series.';
  return `<p class="rp-empty-minimal" role="status">${hint}</p>`;
}

// Persists across re-renders (reactive-sync fires renderVolumeTable on voxel/overlay changes).
// Shape: false (collapsed, default) | true (expanded, user clicked "show all").
let volumeTableExpanded = false;
const VOLUME_TABLE_INITIAL = 20;

export function renderVolumeTable() {
  const host = $('volume-table');
  const volLine = $('volumes-info-line');
  if (!host) return;
  if (!state.regionMeta || !state.regionMeta.regions) {
    if (volLine) volLine.hidden = true;
    host.innerHTML = regionalVolumesEmptyLine('noSidecar');
    return;
  }
  const regions = state.regionMeta.regions;
  const colors = state.regionMeta.colors || {};
  const series = state.manifest?.series?.[state.seriesIdx];
  // When the series has no trusted voxel spacing, the sidecar's mL was computed
  // against assumed 1 mm spacing — reporting it as authoritative millilitres is
  // fabricated precision. Degrade to honest voxel counts instead (same policy as
  // label-inspect.js), and tell the user why in the info line.
  const calibrated = inPlanePixelSpacing(series || {}).known;
  const sizeOf = (e) => (calibrated ? e.mL : e.voxels) || 0;
  const entries = Object.entries(regions)
    .map(([k, r]) => ({ id: +k, ...r }))
    .filter(e => sizeOf(e) > 0)
    .sort((a, b) => sizeOf(b) - sizeOf(a));

  if (!entries.length) {
    if (volLine) volLine.hidden = true;
    host.innerHTML = regionalVolumesEmptyLine('zeroVolume');
    return;
  }

  if (volLine) {
    volLine.hidden = false;
    if (!calibrated) volLine.textContent = 'Spacing not calibrated — showing voxel counts, not volumes.';
  }
  signalPanelReady('region-volumes');
  const total = entries.reduce((s, e) => s + sizeOf(e), 0);
  const hasOverflow = entries.length > VOLUME_TABLE_INITIAL;
  const showAll = hasOverflow && volumeTableExpanded;
  const visible = showAll ? entries : entries.slice(0, VOLUME_TABLE_INITIAL);
  const rowsHtml = visible.map(e => {
    const c = colors[e.id];
    const rgb = c ? `${c[0]},${c[1]},${c[2]}` : '85,85,85';
    const pct = ((sizeOf(e) / total) * 100).toFixed(1);
    const valText = calibrated ? `${e.mL} mL` : `${e.voxels} vox`;
    return `<div class="vol-row">
      ${colorSwatchSvg('vol-swatch', rgb.split(',').map(Number), 10)}
      <span class="vol-name">${e.name}</span>
      <span class="vol-val">${valText}</span>
      <span class="vol-pct">${pct}%</span>
      <span class="vol-export">
        <button type="button" class="vol-export-btn" data-export-label="${e.id}" data-export-fmt="stl" data-tip="Download this structure as STL">STL</button>
        <button type="button" class="vol-export-btn" data-export-label="${e.id}" data-export-fmt="obj" data-tip="Download this structure as OBJ">OBJ</button>
      </span>
    </div>`;
  }).join('');
  // Toggle chip lives inline at the end of the list so users can collapse from either end.
  const toggleHtml = hasOverflow
    ? `<button type="button" class="vol-row vol-more" data-vol-toggle>${showAll
      ? 'Show less'
      : `Show all ${entries.length} (${entries.length - VOLUME_TABLE_INITIAL} more)`}</button>`
    : '';
  host.innerHTML = rowsHtml + toggleHtml;

  const toggle = host.querySelector('[data-vol-toggle]');
  if (toggle) {
    toggle.addEventListener('click', () => {
      volumeTableExpanded = !volumeTableExpanded;
      renderVolumeTable();
    });
  }

  for (const btn of host.querySelectorAll('.vol-export-btn')) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const label = Number(btn.dataset.exportLabel);
      const fmt = btn.dataset.exportFmt;
      if (!Number.isFinite(label)) return;
      const series = state.manifest?.series?.[state.seriesIdx];
      void import('./mesh/mesh-export.js').then((m) => m.exportLabelMesh(series, label, fmt));
    });
  }
}
