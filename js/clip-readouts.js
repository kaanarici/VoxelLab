import { state } from './core/state.js';
import { $ } from './dom.js';
import { syncPanelRangeFills } from './panel-range-fills.js';

export function updateClipReadouts() {
  const p = (v) => Math.round(v * 100);
  const rng = (a, b) => `${p(a)}–${p(b)}%`;
  $('readout-low').textContent = p(state.three.lowT) + '%';
  $('readout-high').textContent = p(state.three.highT) + '%';
  $('readout-gain').textContent = state.three.intensity.toFixed(2);

  const sLow = $('s-low'); if (sLow) sLow.value = state.three.lowT;
  const sHigh = $('s-high'); if (sHigh) sHigh.value = state.three.highT;
  const sGain = $('s-gain');
  if (sGain) {
    sGain.value = state.three.intensity;
    sGain.disabled = state.three.renderMode !== 'alpha';
  }
  $('readout-clipx').textContent = rng(state.three.clipMin[0], state.three.clipMax[0]);
  $('readout-clipy').textContent = rng(state.three.clipMin[1], state.three.clipMax[1]);
  $('readout-clipz').textContent = rng(state.three.clipMin[2], state.three.clipMax[2]);
  const planeEnabled = $('s-clip-plane-enabled');
  const planeDepth = $('s-clip-plane-depth');
  const planeDepthReadout = $('readout-clip-plane-depth');
  const planeInvert = $('s-clip-plane-invert');
  const planeYaw = $('s-clip-plane-yaw');
  const planePitch = $('s-clip-plane-pitch');
  if (planeEnabled) planeEnabled.checked = !!state.three.clipPlaneEnabled;
  if (planeDepth) {
    planeDepth.value = state.three.clipPlaneDepth;
    planeDepth.disabled = !state.three.clipPlaneEnabled;
  }
  if (planeDepthReadout) planeDepthReadout.textContent = `${p(state.three.clipPlaneDepth)}%`;
  if (planeInvert) {
    planeInvert.checked = !!state.three.clipPlaneInvert;
    planeInvert.disabled = !state.three.clipPlaneEnabled;
  }
  if (planeYaw && planeYaw !== document.activeElement) planeYaw.value = state.mpr.obYaw;
  if (planePitch && planePitch !== document.activeElement) planePitch.value = state.mpr.obPitch;
  const summary = document.querySelector('#panel-3d .rp-more-summary');
  summary?.classList.toggle('clip-active', !!state.three.clipPlaneEnabled);
  syncPanelRangeFills();
}
