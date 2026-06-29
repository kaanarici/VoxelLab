import { state } from '../core/state.js';
import { effectiveSliceSpacing } from '../mpr/mpr-geometry.js';
import { setClipRange } from '../core/state/viewer-commands.js';
import { endPerfTrace, hasPendingPerfTrace } from '../core/perf-trace.js';
import { initOverlayVolumes } from '../overlay/overlay-volumes.js';
import {
  getThreeRuntime,
  setThreePreviewShown,
  setThreeRuntimeMesh,
} from '../runtime/viewer-runtime.js';
import { syncThreeSurfaceState as syncThreeSurfaceReadiness } from '../runtime/three-surface-state.js';
import { syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { ensureHRVoxels, initHrVoxelsLoading } from './volume-hr-voxels.js';
import { ensureVoxels, initEnsureVoxels } from './volume-voxels-ensure.js';
import { computeGradientInWorker } from './volume-worker-client.js';

// Cap on the precomputed gradient texture (RGBA8). Volumes whose gradient would
// exceed this fall back to the in-shader 6-tap gradient + motion step-LOD; ones
// that fit render at full quality even while orbiting.
const GRAD_MEM_BUDGET = 256 * 1024 * 1024;

let _renderVolumes = () => {};
let _hideHover = () => {};
let _is3dActive = () => false;
let _isMprActive = () => false;
let _drawMPR = () => {};
let _updateClipReadouts = () => {};
let _threeModules = null;
const _maskedHrCache = new Map();
const MASKED_HR_CACHE_LIMIT = 3;

function loadThreeModules() {
  if (!_threeModules) {
    _threeModules = Promise.all([
      import('./vendor-three.js'),
      import('./volume-3d-hover.js'),
      import('./volume-3d-views.js'),
      import('./volume-three-bootstrap.js'),
      import('./volume-label-overlay.js'),
      import('./volume-raycast-material.js'),
    ]).then(([THREE, hover, views, bootstrap, label, material]) => {
      hover.initVolume3DHover({ hideHover: _hideHover });
      return {
        THREE,
        setThreeDView: views.setThreeDView,
        ensureThreeRenderer: bootstrap.ensureThreeRenderer,
        updateLabelTexture: label.updateLabelTexture,
        createVolumeRaycastMaterial: material.createVolumeRaycastMaterial,
      };
    }).catch((error) => {
      _threeModules = null;
      throw error;
    });
  }
  return _threeModules;
}

function rememberMaskedHrCache(key, value) {
  if (_maskedHrCache.has(key)) _maskedHrCache.delete(key);
  _maskedHrCache.set(key, value);
  while (_maskedHrCache.size > MASKED_HR_CACHE_LIMIT) {
    _maskedHrCache.delete(_maskedHrCache.keys().next().value);
  }
  return value;
}

function requestThreeRender(reason = 'update', burstMs = 0) {
  getThreeRuntime().requestRender?.(reason, burstMs);
}

export function syncThreeSurfaceState(series = state.manifest?.series?.[state.seriesIdx]) {
  return syncThreeSurfaceReadiness(series);
}

/** Wire orchestration callbacks from `viewer.js` after the shared viewer functions exist. */
export function initVolume3D(deps) {
  _renderVolumes = deps.renderVolumes;
  _hideHover = deps.hideHover;
  _is3dActive = deps.is3dActive;
  _isMprActive = deps.isMprActive;
  _drawMPR = deps.drawMPR;
  _updateClipReadouts = deps.updateClipReadouts;

  initEnsureVoxels({ renderVolumes: deps.renderVolumes });
  initHrVoxelsLoading({
    is3dActive: deps.is3dActive,
    isMprActive: deps.isMprActive,
    drawMPR: deps.drawMPR,
    rebuildVolume: buildVolume,
  });
  initOverlayVolumes({
    onReady: () => {
      if (_isMprActive()) _drawMPR();
      if (_is3dActive()) buildVolume();
      _renderVolumes();
      syncThreeSurfaceState();
    },
  });
}

export { ensureVoxels, ensureHRVoxels };

export async function setThreeDView(view) {
  const { setThreeDView: applyThreeDView } = await loadThreeModules();
  applyThreeDView(view);
}

// When scrubbing in 3D mode, cut the volume at the current slice (Z) so the
// slider dissects the brain depth-wise. Mirror also moves clipMax[2].
/** Mirror the 2D slice scrubber onto the 3D clip plane while 3D mode is active. */
export function sync3DScrubber() {
  if (!_is3dActive()) return;
  const series = state.manifest.series[state.seriesIdx];
  const cz = (state.sliceIdx + 1) / series.slices;
  setClipRange(state.clipMin, [
    state.clipMax[0],
    state.clipMax[1],
    Math.max(state.clipMin[2] + 0.001, Math.min(1, cz)),
  ]);
  requestThreeRender('slice-scrub', 120);
}

/** Push threshold, intensity, clip, and render-mode changes into the live raycast uniforms. */
export function updateUniforms() {
  const three = getThreeRuntime();
  if (!three.mesh) return;
  const u = three.mesh.material.uniforms;
  u.uLowT.value = state.lowT;
  u.uHighT.value = state.highT;
  u.uIntensity.value = state.intensity;
  u.uClipMin.value.fromArray(state.clipMin);
  u.uClipMax.value.fromArray(state.clipMax);
  if (u.uMode) {
    u.uMode.value = state.renderMode === 'mip' ? 1 : state.renderMode === 'minip' ? 2 : 0;
  }
  requestThreeRender('uniforms', 120);
}

/** Ensure the Three.js renderer shell exists before any volume upload begins. */
export async function ensureThree() {
  const { ensureThreeRenderer } = await loadThreeModules();
  ensureThreeRenderer({
    is3dActive: _is3dActive,
    hideHover: _hideHover,
  });
  requestThreeRender('ensure-three', 160);
}

/** Build or reuse the active 3D volume texture from PNG voxels or HR raw data. */
export async function buildVolume() {
  const threeModules = await loadThreeModules();
  const { THREE } = threeModules;
  const three = getThreeRuntime();
  if (!three.renderer) return;
  const variant = state.useBrain ? 'brain' : 'base';
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;

  // Optional small preview raw: show first, then replace with full-res from R2.
  if (series.hasPreview && series.previewDims && !three.previewShown) {
    try {
      const [pw, ph, pd] = series.previewDims;
      const r = await fetch(`./data/${series.slug}_preview.raw`);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        const preview = new Uint8Array(buf);
        if (preview.length === pw * ph * pd) {
          uploadVolumeTexture(preview, THREE.UnsignedByteType, pw, ph, pd, series, '', threeModules);
          setThreePreviewShown(true);
          // Continue to load full-res below (don't return)
        }
      }
    } catch { /* preview failed — fall through to full-res */ }
  }

  if (!ensureVoxels()) {
    syncThreeSurfaceState(series);
    return;
  }

  let volumeData = state.voxels;
  let textureType = THREE.UnsignedByteType;
  let dataKey = `vox:${state.voxelsKey}`;

  const hr = await ensureHRVoxels();
  if (hr) {
    const applyMask = state.useBrain && state.voxels && state.voxels.length === hr.length;
    if (applyMask) {
      const maskKey = `${series.slug}|${state.hrKey}|${state.voxelsKey}|brain`;
      let masked = _maskedHrCache.get(maskKey);
      if (!masked) {
        masked = new Float32Array(hr.length);
        const mask = state.voxels;
        for (let i = 0; i < hr.length; i++) masked[i] = mask[i] === 0 ? 0 : hr[i];
        rememberMaskedHrCache(maskKey, masked);
      }
      volumeData = masked;
    } else {
      volumeData = hr;
    }
    textureType = THREE.FloatType;
    dataKey = `hr:${state.hrKey}`;
  }
  setThreePreviewShown(false); // full-res loaded, clear preview flag

  const nextDataKey = `${variant}|${dataKey}`;
  if (three.dataKey === nextDataKey && three.mesh) {
    await updateLabelTexture();
    syncViewerRuntimeSession(series);
    syncThreeSurfaceState(series);
    requestThreeRender('reuse-volume', 120);
    return;
  }

  uploadVolumeTexture(volumeData, textureType, W, H, D, series, nextDataKey, threeModules);
  syncThreeSurfaceState(series);
}

