// "Analyze" sidebar panel: Z-projection + threshold + Analyze Particles for the active
// microscopy series. Mirrors the Hyperstack panel's dense, tool-oriented style. Results flow
// into the existing ROI Results table; a threshold/particle overlay previews on the slice.

import { $ } from '../dom.js';
import { signalPanelReady } from '../collapsible-sidebar.js';
import { state, subscribe } from '../core/state.js';
import { addOverlay } from '../plugin-overlays.js';
import { renderRoiResults } from '../roi/roi-results.js';
import {
  matchingColocalizationResult,
  matchingLineProfileResult,
  runLineProfile,
  runParticleAnalysis,
  runPixelwiseColocalization,
} from './microscopy-analysis.js';
import {
  clearAnalysisOverlay, initAnalysisOverlay, setParticleOverlay, setThresholdOverlay,
} from './microscopy-analysis-overlay.js';

let onRedraw = () => {};
let lastStatus = '';
let measurementSubscription = null;

function row(labelText, control) {
  const wrap = document.createElement('label');
  wrap.className = 'analyze-row';
  const span = document.createElement('span');
  span.className = 'analyze-row-label';
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}

function select(id, options, value) {
  const el = document.createElement('select');
  el.id = id;
  el.className = 'select-like';
  for (const [val, text] of options) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    el.append(opt);
  }
  return el;
}

function numberInput(id, value, { min = 0, step = 1 } = {}) {
  const el = document.createElement('input');
  el.type = 'number';
  el.id = id;
  el.className = 'analyze-number';
  el.value = String(value);
  el.min = String(min);
  el.step = String(step);
  return el;
}

function checkbox(id, checked) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.id = id;
  el.checked = checked;
  return el;
}

function hasRetainedPlanes(host, series) {
  return !!host?._localMicroscopyPlanes?.[series?.slug];
}

function section(title) {
  const heading = document.createElement('div');
  heading.className = 'analyze-section-title';
  heading.textContent = title;
  return heading;
}

function analysisStatus(id, text = '') {
  const el = document.createElement('div');
  el.className = 'analyze-status';
  el.id = id;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = text;
  return el;
}

function failureText(reason) {
  const messages = {
    no_active_line: 'Draw a straight-line measurement on this channel and timepoint first.',
    no_raw_plane: 'Raw planes were not retained for this active position.',
    same_channel: 'Choose two different channels.',
    invalid_threshold: 'Enter finite, nonnegative thresholds for both channels.',
    constant_intensity: 'Pearson is undefined because at least one channel is constant.',
    no_signal_above_threshold: 'No signal is strictly above one of the thresholds.',
    negative_raw_value: 'Colocalization requires nonnegative raw intensities.',
    nonfinite_raw_value: 'Raw plane contains a nonfinite intensity value.',
  };
  return messages[reason] || 'Analysis could not be computed from the active raw plane.';
}

