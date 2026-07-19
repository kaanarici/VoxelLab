
import { TISSUE_OPACITY } from '../core/constants.js';
import { state } from '../core/state.js';
import { allLabelsFromMeta, effectiveHiddenLabels, isSelectionActive } from '../atlas/label-selection.js';
import { getThreeRuntime } from '../runtime/viewer-runtime.js';
import { activeThreeLabelOverlay } from '../runtime/active-overlay-state.js';
import * as THREE from './vendor-three.js';

// Swap the label texture + color LUT based on the currently-active overlay
// toggles. Called whenever the user flips Tissue or Anatomy while 3D mode
// is live, and from buildVolume() after the main texture is uploaded.
export function updateLabelTexture() {
  if (!state.threeRuntime.mesh) return;
  const u = state.threeRuntime.mesh.material.uniforms;
  const series = state.manifest.series[state.seriesIdx];
  const selected = activeThreeLabelOverlay(series);
  let { mode, source, colors } = selected;
  let opacities = null;
  const overlayAlpha = Number.isFinite(Number(state.overlayOpacity)) ? Number(state.overlayOpacity) : 0.5;
  u.uLabelAlpha.value = Number.isFinite(Number(selected.opacity)) ? Number(selected.opacity) : overlayAlpha;
  // Anatomy regions: drive per-label LUT alpha from the overlay-opacity slider
  // (previously a flat constant, so the slider did nothing in 3D).
  if (mode === 2) { opacities = {}; for (let i = 1; i < 256; i += 1) opacities[i] = overlayAlpha; }
  if (mode === 1) opacities = TISSUE_OPACITY;
  if (selected.opacities) opacities = selected.opacities;

  const lut = u.uLabelLUT.value.image.data;
  for (let i = 0; i < lut.length; i += 4) {
    lut[i] = 0; lut[i + 1] = 0; lut[i + 2] = 0; lut[i + 3] = 255;
  }

  if (mode === 0 || !source) {
    u.uLabelMode.value = 0;
    if (u.uIsolate) u.uIsolate.value = 0;
    u.uLabelLUT.value.needsUpdate = true;
    getThreeRuntime().requestRender?.('label-off', 120);
    return;
  }

  const W = series.width, H = series.height, D = series.slices;
  if (source.length !== W * H * D) {
    u.uLabelMode.value = 0;
    if (u.uIsolate) u.uIsolate.value = 0;
    u.uLabelLUT.value.needsUpdate = true;
    getThreeRuntime().requestRender?.('label-mismatch', 120);
    return;
  }

  if (u.uLabel.value) u.uLabel.value.dispose();
  const lt = new THREE.Data3DTexture(source, W, H, D);
  lt.format = THREE.RedFormat;
  lt.type = THREE.UnsignedByteType;
  lt.minFilter = THREE.NearestFilter;
  lt.magFilter = THREE.NearestFilter;
  lt.unpackAlignment = 1;
  lt.needsUpdate = true;
  u.uLabel.value = lt;
  u.uLabelMode.value = mode;

  if (colors) {
    for (const k in colors) {
      const idx = +k;
      if (!Number.isFinite(idx) || idx < 0 || idx > 255) continue;
      const c = colors[k];
      if (!c) continue;
      const base = idx * 4;
      lut[base]     = c[0];
      lut[base + 1] = c[1];
      lut[base + 2] = c[2];
      lut[base + 3] = 255;
    }
  }
  if (opacities) {
    for (const k in opacities) {
      const idx = +k;
      if (!Number.isFinite(idx) || idx < 0 || idx > 255) continue;
      lut[idx * 4 + 3] = Math.round(opacities[k] * 255);
    }
  }
  // Isolate to the locked/previewed selection when active; otherwise this is the
  // raw user-hidden set (no behavior change for users who never touch a pill).
  const effHidden = effectiveHiddenLabels({
    hidden: state.hiddenLabels,
    locked: state.lockedLabels,
    preview: state.previewLabel,
    allLabels: allLabelsFromMeta(state.regionMeta),
  });
  for (const idx of effHidden) {
    if (idx >= 0 && idx < 256) lut[idx * 4 + 3] = 0;
  }
  // When a selection is active, the raycast renders ONLY the visible labels'
  // voxels (skips the unlabelled body + hidden labels) so the model truly
  // isolates to the structure(s), not just the colour. Regions mode only.
  if (u.uIsolate) u.uIsolate.value = (mode === 2 && isSelectionActive({ locked: state.lockedLabels, preview: state.previewLabel })) ? 1 : 0;
  u.uLabelLUT.value.needsUpdate = true;
  getThreeRuntime().requestRender?.('label-texture', 160);
}

