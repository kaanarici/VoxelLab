import { $ } from '../dom.js';
import { signalPanelReady } from '../collapsible-sidebar.js';
import { formatLengthFromMm } from '../core/physical-units.js';
import { state } from '../core/state.js';
import { cacheLocalRawVolume, clearLocalRawVolume } from '../local-raw-volume-cache.js';
import { readImageByteData } from '../overlay/overlay-data.js';
import { hostWritesFor, invalidateVoxelCache, isLiveViewerHost, resetThreeRuntimeSession, setSeriesImageStacks } from '../runtime/viewer-runtime.js';
import { enhanceSelectLikeDropdowns } from '../select-like-dropdown.js';
import {
  applyDisplayRangeToChannelStacks,
  finiteDisplayRange,
} from './microscopy-display-range.js';
import {
  channelDisplayColor,
  drawMicroscopyChannelSplit,
  ensureMicroscopyComposite,
  setMicroscopyCompositeChannelEnabled,
  setMicroscopyCompositeEnabled,
} from './microscopy-channel-composite.js';
import {
  microscopyCalibrationSourceText,
  microscopyCalibrationTrustText,
  microscopySourceWarningLabels,
  microscopySourceWarningsText,
} from './microscopy-provenance-text.js';
import {
  microscopyRawVolumeForPlanes,
  microscopyVolumeFailureReason,
  microscopyZCoverage,
} from './microscopy-volume.js';
import {
  hideMicroscopyAnalysisPanel,
  initMicroscopyAnalysisPanel,
  renderMicroscopyAnalysisPanel,
} from './microscopy-analysis-panel.js';

let afterStackChange = () => {};
let workflowStatusText = '';

function writeSeriesRecord(host, series, patch, writes) {
  if (!series) return series;
  return hostWritesFor(host, writes)?.patchSeries?.(host, series, patch) || null;
}

function writeDisplayStack(host, slug, stack, sliceIdx, writes) {
  return hostWritesFor(host, writes)?.displayStack?.(host, slug, stack, sliceIdx) || false;
}

function cloneDataset(dataset) {
  return dataset == null ? dataset : JSON.parse(JSON.stringify(dataset));
}