function profilePlot(result) {
  const wrap = document.createElement('div');
  wrap.className = 'analyze-profile-plot';
  wrap.id = 'analyze-line-profile-plot';
  if (!result?.samples?.length) return wrap;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 240 118');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Raw intensity line profile across ${result.totalDistance.toFixed(3)} ${result.distanceUnit}`);
  const values = result.samples.map(sample => sample.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = result.samples.map((sample) => {
    const x = 22 + 208 * (sample.distance / result.totalDistance);
    const y = 94 - 76 * ((sample.value - lo) / span);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  axis.setAttribute('class', 'analyze-plot-axis');
  axis.setAttribute('d', 'M22 18V94H230');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('class', 'analyze-plot-line');
  line.setAttribute('points', points);
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('class', 'analyze-plot-label');
  label.setAttribute('x', '22');
  label.setAttribute('y', '111');
  label.textContent = `0–${result.totalDistance.toFixed(3)} ${result.distanceUnit} · raw ${lo.toFixed(2)}–${hi.toFixed(2)}`;
  svg.append(axis, line, label);
  wrap.append(svg);
  return wrap;
}

function channelOptions(series) {
  const channels = series?.microscopyDataset?.channels || [];
  const size = Math.max(1, Number(series?.microscopy?.sizeC || channels.length || 1));
  return Array.from({ length: size }, (_, index) => {
    const name = channels.find(channel => Number(channel?.index) === index)?.name || `Channel ${index + 1}`;
    return [String(index), `C${index + 1} ${name}`];
  });
}

export function renderMicroscopyAnalysisPanel(host = state) {
  const panel = $('microscopy-analysis-panel');
  const root = $('microscopy-analysis-controls');
  if (!panel || !root) return;
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (!series || series.imageDomain !== 'microscopy') {
    root.replaceChildren();
    panel.classList.add('panel-init-hidden');
    clearAnalysisOverlay();
    return;
  }
  panel.classList.remove('panel-init-hidden');

  const list = document.createElement('div');
  list.className = 'analyze-control-list';
  const retained = hasRetainedPlanes(host, series);
  const activeChannel = Number(series.microscopy?.channelIndex || 0);
  const activeTime = Number(series.microscopy?.timeIndex || 0);

  const projection = select('analyze-projection', [
    ['none', 'Active plane'], ['max', 'Max Z'], ['mean', 'Mean Z'], ['sum', 'Sum Z'], ['sd', 'SD Z'],
  ], 'none');
  const method = select('analyze-threshold-method', [
    ['otsu', 'Otsu'], ['triangle', 'Triangle'], ['manual', 'Manual'],
  ], 'otsu');
  const manualValue = numberInput('analyze-threshold-value', 0, { step: 'any' });
  manualValue.disabled = true;
  method.addEventListener('change', () => { manualValue.disabled = method.value !== 'manual'; });
  const darkBackground = checkbox('analyze-dark-background', true);
  const minSize = numberInput('analyze-min-size', 1, { min: 0 });
  const minCirc = numberInput('analyze-min-circularity', 0, { min: 0, step: 0.05 });
  const excludeEdges = checkbox('analyze-exclude-edges', false);

  const run = document.createElement('button');
  run.type = 'button';
  run.id = 'analyze-run';
  run.className = 'analyze-run-btn';
  run.textContent = 'Analyze particles';
  run.disabled = !retained;

  const status = document.createElement('div');
  status.className = 'analyze-status';
  status.id = 'analyze-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = retained ? lastStatus : 'Raw planes were not retained for this stack; analysis is unavailable.';

  const profileSampling = select('analyze-profile-sampling', [
    ['nearest', 'Nearest'], ['bilinear', 'Bilinear'],
  ], 'nearest');
  const profileRun = document.createElement('button');
  profileRun.type = 'button';
  profileRun.id = 'analyze-line-profile-run';
  profileRun.className = 'analyze-run-btn';
  profileRun.textContent = 'Plot active line';
  profileRun.disabled = !retained;
  const profileStatus = analysisStatus('analyze-line-profile-status');
  const profileSlot = document.createElement('div');
  profileSlot.id = 'analyze-line-profile-slot';
  const renderMatchingProfile = () => {
    const cached = matchingLineProfileResult(host, series, {
      channelIndex: activeChannel, timeIndex: activeTime, sliceIdx: host.sliceIdx || 0,
      sampling: profileSampling.value,
    });
    profileStatus.textContent = cached
      ? `${cached.samples.length} raw samples · ${cached.totalDistance.toFixed(3)} ${cached.distanceUnit} · ${cached.sampling}`
      : '';
    profileSlot.replaceChildren(profilePlot(cached));
  };
  profileSampling.addEventListener('change', renderMatchingProfile);
  renderMatchingProfile();
  profileRun.addEventListener('click', () => {
    const res = runLineProfile(host, series, {
      channelIndex: activeChannel, timeIndex: activeTime, sliceIdx: host.sliceIdx || 0,
      sampling: profileSampling.value,
    });
    if (!res.ok) {
      profileStatus.textContent = failureText(res.reason);
      profileSlot.replaceChildren(profilePlot(null));
      return;
    }
    profileStatus.textContent = `${res.samples.length} raw samples · ${res.totalDistance.toFixed(3)} ${res.distanceUnit} · ${res.sampling}`;
    profileSlot.replaceChildren(profilePlot(res));
    renderRoiResults(host);
  });

  const channels = channelOptions(series);
  const channelA = select('analyze-coloc-channel-a', channels, String(activeChannel));
  const otherChannel = channels.find(([value]) => Number(value) !== activeChannel)?.[0] || String(activeChannel);
  const channelB = select('analyze-coloc-channel-b', channels, otherChannel);
  const thresholdA = numberInput('analyze-coloc-threshold-a', '', { min: 0, step: 'any' });
  const thresholdB = numberInput('analyze-coloc-threshold-b', '', { min: 0, step: 'any' });
  thresholdA.placeholder = 'Required raw threshold';
  thresholdB.placeholder = 'Required raw threshold';
  const colocRun = document.createElement('button');
  colocRun.type = 'button';
  colocRun.id = 'analyze-coloc-run';
  colocRun.className = 'analyze-run-btn';
  colocRun.textContent = 'Compute colocalization';
  colocRun.disabled = !retained || channels.length < 2;
  const colocStatus = analysisStatus('analyze-coloc-status');
  const colocLimit = document.createElement('div');
  colocLimit.className = 'analyze-limitations';
  colocLimit.textContent = 'Raw pixel-wise Pearson plus thresholded Manders tM1/tM2. No Costes, randomization, significance, or object analysis; background and bleed-through controls matter.';
  const thresholdValue = input => input.value.trim() ? Number(input.value) : Number.NaN;
  const renderMatchingColocalization = () => {
    const cached = matchingColocalizationResult(host, series, {
      channelA: Number(channelA.value), channelB: Number(channelB.value),
      timeIndex: activeTime, sliceIdx: host.sliceIdx || 0,
      thresholdA: thresholdValue(thresholdA), thresholdB: thresholdValue(thresholdB),
    });
    colocStatus.textContent = cached
      ? `Pearson r ${cached.pearson.toFixed(4)} · tM1 ${cached.tM1.toFixed(4)} · tM2 ${cached.tM2.toFixed(4)} · n ${cached.pixels}`
      : '';
  };
  for (const control of [channelA, channelB, thresholdA, thresholdB]) {
    control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', renderMatchingColocalization);
  }
  renderMatchingColocalization();
  colocRun.addEventListener('click', () => {
    const res = runPixelwiseColocalization(host, series, {
      channelA: Number(channelA.value), channelB: Number(channelB.value),
      timeIndex: activeTime, sliceIdx: host.sliceIdx || 0,
      thresholdA: thresholdValue(thresholdA), thresholdB: thresholdValue(thresholdB),
    });
    if (!res.ok) {
      colocStatus.textContent = failureText(res.reason);
      return;
    }
    colocStatus.textContent = `Pearson r ${res.pearson.toFixed(4)} · tM1 ${res.tM1.toFixed(4)} · tM2 ${res.tM2.toFixed(4)} · n ${res.pixels}`;
    renderRoiResults(host);
  });

  run.addEventListener('click', () => {
    const channelIndex = series.microscopy?.channelIndex || 0;
    const timeIndex = series.microscopy?.timeIndex || 0;
    const proj = projection.value !== 'none' ? { mode: projection.value } : null;
    const res = runParticleAnalysis(host, series, {
      channelIndex,
      timeIndex,
      sliceIdx: host.sliceIdx || 0,
      channelName: series.microscopy?.channelName || '',
      projection: proj,
      threshold: {
        method: method.value,
        value: Number(manualValue.value),
        darkBackground: darkBackground.checked,
      },
      particle: {
        sizeRange: [Math.max(0, Number(minSize.value) || 0), Infinity],
        circularityRange: [Math.max(0, Number(minCirc.value) || 0), 1],
        excludeEdges: excludeEdges.checked,
      },
    });
    if (!res.ok) {
      lastStatus = 'No raw plane available for the active position.';
      status.textContent = lastStatus;
      return;
    }
    const overlayPos = { c: channelIndex, t: timeIndex, z: host.sliceIdx || 0, width: res.width, height: res.height };
    setThresholdOverlay({ mask: res.mask, ...overlayPos });
    setParticleOverlay({ labeledMask: res.labeledMask, ...overlayPos });
    lastStatus = `${res.summary.count} particle${res.summary.count === 1 ? '' : 's'} · mean area ${res.summary.meanArea.toFixed(1)} px`;
    status.textContent = lastStatus;
    renderRoiResults(host);
    onRedraw();
  });

  list.append(
    row('Projection', projection),
    row('Threshold', method),
    row('Manual value', manualValue),
    row('Dark background', darkBackground),
    row('Min size (px)', minSize),
    row('Min circularity', minCirc),
    row('Exclude edges', excludeEdges),
    run,
    status,
    section('Line profile'),
    row('Sampling', profileSampling),
    profileRun,
    profileStatus,
    profileSlot,
    section('Colocalization'),
    row('Channel A', channelA),
    row('Threshold A', thresholdA),
    row('Channel B', channelB),
    row('Threshold B', thresholdB),
    colocRun,
    colocStatus,
    colocLimit,
  );
  root.replaceChildren(list);
  signalPanelReady('microscopy-analysis');
}

export function initMicroscopyAnalysisPanel({ onRedraw: redraw = () => {} } = {}) {
  onRedraw = redraw;
  initAnalysisOverlay(addOverlay);
  if (!measurementSubscription) {
    measurementSubscription = subscribe('measurements', () => renderMicroscopyAnalysisPanel(state));
  }
  renderMicroscopyAnalysisPanel(state);
}
