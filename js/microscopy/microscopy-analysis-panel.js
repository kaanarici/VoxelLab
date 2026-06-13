// "Analyze" sidebar panel: Z-projection + threshold + Analyze Particles for the active
// microscopy series. Mirrors the Hyperstack panel's dense, tool-oriented style. Results flow
// into the existing ROI Results table; a threshold/particle overlay previews on the slice.

import { $ } from '../dom.js';
import { signalPanelReady } from '../collapsible-sidebar.js';
import { state } from '../core/state.js';
import { addOverlay } from '../plugin-overlays.js';
import { renderRoiResults } from '../roi/roi-results.js';
import { runParticleAnalysis } from './microscopy-analysis.js';
import {
  clearAnalysisOverlay, initAnalysisOverlay, setParticleOverlay, setThresholdOverlay,
} from './microscopy-analysis-overlay.js';

let onRedraw = () => {};
let lastStatus = '';

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
  );
  root.replaceChildren(list);
  signalPanelReady('microscopy-analysis');
}

export function initMicroscopyAnalysisPanel({ onRedraw: redraw = () => {} } = {}) {
  onRedraw = redraw;
  initAnalysisOverlay(addOverlay);
  renderMicroscopyAnalysisPanel(state);
}