function axisSize(dataset, name, fallback = 1) {
  const axis = dataset?.axes?.find((item) => item?.name === name);
  const value = Number(axis?.size ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function microscopyPosition(series = {}) {
  return {
    c: Math.max(0, Math.floor(Number(series.microscopy?.channelIndex || 0))),
    t: Math.max(0, Math.floor(Number(series.microscopy?.timeIndex || 0))),
  };
}

function channelMetadata(dataset, index) {
  const channel = dataset?.channels?.find((item) => Number(item?.index) === index);
  const meta = {
    ...channel,
    index,
  };
  return {
    index,
    name: channel?.name || `Channel ${index + 1}`,
    color: channelDisplayColor(meta, index),
    sourceColor: channel?.color || null,
    displayColorSource: channel?.displayColorSource || (channel?.displayColor ? 'metadata' : ''),
    lut: channel?.lut || '',
    displayRange: Array.isArray(channel?.displayRange) ? channel.displayRange : null,
    displayRangeSource: channel?.displayRangeSource || '',
    emissionWavelength: channel?.emissionWavelength || null,
    emissionWavelengthUnit: channel?.emissionWavelengthUnit || '',
  };
}

function stackForPosition(series, c, t, host = state) {
  const stacks = host._localMicroscopyStacks?.[series?.slug];
  return stacks?.[`${c}|${t}`] || null;
}

function declaredMicroscopySizeZ(series = {}) {
  const axis = series.microscopyDataset?.axes?.find(item => item?.name === 'z');
  return Math.max(1, Math.floor(Number(axis?.size || series.microscopy?.sizeZ || series.slices || 1)));
}

function microscopyPlanesForPosition(series, c, t, host = state) {
  return host?._localMicroscopyPlanes?.[series?.slug]?.[`${c}|${t}`] || null;
}

function microscopyCoverageForPosition(series, c, t, host = state) {
  const key = `${c}|${t}`;
  const planes = microscopyPlanesForPosition(series, c, t, host);
  if (Array.isArray(planes)) return microscopyZCoverage(planes, declaredMicroscopySizeZ(series));
  const positions = series?.microscopy?.zPositionsByStack?.[key];
  return microscopyZCoverage(
    Array.isArray(positions) ? positions.map(z => ({ z })) : [],
    declaredMicroscopySizeZ(series),
  );
}

function replaceActiveMicroscopyRawVolume(series, volume, host = state, writes) {
  const slug = String(series?.slug || '');
  if (isLiveViewerHost(host)) {
    clearLocalRawVolume(slug);
    if (volume) cacheLocalRawVolume(slug, volume);
    invalidateVoxelCache({ dropData: true });
    resetThreeRuntimeSession();
    return;
  }
  hostWritesFor(host, writes)?.runtimeMapEntry?.(host, '_localRawVolumes', slug, volume || undefined);
}

function setMicroscopyVolumeCapability(series, { eligible, reason = '', coverage, zMm = 0 } = {}, host = state, writes) {
  const firstZ = coverage?.firstZ || 0;
  const lastZ = coverage?.lastZ || firstZ;
  return writeSeriesRecord(host, series, {
    firstIPP: [0, 0, zMm > 0 ? firstZ * zMm : 0],
    lastIPP: [0, 0, zMm > 0 ? lastZ * zMm : 0],
    sliceSpacingRegular: coverage?.complete === true,
    geometryKind: eligible ? 'volumeStack' : 'microscopyStack',
    reconstructionCapability: eligible ? 'display-volume' : '2d-only',
    renderability: eligible ? 'volume' : '2d',
    microscopy: {
      volumeEligible: !!eligible,
      volumeBlockReason: eligible ? '' : reason,
    },
  }, writes) || series;
}

function assessManualMicroscopyVolume(series, zMm, host = state) {
  const rawStacks = host?._localMicroscopyPlanes?.[series?.slug];
  const keys = [...new Set([
    ...(Array.isArray(series?.microscopy?.availablePositions) ? series.microscopy.availablePositions : []),
    ...Object.keys(rawStacks || {}),
  ])];
  const c = Math.max(0, Math.floor(Number(series?.microscopy?.channelIndex || 0)));
  const t = Math.max(0, Math.floor(Number(series?.microscopy?.timeIndex || 0)));
  const activePlanes = microscopyPlanesForPosition(series, c, t, host);
  const coverage = microscopyCoverageForPosition(series, c, t, host);
  if (!(zMm > 0)) return { eligible: false, reason: 'missing_z_calibration', coverage, rawVolume: null };
  if (declaredMicroscopySizeZ(series) < 2) {
    return { eligible: false, reason: 'insufficient_z_planes', coverage, rawVolume: null };
  }
  if (!keys.length || keys.some((key) => {
    const [stackC, stackT] = key.split('|').map(Number);
    return !microscopyCoverageForPosition(series, stackC, stackT, host).complete;
  })) {
    return { eligible: false, reason: 'incomplete_z_coverage', coverage, rawVolume: null };
  }
  if (!Array.isArray(activePlanes)) {
    return { eligible: false, reason: 'volume_source_unavailable', coverage, rawVolume: null };
  }
  try {
    return {
      eligible: true,
      reason: '',
      coverage,
      rawVolume: microscopyRawVolumeForPlanes(
        activePlanes,
        series.width,
        series.height,
        declaredMicroscopySizeZ(series),
      ),
    };
  } catch (error) {
    return { eligible: false, reason: microscopyVolumeFailureReason(error), coverage, rawVolume: null };
  }
}

function setActiveMicroscopyRawVolume(series, c, t, host = state, writes) {
  const planes = microscopyPlanesForPosition(series, c, t, host);
  let volume = null;
  let nextSeries = series;
  if (series?.microscopy?.volumeEligible === true) {
    const coverage = microscopyCoverageForPosition(series, c, t, host);
    if (!Array.isArray(planes)) {
      nextSeries = setMicroscopyVolumeCapability(series, {
        eligible: false,
        reason: 'volume_source_unavailable',
        coverage,
        zMm: Number(series.sliceSpacing || series.sliceThickness || 0),
      }, host, writes);
    } else {
      try {
        volume = microscopyRawVolumeForPlanes(planes, series.width, series.height, declaredMicroscopySizeZ(series));
      } catch (error) {
        nextSeries = setMicroscopyVolumeCapability(series, {
          eligible: false,
          reason: coverage.complete
            ? microscopyVolumeFailureReason(error)
            : 'incomplete_z_coverage',
          coverage,
          zMm: Number(series.sliceSpacing || series.sliceThickness || 0),
        }, host, writes);
      }
    }
  }
  replaceActiveMicroscopyRawVolume(nextSeries, volume, host, writes);
  return volume;
}

function requestCompositeRedraw(host, writes) {
  if (!Array.isArray(host?.imgs)) {
    afterStackChange();
    return;
  }
  if (isLiveViewerHost(host)) setSeriesImageStacks({ imgs: host.imgs.slice() });
  else hostWritesFor(host, writes)?.displayStack?.(host, '', host.imgs.slice(), host.sliceIdx);
  afterStackChange();
}

function displayRangeStackStats(series, channelIndex, host = state) {
  const stacks = host._localMicroscopyStacks?.[series?.slug] || {};
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  let total = 0;
  let raw = 0;
  for (const [key, images] of Object.entries(stacks)) {
    const [stackC] = key.split('|').map(Number);
    if (stackC !== c || !Array.isArray(images)) continue;
    total += images.length;
    raw += images.filter(image => finiteDisplayRange(image?._microscopyRawRange)).length;
  }
  return { total, raw };
}

export function canSetMicroscopyChannelDisplayRange(series, channelIndex, range, host = state) {
  if (!series?.microscopyDataset) return false;
  const nextRange = finiteDisplayRange(range);
  if (!nextRange) return false;
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  const channel = series.microscopyDataset.channels?.find(item => Number(item?.index) === c);
  if (!channel) return false;
  const stackStats = displayRangeStackStats(series, c, host);
  return stackStats.total > 0 && stackStats.raw === stackStats.total;
}

export function setMicroscopyChannelDisplayRange(series, channelIndex, range, host = state, writes) {
  if (!canSetMicroscopyChannelDisplayRange(series, channelIndex, range, host)) return false;
  const nextRange = finiteDisplayRange(range);
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  const stacks = host._localMicroscopyStacks?.[series.slug] || {};
  const stackStats = displayRangeStackStats(series, c, host);
  const updated = applyDisplayRangeToChannelStacks(stacks, c, nextRange);
  if (updated !== stackStats.total) return false;
  return !!writeSeriesRecord(host, series, {
    microscopyDataset: {
      ...cloneDataset(series.microscopyDataset),
      channels: (series.microscopyDataset.channels || []).map((item) => (
        Number(item?.index) === c
          ? { ...item, displayRange: nextRange, displayRangeSource: 'user' }
          : item
      )),
    },
  }, writes);
}

export function setMicroscopyChannelDisplayColor(series, channelIndex, color, host = state, writes) {
  if (!series?.microscopyDataset) return false;
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  const channel = series.microscopyDataset.channels?.find(item => Number(item?.index) === c);
  const normalized = String(color || '').trim().toUpperCase();
  if (!channel || !/^#[0-9A-F]{6}$/.test(normalized)) return false;
  return !!writeSeriesRecord(host, series, {
    microscopyDataset: {
      ...cloneDataset(series.microscopyDataset),
      channels: (series.microscopyDataset.channels || []).map((item) => (
        Number(item?.index) === c
          ? { ...item, displayColor: normalized, displayColorSource: 'user' }
          : item
      )),
    },
  }, writes);
}

export function microscopyHyperstackState(host = state, activeSeries = host?.manifest?.series?.[host.seriesIdx], writes) {
  if (!activeSeries || activeSeries.imageDomain !== 'microscopy') return null;
  const dataset = activeSeries.microscopyDataset || null;
  const sizeC = Math.max(1, axisSize(dataset, 'c', Number(activeSeries.microscopy?.sizeC || 1)));
  const sizeT = Math.max(1, axisSize(dataset, 't', Number(activeSeries.microscopy?.sizeT || 1)));
  const current = microscopyPosition(activeSeries);
  const composite = ensureMicroscopyComposite(activeSeries, sizeC, host, writes);
  return {
    current,
    composite,
    sizeC,
    sizeT,
    zSize: axisSize(dataset, 'z', Number(activeSeries.microscopy?.sizeZ || activeSeries.slices || 1)),
    channels: Array.from({ length: sizeC }, (_, index) => ({
      ...channelMetadata(dataset, index),
      available: !!stackForPosition(activeSeries, index, current.t, host),
    })),
    times: Array.from({ length: sizeT }, (_, index) => ({
      index,
      available: !!stackForPosition(activeSeries, current.c, index, host),
    })),
  };
}

function channelMetaRow(channel = {}) {
  const row = document.createElement('div');
  row.className = 'hyperstack-channel-meta';
  const swatch = document.createElement('span');
  swatch.className = 'hyperstack-channel-swatch';
  const color = channel.color || null;
  swatch.style.background = color || 'transparent';
  swatch.setAttribute('aria-hidden', 'true');
  if (!channel.sourceColor) swatch.classList.add('is-empty');
  const text = document.createElement('span');
  text.className = 'hyperstack-channel-text';
  const wavelength = channel.emissionWavelength
    ? ` · ${channel.emissionWavelength} ${channel.emissionWavelengthUnit || 'nm'}`
    : '';
  const lut = channel.lut && String(channel.lut).toLowerCase() !== 'gray' ? ` · LUT ${channel.lut}` : '';
  const range = metadataDisplayRangeText(channel);
  text.textContent = `${channel.name || 'Channel'}${wavelength}${lut}${range}`;
  text.title = text.textContent;
  row.append(swatch, text);
  return row;
}

function compactNumber(value) {
  if (value === '' || value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 100) return String(Math.round(n));
  return String(Math.round(n * 1000) / 1000);
}

function metadataDisplayRangeText(channel = {}) {
  if (channel.displayRangeSource !== 'metadata' || !Array.isArray(channel.displayRange)) return '';
  const [lo, hi] = channel.displayRange.map(compactNumber);
  return lo !== '' && hi !== '' ? ` · range ${lo}-${hi}` : '';
}

function numberInput({ id, value, disabled, ariaLabel, onChange }) {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'number';
  input.className = 'select-like hyperstack-range-input';
  input.inputMode = 'decimal';
  input.step = 'any';
  input.value = compactNumber(value);
  input.disabled = !!disabled;
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => onChange?.());
  return input;
}

function displayRangeRow(model, series, host, writes) {
  const channel = model.channels[model.current.c];
  const range = finiteDisplayRange(channel?.displayRange);
  const stackStats = displayRangeStackStats(series, channel.index, host);
  const disabled = !range || stackStats.total < 1 || stackStats.raw !== stackStats.total;
  const minInput = numberInput({
    id: 'microscopy-display-range-min',
    value: range?.[0] ?? '',
    disabled,
    ariaLabel: 'Microscopy display range minimum',
    onChange: apply,
  });
  const maxInput = numberInput({
    id: 'microscopy-display-range-max',
    value: range?.[1] ?? '',
    disabled,
    ariaLabel: 'Microscopy display range maximum',
    onChange: apply,
  });
  function resetInputs() {
    minInput.value = compactNumber(range?.[0]);
    maxInput.value = compactNumber(range?.[1]);
  }
  function apply() {
    const nextRange = [Number(minInput.value), Number(maxInput.value)];
    if (!setMicroscopyChannelDisplayRange(series, channel.index, nextRange, host, writes)) {
      resetInputs();
      return;
    }
    renderMicroscopyHyperstackControls(host, writes);
    requestCompositeRedraw(host, writes);
  }
  const group = document.createElement('div');
  group.className = 'hyperstack-range-group';
  group.append(minInput, maxInput);
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const label = document.createElement('label');
  label.className = 'hyperstack-label';
  label.textContent = 'Range';
  label.htmlFor = minInput.id;
  row.append(label, group);
  return row;
}

function colorInputRow(model, series, host, writes) {
  const channel = model.channels[model.current.c];
  const input = document.createElement('input');
  input.id = 'microscopy-channel-color';
  input.type = 'color';
  input.className = 'hyperstack-color-input';
  input.value = channel.color || '#FFFFFF';
  input.setAttribute('aria-label', 'Microscopy channel display color');
  input.addEventListener('change', () => {
    if (!setMicroscopyChannelDisplayColor(series, channel.index, input.value, host, writes)) {
      input.value = channel.color || '#FFFFFF';
      return;
    }
    renderMicroscopyHyperstackControls(host, writes);
    requestCompositeRedraw(host, writes);
  });
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const label = document.createElement('label');
  label.className = 'hyperstack-label';
  label.textContent = 'Color';
  label.htmlFor = input.id;
  row.append(label, input);
  return row;
}

function calibrationText(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  const rowMm = Number(spacing[0]);
  const colMm = Number(spacing[1]);
  const xyKnown = rowMm > 0 && colMm > 0 && series._spacingKnown !== false;
  const zMm = Number(series.sliceSpacing || series.sliceThickness || 0);
  const zKnown = zMm > 0 && series._sliceSpacingKnown !== false;
  const warnings = microscopySourceWarningLabels(series);
  const parts = xyKnown
    ? [`X ${formatLengthFromMm(colMm, series)}/px`, `Y ${formatLengthFromMm(rowMm, series)}/px`]
    : ['XY uncalibrated'];
  if (zKnown) parts.push(`Z ${formatLengthFromMm(zMm, series)}`);
  if (warnings.length) parts.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  return {
    text: parts.join(' · '),
    calibrated: xyKnown,
    title: warnings.length ? warnings.join(', ') : 'Physical pixel spacing from microscopy metadata',
  };
}

export function setMicroscopyWorkflowStatus(text = '') {
  workflowStatusText = String(text || '');
}

function hasKnownCalibration(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  return spacing.length >= 2 && Number(spacing[0]) > 0 && Number(spacing[1]) > 0 && series._spacingKnown !== false;
}

function axisByName(dataset = {}, name) {
  return dataset.axes?.find((axis) => axis?.name === name) || null;
}

function stripSourceWarnings(dataset, codes = []) {
  if (!dataset?.source) return dataset;
  const blocked = new Set(codes);
  return {
    ...dataset,
    source: {
      ...dataset.source,
      warnings: (dataset.source.warnings || []).filter((warning) => !blocked.has(warning)),
    },
  };
}

function setMetadataRowValue(label, value) {
  const row = [...document.querySelectorAll('#meta .meta-row')]
    .find(item => item.querySelector('.mk')?.textContent === label);
  const valueEl = row?.querySelector('.mv');
  if (valueEl) valueEl.textContent = value;
}

function refreshMetadataCalibrationRows(series = {}) {
  const row = Number(series.pixelSpacing?.[0] || 0);
  const col = Number(series.pixelSpacing?.[1] || 0);
  setMetadataRowValue('Calibration', microscopyCalibrationSourceText(series, series.pixelSpacing));
  setMetadataRowValue('Spacing trust', microscopyCalibrationTrustText(series, series.pixelSpacing));
  setMetadataRowValue('Pixel spacing', row > 0 && col > 0
    ? `${formatLengthFromMm(row, series)} × ${formatLengthFromMm(col, series)}`
    : '—');
  setMetadataRowValue('Slice thickness', series._sliceSpacingKnown && Number(series.sliceThickness || 0) > 0
    ? formatLengthFromMm(Number(series.sliceThickness), series)
    : '—');
  setMetadataRowValue('Source warnings', microscopySourceWarningsText(series));
}

export function applyManualMicroscopyCalibration(
  series,
  { xUmPerPx, yUmPerPx, zUm = null } = {},
  host = state,
  writes,
) {
  if (!series?.microscopyDataset) return false;
  const x = Number(xUmPerPx);
  const y = Number(yUmPerPx);
  const z = Number(zUm);
  if (!(x > 0) || !(y > 0)) return false;
  const rowMm = y / 1000;
  const colMm = x / 1000;
  const existingZMm = series._sliceSpacingKnown !== false
    ? Number(series.sliceSpacing || series.sliceThickness || 0)
    : 0;
  const nextZMm = z > 0 ? z / 1000 : existingZMm;
  const assessment = assessManualMicroscopyVolume(series, nextZMm, host);
  const activeC = Math.max(0, Math.floor(Number(series.microscopy?.channelIndex || 0)));
  const activeT = Math.max(0, Math.floor(Number(series.microscopy?.timeIndex || 0)));
  const activeStack = stackForPosition(series, activeC, activeT, host);
  const dataset = cloneDataset(series.microscopyDataset) || {};
  const axisX = axisByName(dataset, 'x');
  const axisY = axisByName(dataset, 'y');
  const axisZ = axisByName(dataset, 'z');
  if (axisX) {
    axisX.scale = x;
    axisX.unit = 'µm';
    axisX.known = true;
  }
  if (axisY) {
    axisY.scale = y;
    axisY.unit = 'µm';
    axisY.known = true;
  }
  if (axisZ && z > 0) {
    axisZ.scale = z;
    axisZ.unit = 'µm';
    axisZ.known = true;
  }
  const microscopy = {
    calibrationSource: 'manual',
    physicalUnit: 'µm',
    physicalSizeX: x,
    physicalSizeY: y,
  };
  if (z > 0) microscopy.physicalSizeZ = z;
  const patch = {
    pixelSpacing: [rowMm, colMm],
    _spacingKnown: true,
    microscopy,
    microscopyDataset: stripSourceWarnings(dataset, [
      'missing_xy_physical_size',
      'unsupported_x_physical_unit',
      'unsupported_y_physical_unit',
      ...(z > 0 ? ['missing_z_physical_size', 'unsupported_z_physical_unit'] : []),
    ]),
  };
  if (z > 0) {
    patch.sliceSpacing = nextZMm;
    patch.sliceThickness = nextZMm;
    patch._sliceSpacingKnown = true;
  }
  if (Array.isArray(activeStack)) patch.slices = activeStack.length;
  let nextSeries = writeSeriesRecord(host, series, patch, writes);
  if (!nextSeries) return false;
  nextSeries = setMicroscopyVolumeCapability(nextSeries, {
    ...assessment,
    zMm: nextZMm,
  }, host, writes) || nextSeries;
  replaceActiveMicroscopyRawVolume(nextSeries, assessment.rawVolume, host, writes);
  return nextSeries;
}

function calibrationRow(series = {}) {
  const model = calibrationText(series);
  const row = document.createElement('div');
  row.id = 'microscopy-calibration';
  row.className = `hyperstack-calibration${model.calibrated ? '' : ' is-uncalibrated'}`;
  row.textContent = model.text;
  row.title = model.title;
  return row;
}

function calibrationInput({ id, placeholder, value = '' }) {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'number';
  input.className = 'select-like hyperstack-calibration-input';
  input.inputMode = 'decimal';
  input.step = 'any';
  input.min = '0';
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function manualCalibrationRow(series, host, writes) {
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const label = document.createElement('label');
  label.className = 'hyperstack-label';
  label.textContent = 'Calibrate';
  const group = document.createElement('div');
  group.className = 'hyperstack-range-group';
  const x = calibrationInput({ id: 'microscopy-calibration-x', placeholder: 'X µm/px' });
  const y = calibrationInput({ id: 'microscopy-calibration-y', placeholder: 'Y µm/px' });
  const z = calibrationInput({ id: 'microscopy-calibration-z', placeholder: 'Z µm' });
  const apply = document.createElement('button');
  apply.id = 'microscopy-calibration-apply';
  apply.type = 'button';
  apply.className = 'roi-results-export';
  apply.textContent = 'Apply';
  apply.addEventListener('click', () => {
    const next = applyManualMicroscopyCalibration(series, {
      xUmPerPx: x.value,
      yUmPerPx: y.value,
      zUm: z.value,
    }, host, writes);
    setMicroscopyWorkflowStatus(next
      ? 'Calibration applied'
      : 'Set positive X and Y micrometers per pixel to calibrate this stack');
    if (next) refreshMetadataCalibrationRows(next);
    renderMicroscopyHyperstackControls(host, writes);
    requestCompositeRedraw(host, writes);
  });
  group.append(x, y, z, apply);
  row.append(label, group);
  return row;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function recipeActionsRow(model, series, host, writes) {
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const label = document.createElement('label');
  label.className = 'hyperstack-label';
  label.textContent = 'Workflow';
  const group = document.createElement('div');
  group.className = 'roi-results-actions hyperstack-recipe-actions';
  const save = document.createElement('button');
  save.id = 'microscopy-recipe-export';
  save.type = 'button';
  save.className = 'roi-results-export';
  save.textContent = 'Save recipe';
  save.addEventListener('click', async () => {
    const { captureMicroscopyWorkflowRecipe } = await import('./microscopy-workflow-recipe.js');
    const recipe = captureMicroscopyWorkflowRecipe(host);
    if (!recipe) {
      setMicroscopyWorkflowStatus('Open a microscopy series before saving a recipe');
      renderMicroscopyHyperstackControls(host, writes);
      return;
    }
    const slug = String(series.slug || 'microscopy').replace(/[^a-z0-9_.-]+/gi, '_');
    downloadBlob(
      new Blob([`${JSON.stringify(recipe, null, 2)}\n`], { type: 'application/json;charset=utf-8' }),
      `voxellab-microscopy-workflow-${slug}.json`,
    );
    setMicroscopyWorkflowStatus('Workflow recipe saved');
    renderMicroscopyHyperstackControls(host, writes);
  });
  const replay = document.createElement('button');
  replay.id = 'microscopy-recipe-import';
  replay.type = 'button';
  replay.className = 'roi-results-export';
  replay.textContent = 'Replay recipe';
  const input = document.createElement('input');
  input.id = 'microscopy-recipe-import-input';
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.hidden = true;
  replay.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let recipe = null;
    try {
      recipe = JSON.parse(await file.text());
    } catch {
      setMicroscopyWorkflowStatus('Recipe file is not valid JSON');
      renderMicroscopyHyperstackControls(host, writes);
      return;
    }
    const { applyMicroscopyWorkflowRecipe } = await import('./microscopy-workflow-recipe.js');
    const result = applyMicroscopyWorkflowRecipe(recipe, host, writes);
    setMicroscopyWorkflowStatus(result.ok ? 'Workflow recipe replayed' : result.message);
    renderMicroscopyHyperstackControls(host, writes);
    requestCompositeRedraw(host, writes);
  });
  group.append(save, replay, input);
  row.append(label, group);
  return row;
}

function recipeStatusRow() {
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const label = document.createElement('label');
  label.className = 'hyperstack-label';
  label.textContent = 'Status';
  const status = document.createElement('div');
  status.id = 'microscopy-recipe-status';
  status.className = 'roi-results-status hyperstack-recipe-status';
  status.textContent = workflowStatusText || '';
  row.append(label, status);
  return row;
}

function checkboxRow({ id, text, checked, disabled = false, onChange }) {
  const label = document.createElement('label');
  label.className = 'ui-checkbox hyperstack-checkbox';
  label.htmlFor = id;
  const toggle = document.createElement('span');
  toggle.className = 'ui-checkbox-toggle';
  const input = document.createElement('input');
  input.id = id;
  input.className = 'ui-checkbox-input';
  input.type = 'checkbox';
  input.checked = !!checked;
  input.disabled = !!disabled;
  const box = document.createElement('span');
  box.className = 'ui-checkbox-box';
  toggle.append(input, box);
  const body = document.createElement('span');
  body.className = 'hyperstack-checkbox-text';
  body.textContent = text;
  label.append(toggle, body);
  input.addEventListener('change', () => onChange?.(input));
  return label;
}

function compositeChannelList(model, series, host, writes) {
  const list = document.createElement('div');
  list.className = 'hyperstack-composite-list';
  for (const channel of model.channels) {
    const row = checkboxRow({
      id: `microscopy-composite-c${channel.index}`,
      text: `C${channel.index + 1} · ${channel.name}`,
      checked: channel.available && model.composite.channels[channel.index] !== false,
      disabled: !channel.available,
      onChange(input) {
        const hasDrawableChannel = model.channels.some((item) =>
          item.available && (item.index === channel.index ? input.checked : model.composite.channels[item.index] !== false));
        if (!hasDrawableChannel) {
          input.checked = true;
          return;
        }
        if (!setMicroscopyCompositeChannelEnabled(series, channel.index, input.checked, model.sizeC, host, writes)) {
          input.checked = true;
          return;
        }
        renderMicroscopyHyperstackControls(host, writes);
        requestCompositeRedraw(host, writes);
      },
    });
    const swatch = document.createElement('span');
    swatch.className = 'hyperstack-channel-swatch';
    swatch.style.background = channel.color;
    swatch.setAttribute('aria-hidden', 'true');
    row.prepend(swatch);
    list.append(row);
  }
  return list;
}

function splitPreviewSources(model, series, host) {
  const stacks = host._localMicroscopyStacks?.[series?.slug];
  if (!stacks || !(series?.width > 0) || !(series?.height > 0)) return [];
  return model.channels
    .filter(channel => channel.available && (!model.composite.enabled || model.composite.channels[channel.index] !== false))
    .map((channel) => {
      const img = stacks[`${channel.index}|${model.current.t}`]?.[host.sliceIdx];
      const bytes = readImageByteData(img, series.width, series.height);
      return bytes ? {
        index: channel.index,
        channel,
        bytes,
        displayRange: img?._microscopyDisplayByteRange || null,
      } : null;
    })
    .filter(Boolean);
}

function drawSplitPreview(canvas, model, series, host) {
  const sources = splitPreviewSources(model, series, host);
  if (!canvas?.getContext || sources.length < 2) return false;
  const tileGap = 1;
  canvas.width = sources.length * series.width + (sources.length - 1) * tileGap;
  canvas.height = series.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.clearRect?.(0, 0, canvas.width, canvas.height);
  return drawMicroscopyChannelSplit(ctx, series.width, series.height, {
    sources,
    window: host.window,
    level: host.level,
    invert: host.invertDisplay,
    tileGap,
  });
}

function splitPreviewRow(model, series, host) {
  const row = document.createElement('div');
  row.className = 'hyperstack-row hyperstack-split-row';
  const label = document.createElement('div');
  label.className = 'hyperstack-label';
  label.textContent = 'Split';
  const canvas = document.createElement('canvas');
  canvas.id = 'microscopy-split-preview';
  canvas.className = 'hyperstack-split-preview';
  canvas.setAttribute('aria-label', 'Microscopy split-channel preview');
  canvas.title = 'Split-channel preview for the active Z/T position';
  row.append(label, canvas);
  requestAnimationFrame(() => drawSplitPreview(canvas, model, series, host));
  return row;
}

function option(text, value, { selected = false, disabled = false } = {}) {
  const opt = document.createElement('option');
  opt.textContent = text;
  opt.value = String(value);
  opt.selected = selected;
  opt.disabled = disabled;
  return opt;
}

function selectRow(label, select) {
  const row = document.createElement('div');
  row.className = 'hyperstack-row';
  const labelEl = document.createElement('label');
  labelEl.className = 'hyperstack-label';
  labelEl.textContent = label;
  labelEl.htmlFor = select.id;
  row.append(labelEl, select);
  return row;
}

export function activateMicroscopyStackPosition(c, t, host = state, writes) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (!series || series.imageDomain !== 'microscopy') return false;
  const nextC = Math.max(0, Math.floor(Number(c || 0)));
  const nextT = Math.max(0, Math.floor(Number(t || 0)));
  const nextStack = stackForPosition(series, nextC, nextT, host);
  if (!nextStack) return false;
  const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === nextC);
  let nextSeries = writeSeriesRecord(host, series, {
    slices: nextStack.length,
    microscopy: {
      channelIndex: nextC,
      channelName: channel?.name || `Channel ${nextC + 1}`,
      timeIndex: nextT,
    },
  }, writes);
  if (!nextSeries) return false;
  writeDisplayStack(host, nextSeries.slug, nextStack, Math.max(0, Math.min(host.sliceIdx, nextStack.length - 1)), writes);
  const coverage = microscopyCoverageForPosition(nextSeries, nextC, nextT, host);
  nextSeries = setMicroscopyVolumeCapability(nextSeries, {
    eligible: nextSeries.microscopy.volumeEligible === true && coverage.complete,
    reason: coverage.complete ? nextSeries.microscopy.volumeBlockReason : 'incomplete_z_coverage',
    coverage,
    zMm: Number(nextSeries.sliceSpacing || nextSeries.sliceThickness || 0),
  }, host, writes);
  setActiveMicroscopyRawVolume(nextSeries, nextC, nextT, host, writes);
  renderMicroscopyHyperstackControls(host, writes);
  afterStackChange();
  return true;
}

