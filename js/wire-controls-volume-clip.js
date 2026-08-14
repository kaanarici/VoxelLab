import { state } from './core/state.js';
import { $ } from './dom.js';
import {
  setClipAxis,
  setObliqueAngles,
  setObliqueClip,
} from './core/state/viewer-commands.js';

function bindRange(id, apply) {
  const control = $(id);
  if (!control) return;
  control.addEventListener('input', () => apply(Number(control.value)));
}

function bindFiniteNumber(id, apply, currentValue) {
  const control = $(id);
  if (!control) return;
  control.addEventListener('input', () => {
    if (!control.value.trim()) return;
    const value = Number(control.value);
    if (Number.isFinite(value)) apply(value);
  });
  control.addEventListener('change', () => { control.value = currentValue(); });
}

export function wireVolumeClipControls() {
  bindRange('s-xmin', value => setClipAxis('min', 0, value));
  bindRange('s-xmax', value => setClipAxis('max', 0, value));
  bindRange('s-ymin', value => setClipAxis('min', 1, value));
  bindRange('s-ymax', value => setClipAxis('max', 1, value));
  bindRange('s-clip-plane-depth', depth => setObliqueClip({ depth }));
  bindFiniteNumber('s-clip-plane-yaw', yaw => setObliqueAngles({ yaw }), () => state.obYaw);
  bindFiniteNumber('s-clip-plane-pitch', pitch => setObliqueAngles({ pitch }), () => state.obPitch);

  const enabled = $('s-clip-plane-enabled');
  const syncDependentState = () => {
    const planeActive = !!state.clipPlaneEnabled;
    const depth = $('s-clip-plane-depth');
    const invert = $('s-clip-plane-invert');
    if (depth) depth.disabled = !planeActive;
    if (invert) invert.disabled = !planeActive;
  };
  enabled?.addEventListener('change', () => {
    setObliqueClip({ enabled: enabled.checked });
    syncDependentState();
  });
  const invert = $('s-clip-plane-invert');
  invert?.addEventListener('change', () => setObliqueClip({ invert: invert.checked }));
  $('s-clip-plane-reset')?.addEventListener('click', () => {
    setObliqueAngles({ yaw: 0, pitch: 30 });
    setObliqueClip({ enabled: false, depth: 0.5, invert: false });
  });

  setObliqueClip({
    enabled: state.clipPlaneEnabled,
    depth: state.clipPlaneDepth,
    invert: state.clipPlaneInvert,
  });
  syncDependentState();
}
