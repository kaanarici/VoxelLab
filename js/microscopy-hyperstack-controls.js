import { $ } from './dom.js';
import { signalPanelReady } from './collapsible-sidebar.js';
import {
  channelDisplayColor,
  drawMicroscopyChannelSplit,
  ensureMicroscopyComposite,
  setMicroscopyCompositeChannelEnabled,
  setMicroscopyCompositeEnabled,
} from './microscopy-channel-composite.js';
import {
  applyDisplayRangeToChannelStacks,
  finiteDisplayRange,
} from './microscopy-display-range.js';
import {
  applyMicroscopyWorkflowRecipe,
  captureMicroscopyWorkflowRecipe,
} from './microscopy-workflow-recipe.js';
import { formatLengthFromMm } from './physical-units.js';
import { readImageByteData } from './overlay-data.js';
import { state } from './state.js';
import { enhanceSelectLikeDropdowns } from './select-like-dropdown.js';

let afterStackChange = () => {};
let workflowStatusText = '';

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

function requestCompositeRedraw(host) {
  if (Array.isArray(host?.imgs)) host.imgs = host.imgs.slice();
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

export function setMicroscopyChannelDisplayRange(series, channelIndex, range, host = state) {
  if (!canSetMicroscopyChannelDisplayRange(series, channelIndex, range, host)) return false;
  const nextRange = finiteDisplayRange(range);
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  const channel = series.microscopyDataset.channels?.find(item => Number(item?.index) === c);
  const stacks = host._localMicroscopyStacks?.[series.slug] || {};
  const stackStats = displayRangeStackStats(series, c, host);
  const updated = applyDisplayRangeToChannelStacks(stacks, c, nextRange);
  if (updated !== stackStats.total) return false;
  channel.displayRange = nextRange;
  channel.displayRangeSource = 'user';
  return true;
}

export function setMicroscopyChannelDisplayColor(series, channelIndex, color) {
  if (!series?.microscopyDataset) return false;
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  const channel = series.microscopyDataset.channels?.find(item => Number(item?.index) === c);
  const normalized = String(color || '').trim().toUpperCase();
  if (!channel || !/^#[0-9A-F]{6}$/.test(normalized)) return false;
  channel.displayColor = normalized;
  channel.displayColorSource = 'user';
  return true;
}

export function microscopyHyperstackState(host = state, activeSeries = host?.manifest?.series?.[host.seriesIdx]) {
  if (!activeSeries || activeSeries.imageDomain !== 'microscopy') return null;
  const dataset = activeSeries.microscopyDataset || null;
  const sizeC = Math.max(1, axisSize(dataset, 'c', Number(activeSeries.microscopy?.sizeC || 1)));
  const sizeT = Math.max(1, axisSize(dataset, 't', Number(activeSeries.microscopy?.sizeT || 1)));
  const current = microscopyPosition(activeSeries);
  const composite = ensureMicroscopyComposite(activeSeries, sizeC);
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

function displayRangeRow(model, series, host) {
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
    if (!setMicroscopyChannelDisplayRange(series, channel.index, nextRange, host)) {
      resetInputs();
      return;
    }
    renderMicroscopyHyperstackControls(host);
    requestCompositeRedraw(host);
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

function colorInputRow(model, series, host) {
  const channel = model.channels[model.current.c];
  const input = document.createElement('input');
  input.id = 'microscopy-channel-color';
  input.type = 'color';
  input.className = 'hyperstack-color-input';
  input.value = channel.color || '#FFFFFF';
  input.setAttribute('aria-label', 'Microscopy channel display color');
  input.addEventListener('change', () => {
    if (!setMicroscopyChannelDisplayColor(series, channel.index, input.value)) {
      input.value = channel.color || '#FFFFFF';
      return;
    }
    renderMicroscopyHyperstackControls(host);
    requestCompositeRedraw(host);
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
  const warnings = [
    ...(series.microscopyDataset?.source?.warnings || []),
    ...(series.microscopy?.sequenceWarnings || []),
  ].filter(Boolean);
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

function setWorkflowStatus(text = '') {
  workflowStatusText = String(text || '');
}

function hasKnownCalibration(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  return spacing.length >= 2 && Number(spacing[0]) > 0 && Number(spacing[1]) > 0 && series._spacingKnown !== false;
}

function axisByName(dataset = {}, name) {
  return dataset.axes?.find((axis) => axis?.name === name) || null;
}

function removeSourceWarnings(series = {}, codes = []) {
  if (!series?.microscopyDataset?.source) return;
  const blocked = new Set(codes);
  series.microscopyDataset.source.warnings = (series.microscopyDataset.source.warnings || [])
    .filter((warning) => !blocked.has(warning));
}

export function applyManualMicroscopyCalibration(
  series,
  { xUmPerPx, yUmPerPx, zUm = null } = {},
) {
  if (!series?.microscopyDataset) return false;
  const x = Number(xUmPerPx);
  const y = Number(yUmPerPx);
  const z = Number(zUm);
  if (!(x > 0) || !(y > 0)) return false;
  const rowMm = y / 1000;
  const colMm = x / 1000;
  series.pixelSpacing = [rowMm, colMm];
  series._spacingKnown = true;
  series.microscopy = series.microscopy || {};
  series.microscopy.physicalUnit = 'µm';
  series.microscopy.physicalSizeX = x;
  series.microscopy.physicalSizeY = y;
  if (z > 0) {
    const zMm = z / 1000;
    series.sliceSpacing = zMm;
    series.sliceThickness = zMm;
    series._sliceSpacingKnown = true;
    series.microscopy.physicalSizeZ = z;
  }
  const axisX = axisByName(series.microscopyDataset, 'x');
  const axisY = axisByName(series.microscopyDataset, 'y');
  const axisZ = axisByName(series.microscopyDataset, 'z');
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
  removeSourceWarnings(series, [
    'missing_xy_physical_size',
    'unsupported_x_physical_unit',
    'unsupported_y_physical_unit',
    ...(z > 0 ? ['missing_z_physical_size', 'unsupported_z_physical_unit'] : []),
  ]);
  return true;
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

function manualCalibrationRow(series, host) {
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
    const ok = applyManualMicroscopyCalibration(series, {
      xUmPerPx: x.value,
      yUmPerPx: y.value,
      zUm: z.value,
    });
    setWorkflowStatus(ok
      ? 'Calibration applied'
      : 'Set positive X and Y micrometers per pixel to calibrate this stack');
    renderMicroscopyHyperstackControls(host);
    requestCompositeRedraw(host);
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

function recipeActionsRow(model, series, host) {
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
  save.addEventListener('click', () => {
    const recipe = captureMicroscopyWorkflowRecipe(host);
    if (!recipe) {
      setWorkflowStatus('Open a microscopy series before saving a recipe');
      renderMicroscopyHyperstackControls(host);
      return;
    }
    const slug = String(series.slug || 'microscopy').replace(/[^a-z0-9_.-]+/gi, '_');
    downloadBlob(
      new Blob([`${JSON.stringify(recipe, null, 2)}\n`], { type: 'application/json;charset=utf-8' }),
      `voxellab-microscopy-workflow-${slug}.json`,
    );
    setWorkflowStatus('Workflow recipe saved');
    renderMicroscopyHyperstackControls(host);
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
    try {
      const recipe = JSON.parse(await file.text());
      const result = applyMicroscopyWorkflowRecipe(recipe, host);
      setWorkflowStatus(result.ok ? 'Workflow recipe replayed' : result.message);
      renderMicroscopyHyperstackControls(host);
      requestCompositeRedraw(host);
    } catch {
      setWorkflowStatus('Recipe file is not valid JSON');
      renderMicroscopyHyperstackControls(host);
    }
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

function compositeChannelList(model, series, host) {
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
        if (!setMicroscopyCompositeChannelEnabled(series, channel.index, input.checked, model.sizeC)) {
          input.checked = true;
          return;
        }
        renderMicroscopyHyperstackControls(host);
        requestCompositeRedraw(host);
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

export function activateMicroscopyStackPosition(c, t, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (!series || series.imageDomain !== 'microscopy') return false;
  const nextC = Math.max(0, Math.floor(Number(c || 0)));
  const nextT = Math.max(0, Math.floor(Number(t || 0)));
  const nextStack = stackForPosition(series, nextC, nextT, host);
  if (!nextStack) return false;
  const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === nextC);
  series.microscopy.channelIndex = nextC;
  series.microscopy.channelName = channel?.name || `Channel ${nextC + 1}`;
  series.microscopy.timeIndex = nextT;
  host._localStacks[series.slug] = nextStack;
  host.imgs = nextStack;
  host.sliceIdx = Math.max(0, Math.min(host.sliceIdx, nextStack.length - 1));
  renderMicroscopyHyperstackControls(host);
  afterStackChange();
  return true;
}

export function stepMicroscopyStackPosition({ channelDelta = 0, timeDelta = 0 } = {}, host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  const model = microscopyHyperstackState(host, series);
  if (!model) return false;
  const nextC = Math.max(0, Math.min(model.sizeC - 1, model.current.c + Math.trunc(Number(channelDelta) || 0)));
  const nextT = Math.max(0, Math.min(model.sizeT - 1, model.current.t + Math.trunc(Number(timeDelta) || 0)));
  if (nextC === model.current.c && nextT === model.current.t) return false;
  return activateMicroscopyStackPosition(nextC, nextT, host);
}

export function renderMicroscopyHyperstackControls(host = state) {
  const panel = $('microscopy-stack-panel');
  const root = $('microscopy-stack-controls');
  if (!panel || !root) return null;

  const series = host?.manifest?.series?.[host.seriesIdx];
  const model = microscopyHyperstackState(host, series);
  if (!model) {
    root.replaceChildren();
    panel.classList.add('panel-init-hidden');
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
    if (!activateMicroscopyStackPosition(Number(channelSelect.value), model.current.t, host)) {
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
    if (!activateMicroscopyStackPosition(model.current.c, Number(timeSelect.value), host)) {
      timeSelect.value = String(model.current.t);
    }
  });

  list.append(selectRow('Channel', channelSelect));
  list.append(channelMetaRow(model.channels[model.current.c]));
  list.append(colorInputRow(model, series, host));
  list.append(displayRangeRow(model, series, host));
  if (model.sizeC > 1) {
    list.append(checkboxRow({
      id: 'microscopy-composite-toggle',
      text: 'Composite',
      checked: model.composite.enabled,
      onChange(input) {
        setMicroscopyCompositeEnabled(series, input.checked, model.sizeC);
        renderMicroscopyHyperstackControls(host);
        requestCompositeRedraw(host);
      },
    }));
    if (model.composite.enabled) list.append(compositeChannelList(model, series, host));
    if (splitPreviewSources(model, series, host).length > 1) list.append(splitPreviewRow(model, series, host));
  }
  if (model.sizeT > 1) list.append(selectRow('Time', timeSelect));
  list.append(calibrationRow(series));
  if (!hasKnownCalibration(series)) list.append(manualCalibrationRow(series, host));
  list.append(recipeActionsRow(model, series, host));
  list.append(recipeStatusRow());

  const status = document.createElement('div');
  status.className = 'hyperstack-status';
  status.textContent = `Z ${host.sliceIdx + 1}/${model.zSize} · C ${model.current.c + 1}/${model.sizeC} · T ${model.current.t + 1}/${model.sizeT}`;
  list.append(status);
  root.replaceChildren(list);
  enhanceSelectLikeDropdowns(root);
  signalPanelReady('microscopy-stack');
  return model;
}

export function initMicroscopyHyperstackControls({ onStackChange = () => {} } = {}) {
  afterStackChange = onStackChange;
  renderMicroscopyHyperstackControls(state);
}