export function stepMicroscopyStackPosition({ channelDelta = 0, timeDelta = 0 } = {}, host = state, writes) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const model = microscopyHyperstackState(host, series, writes);
  if (!model) return false;
  const nextC = Math.max(0, Math.min(model.sizeC - 1, model.current.c + Math.trunc(Number(channelDelta) || 0)));
  const nextT = Math.max(0, Math.min(model.sizeT - 1, model.current.t + Math.trunc(Number(timeDelta) || 0)));
  if (nextC === model.current.c && nextT === model.current.t) return false;
  return activateMicroscopyStackPosition(nextC, nextT, host, writes);
}

export function renderMicroscopyHyperstackControls(host = state, writes) {
  const panel = $('microscopy-stack-panel');
  const root = $('microscopy-stack-controls');
  if (!panel || !root) return null;

  const series = host?.manifest?.series?.[host.seriesIdx];
  const model = microscopyHyperstackState(host, series, writes);
  if (!model) {
    root.replaceChildren();
    panel.classList.add('panel-init-hidden');
    hideMicroscopyAnalysisPanel(host);
    return null;
  }

  panel.classList.remove('panel-init-hidden');
  const list = document.createElement('div');
  list.className = 'hyperstack-control-list';

  const channelSelect = document.createElement('select');
  channelSelect.id = 'microscopy-channel-select';
  channelSelect.className = 'select-like hyperstack-select';
  channelSelect.setAttribute('aria-label', 'Microscopy channel');
  for (const channel of model.channels) {
    channelSelect.append(option(
      `C${channel.index + 1} · ${channel.name}`,
      channel.index,
      { selected: channel.index === model.current.c, disabled: !channel.available },
    ));
  }
  channelSelect.disabled = model.sizeC <= 1;
  channelSelect.addEventListener('change', () => {
    if (!activateMicroscopyStackPosition(Number(channelSelect.value), model.current.t, host, writes)) {
      channelSelect.value = String(model.current.c);
    }
  });

  const timeSelect = document.createElement('select');
  timeSelect.id = 'microscopy-time-select';
  timeSelect.className = 'select-like hyperstack-select';
  timeSelect.setAttribute('aria-label', 'Microscopy timepoint');
  for (const time of model.times) {
    timeSelect.append(option(
      `T${time.index + 1}`,
      time.index,
      { selected: time.index === model.current.t, disabled: !time.available },
    ));
  }
  timeSelect.disabled = model.sizeT <= 1;
  timeSelect.addEventListener('change', () => {
    if (!activateMicroscopyStackPosition(model.current.c, Number(timeSelect.value), host, writes)) {
      timeSelect.value = String(model.current.t);
    }
  });

  list.append(selectRow('Channel', channelSelect));
  list.append(channelMetaRow(model.channels[model.current.c]));
  list.append(colorInputRow(model, series, host, writes));
  list.append(displayRangeRow(model, series, host, writes));
  if (model.sizeC > 1) {
    list.append(checkboxRow({
      id: 'microscopy-composite-toggle',
      text: 'Composite',
      checked: model.composite.enabled,
      onChange(input) {
        setMicroscopyCompositeEnabled(series, input.checked, model.sizeC, host, writes);
        renderMicroscopyHyperstackControls(host, writes);
        requestCompositeRedraw(host, writes);
      },
    }));
    if (model.composite.enabled) list.append(compositeChannelList(model, series, host, writes));
    if (splitPreviewSources(model, series, host).length > 1) list.append(splitPreviewRow(model, series, host));
  }
  if (model.sizeT > 1) list.append(selectRow('Time', timeSelect));
  list.append(calibrationRow(series));
  if (!hasKnownCalibration(series)) list.append(manualCalibrationRow(series, host, writes));
  list.append(recipeActionsRow(model, series, host, writes));
  list.append(recipeStatusRow());

  const status = document.createElement('div');
  status.className = 'hyperstack-status';
  status.textContent = `Z ${host.sliceIdx + 1}/${model.zSize} · C ${model.current.c + 1}/${model.sizeC} · T ${model.current.t + 1}/${model.sizeT}`;
  list.append(status);
  root.replaceChildren(list);
  enhanceSelectLikeDropdowns(root);
  signalPanelReady('microscopy-stack');
  renderMicroscopyAnalysisPanel(host);
  return model;
}

export function initMicroscopyHyperstackControls({ onStackChange = () => {} } = {}) {
  afterStackChange = onStackChange;
  initMicroscopyAnalysisPanel({ onRedraw: afterStackChange });
  renderMicroscopyHyperstackControls(state);
}