/**
 * Decide whether a volume gets the precomputed normal+edge gradient (full
 * quality at all times) or the in-shader 6-tap fallback + motion step-LOD, then
 * compute the gradient off-thread and swap it into the live material when ready.
 */
function buildGradientTexture(material, volumeData, textureType, W, H, D, THREE) {
  // Start on the motion step-LOD so orbiting stays smooth while the gradient
  // bakes (and permanently for volumes too large to bake, or if the worker
  // fails). A fitting volume drops the LOD only once its baked gradient lands,
  // after which it renders full quality even in motion. Still frames are always
  // full quality regardless, since the settle frame never uses the draft path.
  material.userData.progressive = true;
  const gradFits = W * H * D * 4 <= GRAD_MEM_BUDGET;
  if (!gradFits) return;

  const isFloat = textureType === THREE.FloatType;
  computeGradientInWorker(volumeData, W, H, D, isFloat)
    .then((rgba) => {
      // The mesh may have been replaced while the worker ran — drop the result.
      if (!rgba || getThreeRuntime().mesh?.material !== material) return;
      const gradTex = new THREE.Data3DTexture(rgba, W, H, D);
      gradTex.format = THREE.RGBAFormat;
      gradTex.type = THREE.UnsignedByteType;
      gradTex.minFilter = THREE.LinearFilter;
      gradTex.magFilter = THREE.LinearFilter;
      gradTex.unpackAlignment = 4;
      gradTex.needsUpdate = true;
      material.uniforms.uGrad.value?.dispose?.();
      material.uniforms.uGrad.value = gradTex;
      material.uniforms.uHasGrad.value = 1;
      material.userData.progressive = false; // baked gradient → full quality in motion
      requestThreeRender('gradient-ready', 160);
    })
    .catch(() => { /* worker failed: stay on the 6-tap + motion step-LOD fallback */ });
}

