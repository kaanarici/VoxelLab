// Computed metadata derived from DICOM tags and pipeline outputs.
// Everything here is general-purpose — no hardcoded body parts,
// modality assumptions, or series-specific logic. All values are
// derived from what exists in the manifest and data files.

import { $, colorSwatchSvg, escapeHtml } from './dom.js';
import { state } from './core/state.js';
import { inPlanePixelSpacing } from './core/geometry.js';
import { signalPanelReady } from './collapsible-sidebar.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { setOverlayEnabled, setSliceIndex } from './core/state/viewer-commands.js';
import { regionMetaUrlForSeries } from './series/series-image-stack.js';

// registration.json: alignment metrics → compare-mode quality dots.
let _regData = null;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatFixed(value, digits = 1) {
  const n = finiteNumber(value);
  return n == null ? null : n.toFixed(digits);
}

export async function loadRegistrationData() {
  try {
    const r = await fetch('./data/registration.json');
    if (r.ok) _regData = await r.json();
  } catch {}
}

function firstFinite(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null) return n;
  }
  return null;
}

function registrationEntryFromData(data, slug) {
  if (!data || !slug) return null;
  const entry = data.pairs?.[slug] || data[slug];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

function finiteNumberArray(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(finiteNumber);
  return values.every((item) => item != null) ? values : null;
}

function registrationTransformType(method = '') {
  const text = String(method || '').toLowerCase();
  if (text.includes('affine')) return 'affine';
  if (text.includes('rigid')) return 'rigid';
  return '';
}

function gradeFromRegistration(verdict, mm) {
  const text = String(verdict || '').trim().toLowerCase();
  if (text === 'aligned') return 'good';
  if (text === 'slightly off') return 'fair';
  if (text === 'misregistered') return 'poor';
  if (mm == null) return 'unknown';
  return mm < 1 ? 'good' : mm < 3 ? 'fair' : 'poor';
}

export function registrationQualityFromData(data, slug) {
  const entry = registrationEntryFromData(data, slug);
  if (!entry) return null;
  const mm = firstFinite(entry.translation_magnitude_mm, entry.mean_displacement_mm, entry.meanDisp);
  const dice = firstFinite(entry.dice);
  const rotationDeg = firstFinite(entry.rotation_deg);
  const verdict = String(entry.verdict || '').trim();
  return {
    mm: mm == null ? null : +mm.toFixed(2),
    grade: gradeFromRegistration(verdict, mm),
    dice: dice == null ? null : dice,
    rotationDeg: rotationDeg == null ? null : +rotationDeg.toFixed(2),
    verdict: verdict || '',
  };
}

export function registrationRecordFromData(data, slug) {
  const entry = registrationEntryFromData(data, slug);
  if (!entry) return null;
  const method = String(data?.method || '').trim();
  const translationMm = finiteNumberArray(entry.translation_mm);
  const affineMatrix = finiteNumberArray(entry.affine_matrix || entry.transform_matrix || entry.matrix);
  const transform = {
    type: registrationTransformType(method),
    translationMm: translationMm || [],
    translationMagnitudeMm: firstFinite(entry.translation_magnitude_mm, entry.mean_displacement_mm, entry.meanDisp),
    rotationDeg: firstFinite(entry.rotation_deg),
    rotationMagnitudeMm: firstFinite(entry.rotation_magnitude_mm),
  };
  if (affineMatrix) transform.affineMatrix = affineMatrix;
  return {
    source: 'data/registration.json',
    referenceSlug: String(data?.reference || '').trim(),
    movingSlug: String(slug || '').trim(),
    method,
    antsVersion: String(data?.ants_version || data?.antsVersion || '').trim(),
    generatedAt: String(data?.generated_at || data?.generatedAt || '').trim(),
    transform,
    metrics: {
      dice: firstFinite(entry.dice),
      mseNormalized: firstFinite(entry.mse_normalized),
      mutualInformation: firstFinite(entry.mutual_information),
      runtimeSeconds: firstFinite(entry.runtime_seconds),
    },
    verdict: String(entry.verdict || '').trim(),
    quality: registrationQualityFromData(data, slug),
  };
}

function registrationRecordFromSeries(series = {}) {
  const entry = series?.registration || series?.engineReport?.registration;
  if (!entry || typeof entry !== 'object') return null;
  const method = String(entry.method || '').trim();
  const transformInput = entry.transform && typeof entry.transform === 'object' ? entry.transform : {};
  const metricsInput = entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : {};
  const translationMm = finiteNumberArray(transformInput.translationMm || entry.translation_mm);
  const transform = {
    type: String(transformInput.type || '').trim() || registrationTransformType(method),
    translationMm: translationMm || [],
    translationMagnitudeMm: firstFinite(transformInput.translationMagnitudeMm, entry.translation_magnitude_mm, entry.mean_displacement_mm),
    rotationDeg: firstFinite(transformInput.rotationDeg, entry.rotation_deg),
    rotationMagnitudeMm: firstFinite(transformInput.rotationMagnitudeMm, entry.rotation_magnitude_mm),
  };
  const verdict = String(entry.verdict || entry.quality?.verdict || '').trim();
  const quality = entry.quality && typeof entry.quality === 'object'
    ? {
        mm: firstFinite(entry.quality.mm),
        grade: String(entry.quality.grade || '').trim() || gradeFromRegistration(verdict, transform.translationMagnitudeMm),
        dice: firstFinite(entry.quality.dice, metricsInput.dice, entry.dice),
        rotationDeg: firstFinite(entry.quality.rotationDeg, transform.rotationDeg),
        verdict,
      }
    : {
        mm: transform.translationMagnitudeMm == null ? null : +transform.translationMagnitudeMm.toFixed(2),
        grade: gradeFromRegistration(verdict, transform.translationMagnitudeMm),
        dice: firstFinite(metricsInput.dice, entry.dice),
        rotationDeg: transform.rotationDeg == null ? null : +transform.rotationDeg.toFixed(2),
        verdict,
      };
  return {
    source: String(entry.source || 'series.registration').trim(),
    referenceSlug: String(entry.referenceSlug || entry.fixedSeriesUID || '').trim(),
    movingSlug: String(entry.movingSlug || series.slug || entry.movingSeriesUID || '').trim(),
    method,
    antsVersion: String(entry.antsVersion || entry.ants_version || '').trim(),
    generatedAt: String(entry.generatedAt || entry.generated_at || '').trim(),
    transform,
    metrics: {
      dice: firstFinite(metricsInput.dice, entry.dice),
      mseNormalized: firstFinite(metricsInput.mseNormalized, entry.mse_normalized),
      mutualInformation: firstFinite(metricsInput.mutualInformation, entry.mutual_information),
      runtimeSeconds: firstFinite(metricsInput.runtimeSeconds, entry.runtime_seconds),
    },
    verdict,
    quality,
  };
}

function manifestSeriesForSlug(slug) {
  const value = String(slug || '').trim();
  if (!value) return null;
  return (state.manifest?.series || []).find(series => series?.slug === value) || null;
}

export function getRegistrationQuality(slug) {
  const sidecarQuality = registrationQualityFromData(_regData, slug);
  if (sidecarQuality) return sidecarQuality;
  return registrationRecordFromSeries(manifestSeriesForSlug(slug))?.quality || null;
}

export function getRegistrationRecord(slug) {
  return registrationRecordFromData(_regData, slug)
    || registrationRecordFromSeries(manifestSeriesForSlug(slug));
}

function statsRowHtml(label, value, { id = '', tip = '' } = {}) {
  const attrs = [
    tip ? ` data-tip="${escapeHtml(tip)}" data-tip-pos="left"` : '',
  ].join('');
  const valueClass = id ? 'vv vv-link' : 'vv';
  const valueAttrs = id ? ` id="${escapeHtml(id)}"` : '';
  return `<div class="vol-row"${attrs}><span class="vk">${escapeHtml(label)}</span><span class="${valueClass}"${valueAttrs}>${escapeHtml(value)}</span></div>`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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

function downloadJson(payload, filename) {
  downloadBlob(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' }), filename);
}

function safeSeriesSlug(series) {
  return String(series?.slug || 'series').replace(/[^a-z0-9_.-]+/gi, '_');
}

function symmetryPeak(scores) {
  if (!Array.isArray(scores) || !scores.length) return null;
  let peak = null;
  for (let z = 0; z < scores.length; z++) {
    const score = finiteNumber(scores[z]);
    if (score == null) continue;
    if (!peak || score > peak.score) peak = { z, score };
  }
  return peak;
}

function quantificationRecord(metric, value, unit, source, provenance, note = '', extra = {}) {
  return { metric, value: String(value), unit, source, provenance, note, ...extra };
}

function statsSourceForSeries(series = {}) {
  const remote = String(series.statsUrl || '').trim();
  if (remote) return remote;
  const slug = String(series.slug || '').trim();
  return slug ? `data/${slug}_stats.json` : '';
}

function regionVolumeRows(stats) {
  const rows = Array.isArray(stats?.regionVolumes) ? stats.regionVolumes : [];
  return rows
    .map((region) => {
      const volume = firstFinite(region?.volumeMl, region?.volume_ml, region?.mL);
      const name = String(region?.name || region?.label || region?.id || '').trim();
      if (volume == null || !name) return null;
      return {
        id: String(region?.id || '').trim(),
        name,
        volume,
        voxels: firstFinite(region?.voxels),
      };
    })
    .filter(Boolean);
}

function quantificationRecords(series, stats) {
  if (!series || !stats || typeof stats !== 'object') return [];
  const source = statsSourceForSeries(series);
  const records = [];
  for (const region of regionVolumeRows(stats)) {
    records.push(quantificationRecord(
      `Region volume: ${region.name}`,
      formatFixed(region.volume, 1),
      'mL',
      source,
      'TotalSegmentator label voxels x voxel spacing',
      'Approximate research segmentation volume, not clinical output.',
      {
        regionId: region.id,
        voxels: region.voxels,
        sourceRegions: stats.sourceRegions || '',
      },
    ));
  }
  const peak = symmetryPeak(stats.symmetryScores);
  if (peak) {
    records.push(quantificationRecord(
      'Asymmetry peak',
      formatFixed(peak.score, 1),
      'score',
      source,
      `slice ${peak.z + 1}`,
      'Image-math left/right asymmetry from detect.py; not disease probability.',
      {
        sourceSliceIndex: peak.z,
        sourceSliceDisplay: peak.z + 1,
        visualLink: { type: 'viewer-slice', sliceIndex: peak.z, overlay: 'symmetry' },
      },
    ));
  }
  const csf = formatFixed(stats.csfTotalMl, 1);
  if (csf != null) records.push(quantificationRecord('CSF estimate', csf, 'mL', source, 'GMM CSF voxels x voxel spacing', 'Approximate, not diagnostic.'));
  const ventricle = formatFixed(stats.ventricleEstimateMl, 1);
  if (ventricle != null) records.push(quantificationRecord(
    'Ventricle estimate',
    ventricle,
    'mL',
    source,
    'opening-based CSF top-blob estimate',
    stats.ventricleNote || 'Not a true ventricular segmentation.',
  ));
  const wmh = stats.wmh && typeof stats.wmh === 'object' ? formatFixed(stats.wmh.volume_ml, 1) : null;
  if (wmh != null) records.push(quantificationRecord('WMH heuristic', wmh, 'mL', source, 'threshold estimate from sidecar stats', 'Not a validated quantitative biomarker.'));
  const microbleeds = stats.microbleeds && typeof stats.microbleeds === 'object' ? finiteNumber(stats.microbleeds.count) : null;
  if (microbleeds != null) records.push(quantificationRecord('Microbleed candidates', microbleeds, 'count', source, 'algorithmic candidates from sidecar stats', 'Requires expert review.'));
  const adcUnit = stats.adc && typeof stats.adc === 'object' ? String(stats.adc.display_unit || stats.adc.units || '').trim() : '';
  if (adcUnit) records.push(quantificationRecord('ADC display unit', adcUnit, 'unit', source, 'ADC display calibration', 'Used by ROI and hover readouts.'));
  return records;
}

function quantificationCsv(series, stats) {
  const header = ['series_slug', 'series_name', 'metric', 'value', 'unit', 'source', 'provenance', 'note'];
  const rows = quantificationRecords(series, stats).map(record => [
    series.slug || '',
    series.name || '',
    record.metric,
    record.value,
    record.unit,
    record.source,
    record.provenance,
    record.note,
  ].map(csvCell).join(','));
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

function exportQuantificationCsv(series, stats) {
  const rows = quantificationRecords(series, stats);
  if (!rows.length) return false;
  const slug = safeSeriesSlug(series);
  downloadBlob(new Blob([quantificationCsv(series, stats)], { type: 'text/csv;charset=utf-8' }), `voxellab-quantification-${slug}.csv`);
  return true;
}

function quantificationJsonPayload(series, stats) {
  return {
    schema: 'voxellab.quantification.v1',
    exportedAt: new Date().toISOString(),
    disclaimer: 'VoxelLab quantification is for research and educational review, not clinical output.',
    series: {
      slug: series?.slug || '',
      name: series?.name || '',
      modality: series?.modality || '',
      dimensions: {
        width: series?.width || 0,
        height: series?.height || 0,
        slices: series?.slices || 0,
      },
      pixelSpacing: Array.isArray(series?.pixelSpacing) ? series.pixelSpacing : [],
      sliceThickness: series?.sliceThickness || 0,
    },
    records: quantificationRecords(series, stats),
  };
}

function exportQuantificationJson(series, stats) {
  const payload = quantificationJsonPayload(series, stats);
  if (!payload.records.length) return false;
  downloadJson(payload, `voxellab-quantification-${safeSeriesSlug(series)}.json`);
  return true;
}

export function renderQuantificationPanel() {
  const panel = $('quantification-panel');
  const host = $('quantification');
  const series = state.manifest?.series?.[state.seriesIdx];
  const stats = state.stats;
  if (!panel || !host || !series || !stats) {
    if (panel) panel.hidden = true;
    return;
  }

  const rows = [];
  const peak = symmetryPeak(stats.symmetryScores);
  if (peak) {
    rows.push(statsRowHtml('Asymmetry peak', `Slice ${peak.z + 1} · score ${formatFixed(peak.score, 1)}`, {
      id: 'jump-quant-sym',
      tip: 'Image-math left/right asymmetry from detect.py; not disease probability.',
    }));
  }
  const csf = formatFixed(stats.csfTotalMl, 1);
  if (csf != null) {
    rows.push(statsRowHtml('CSF estimate', `${csf} mL`, {
      tip: 'GMM CSF voxels multiplied by voxel spacing. Approximate, not diagnostic.',
    }));
  }
  const ventricle = formatFixed(stats.ventricleEstimateMl, 1);
  if (ventricle != null) {
    rows.push(statsRowHtml('Ventricle est.', `${ventricle} mL`, {
      tip: stats.ventricleNote || 'Opening-based CSF top-blob estimate. Not a true ventricular segmentation.',
    }));
  }
  if (stats.wmh && typeof stats.wmh === 'object') {
    const wmh = formatFixed(stats.wmh.volume_ml, 1);
    if (wmh != null) {
      rows.push(statsRowHtml('WMH heuristic', `${wmh} mL`, {
        tip: 'Threshold estimate from sidecar stats; not a validated quantitative biomarker.',
      }));
    }
  }
  if (stats.microbleeds && typeof stats.microbleeds === 'object') {
    const count = finiteNumber(stats.microbleeds.count);
    if (count != null) {
      rows.push(statsRowHtml('Microbleed candidates', String(count), {
        tip: 'Algorithmic candidates from sidecar stats; requires expert review.',
      }));
    }
  }
  if (stats.adc && typeof stats.adc === 'object') {
    const unit = String(stats.adc.display_unit || stats.adc.units || '').trim();
    if (unit) rows.push(statsRowHtml('ADC unit', unit, { tip: 'ADC display calibration used by ROI and hover readouts.' }));
  }
  for (const region of regionVolumeRows(stats).slice(0, 6)) {
    rows.push(statsRowHtml(`Region ${region.name}`, `${formatFixed(region.volume, 1)} mL`, {
      tip: 'TotalSegmentator label voxels multiplied by voxel spacing. Approximate research segmentation volume, not clinical output.',
    }));
  }

  if (!rows.length) {
    panel.hidden = true;
    return;
  }

  const source = statsSourceForSeries(series);
  const sig = `${series.slug}|${JSON.stringify(stats)}`;
  if (host._quantSig !== sig) {
    host._quantSig = sig;
    host.innerHTML = `
      <div class="roi-results-actions quantification-actions">
        <button class="roi-results-export" id="quantification-export-csv" type="button" data-tip="Export quantification CSV" data-tip-pos="left" aria-label="Export quantification CSV">
          <span>CSV</span>
        </button>
        <button class="roi-results-export" id="quantification-export-json" type="button" data-tip="Export quantification JSON" data-tip-pos="left" aria-label="Export quantification JSON">
          <span>JSON</span>
        </button>
      </div>
      ${rows.join('')}
      <div class="vol-row vol-row-spaced"><span class="vk">Source</span><span class="vv">${escapeHtml(source)}</span></div>
      <div class="info-line">Series stats sidecar. Approximate research measurements, not clinical output.</div>
    `;
  }

  panel.classList.remove('panel-init-hidden');
  panel.hidden = false;
  signalPanelReady('quantification');

  const exportBtn = $('quantification-export-csv');
  if (exportBtn) exportBtn.onclick = () => exportQuantificationCsv(series, stats);
  const exportJsonBtn = $('quantification-export-json');
  if (exportJsonBtn) exportJsonBtn.onclick = () => exportQuantificationJson(series, stats);

  const jump = $('jump-quant-sym');
  if (jump && peak) {
    jump.onclick = () => {
      setSliceIndex(peak.z, series);
      if (!state.useSym && activeOverlayStateForSeries(series).heatmap.available) {
        setOverlayEnabled('useSym', true);
        void import('./overlay/overlay-stack.js').then(({ ensureOverlayStack }) => ensureOverlayStack('sym'));
        $('btn-sym')?.classList.add('active');
      }
    };
  }
}

function regionalVolumesEmptyLine(reason) {
  const hint = reason === 'zeroVolume'
    ? 'Labels did not yield any volume above the reporting threshold.'
    : 'No segmentation sidecar for this series.';
  return `<p class="rp-empty-minimal" role="status">${hint}</p>`;
}

function regionalVolumeSource(series, entry) {
  const source = String(entry?.source || '').trim();
  if (source) return source;
  return regionMetaUrlForSeries(series);
}

function regionalVolumeRecords(series, entries, total, calibrated) {
  return entries.map(entry => {
    const value = calibrated ? entry.mL : entry.voxels;
    const size = Number(value) || 0;
    return {
      labelId: String(entry.id),
      labelName: entry.name || `Label ${entry.id}`,
      value: String(value),
      unit: calibrated ? 'mL' : 'voxels',
      percent: total > 0 ? ((size / total) * 100).toFixed(1) : '',
      source: regionalVolumeSource(series, entry),
      provenance: calibrated ? 'label voxel count x calibrated voxel spacing' : 'label voxel count',
      note: calibrated
        ? 'Research measurement; not clinical output.'
        : 'Spacing not calibrated; exported voxel count instead of mL.',
    };
  });
}

function regionalVolumeCsv(series, entries, total, calibrated) {
  const header = ['series_slug', 'series_name', 'label_id', 'label_name', 'value', 'unit', 'percent_of_reported_total', 'source', 'provenance', 'note'];
  const rows = regionalVolumeRecords(series, entries, total, calibrated).map(record => [
    series?.slug || '',
    series?.name || '',
    record.labelId,
    record.labelName,
    record.value,
    record.unit,
    record.percent,
    record.source,
    record.provenance,
    record.note,
  ].map(csvCell).join(','));
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

function exportRegionalVolumeCsv(series, entries, total, calibrated) {
  if (!entries.length) return false;
  const slug = safeSeriesSlug(series);
  downloadBlob(new Blob([regionalVolumeCsv(series, entries, total, calibrated)], { type: 'text/csv;charset=utf-8' }), `voxellab-regional-volumes-${slug}.csv`);
  return true;
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
    volLine.textContent = calibrated ? '' : 'Spacing not calibrated — showing voxel counts, not volumes.';
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
  host.innerHTML = `
    <div class="roi-results-actions regional-volume-actions">
      <button class="roi-results-export" id="regional-volumes-export-csv" type="button" data-tip="Export regional volumes CSV" data-tip-pos="left" aria-label="Export regional volumes CSV">
        <span>CSV</span>
      </button>
    </div>
    ${rowsHtml}${toggleHtml}
  `;

  const exportBtn = $('regional-volumes-export-csv');
  if (exportBtn) exportBtn.onclick = () => exportRegionalVolumeCsv(series, entries, total, calibrated);

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
      void import('./mesh/mesh-export.js').then((m) => m.exportLabelMesh(series, label, fmt, { notify: true }));
    });
  }
}
