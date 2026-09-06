import { TISSUE_OPACITY } from '../core/constants.js';
import { state } from '../core/state.js';
import { allLabelsFromMeta, effectiveHiddenLabels, isSelectionActive } from '../atlas/label-selection.js';
import { getThreeRuntime } from '../runtime/viewer-runtime.js';
import { activeThreeLabelOverlay } from '../runtime/active-overlay-state.js';
import * as THREE from './vendor-three.js';
import { MAX_3D_TEXTURE_BYTES, volumeTextureSizeSupport } from './volume-texture-capabilities.js';

export function updateLabelTexture() {
  if (!state.threeRuntime.mesh) return;
  const u = state.threeRuntime.mesh.material.uniforms;
  const series = state.manifest.series[state.seriesIdx];
  const selected = activeThreeLabelOverlay(series);
  let { mode, source, colors } = selected;
  let opacities = null;
  const overlayAlpha = Number.isFinite(Number(state.overlays.overlayOpacity)) ? Number(state.overlays.overlayOpacity) : 0.5;
  u.uLabelAlpha.value = Number.isFinite(Number(selected.opacity)) ? Number(selected.opacity) : overlayAlpha;

  if (mode === 2) { opacities = {}; for (let i = 1; i < 256; i += 1) opacities[i] = overlayAlpha; }
  if (mode === 1) opacities = TISSUE_OPACITY;
  if (selected.opacities) opacities = selected.opacities;

  const lut = u.uLabelLUT.value.image.data;
  u.uHiddenLabels.value.fill(0);
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
  const material = state.threeRuntime.mesh.material;
  const textureSupport = volumeTextureSizeSupport({ W, H, D }, material.userData.max3DTextureSize);
  if (source.length !== W * H * D
    || material.userData.preview
    || !textureSupport.supported
    || material.userData.baseTextureBytes + source.byteLength > MAX_3D_TEXTURE_BYTES) {
    u.uLabelMode.value = 0;
    if (u.uIsolate) u.uIsolate.value = 0;
    u.uLabelLUT.value.needsUpdate = true;
    getThreeRuntime().requestRender?.('label-mismatch', 120);
    return;
  }

  const previous = u.uLabel.value;
  if (previous?.image.data !== source || previous.image.width !== W
    || previous.image.height !== H || previous.image.depth !== D) {
    previous?.dispose();
    const texture = new THREE.Data3DTexture(source, W, H, D);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    u.uLabel.value = texture;
  }
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
  const effHidden = effectiveHiddenLabels({
    hidden: state.hiddenLabels,
    locked: state.lockedLabels,
    allLabels: allLabelsFromMeta(state.overlays.regionMeta),
  });
  for (const idx of effHidden) {
    if (idx >= 0 && idx < 256) u.uHiddenLabels.value[idx] = 1;
  }

  if (u.uIsolate) u.uIsolate.value = (mode === 2 && isSelectionActive({ locked: state.lockedLabels })) ? 1 : 0;
  u.uLabelLUT.value.needsUpdate = true;
  getThreeRuntime().requestRender?.('label-texture', 160);
}