/** Upload a volume array as a 3D texture and create/replace the mesh. */
function uploadVolumeTexture(volumeData, textureType, W, H, D, series, dataKey, threeModules) {
  const { THREE, createVolumeRaycastMaterial } = threeModules;
  const texture = new THREE.Data3DTexture(volumeData, W, H, D);
  texture.format = THREE.RedFormat;
  texture.type = textureType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  const sx = W * (series.pixelSpacing?.[1] || 1);
  const sy = H * (series.pixelSpacing?.[0] || 1);
  const sz = D * effectiveSliceSpacing(series);
  const m = Math.max(sx, sy, sz);

  const dummyLabel = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  dummyLabel.format = THREE.RedFormat;
  dummyLabel.type = THREE.UnsignedByteType;
  dummyLabel.minFilter = THREE.NearestFilter;
  dummyLabel.magFilter = THREE.NearestFilter;
  dummyLabel.unpackAlignment = 1;
  dummyLabel.needsUpdate = true;

  const dummyGrad = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  dummyGrad.format = THREE.RGBAFormat;
  dummyGrad.type = THREE.UnsignedByteType;
  dummyGrad.minFilter = THREE.NearestFilter;
  dummyGrad.magFilter = THREE.NearestFilter;
  dummyGrad.unpackAlignment = 4;
  dummyGrad.needsUpdate = true;

  const lutData = new Uint8Array(256 * 4);
  const lutTex = new THREE.DataTexture(
    lutData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  lutTex.minFilter = THREE.NearestFilter;
  lutTex.magFilter = THREE.NearestFilter;
  lutTex.generateMipmaps = false;
  lutTex.needsUpdate = true;

  const material = createVolumeRaycastMaterial({
    texture,
    dummyLabel,
    dummyGrad,
    lutTex,
    width: W,
    height: H,
    depth: D,
    lowT: state.lowT,
    highT: state.highT,
    intensity: state.intensity,
    clipMin: state.clipMin,
    clipMax: state.clipMax,
    renderMode: state.renderMode,
  });

  const three = getThreeRuntime();
  if (three.mesh) {
    three.scene.remove(three.mesh);
    three.mesh.geometry.dispose();
    const oldUni = three.mesh.material.uniforms;
    three.mesh.material.dispose();
    if (oldUni.uVolume   && oldUni.uVolume.value)   oldUni.uVolume.value.dispose();
    if (oldUni.uLabel    && oldUni.uLabel.value)    oldUni.uLabel.value.dispose();
    if (oldUni.uLabelLUT && oldUni.uLabelLUT.value) oldUni.uLabelLUT.value.dispose();
    if (oldUni.uGrad     && oldUni.uGrad.value)     oldUni.uGrad.value.dispose();
  }

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(sx / m, sy / m, sz / m);
  three.scene.add(mesh);
  setThreeRuntimeMesh(mesh, {
    seriesIdx: state.seriesIdx,
    variant: state.useBrain ? 'brain' : 'base',
    dataKey,
  });
  buildGradientTexture(material, volumeData, textureType, W, H, D, THREE);
  syncViewerRuntimeSession(series);
  sync3DScrubber();
  updateUniforms();
  void updateLabelTexture();
  _updateClipReadouts();
  syncThreeSurfaceState(series);
  requestThreeRender('upload-volume', 220);
  if (hasPendingPerfTrace('enter-3d')) {
    endPerfTrace('enter-3d', { slug: series.slug, width: W, height: H, depth: D });
  }
}

export async function updateLabelTexture() {
  if (!getThreeRuntime().mesh) return;
  const { updateLabelTexture: applyLabelTexture } = await loadThreeModules();
  applyLabelTexture();
}
