import { state } from '../core/state.js';
import { notify } from '../notify.js';
import { volumeDisplayExtents, volumeDisplayScale } from '../core/geometry.js';
import { effectiveSliceSpacing } from '../mpr/mpr-geometry.js';
import { endPerfTrace, hasPendingPerfTrace } from '../core/perf-trace.js';
import { raycastStepCount, volumeProjectionSamplingSupport } from '../core/volume-limits.js';
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
import { volumeClipPlane } from './volume-clip-plane.js';
let _renderVolumes = () => {};
let _hideHover = () => {};
let _is3dActive = () => false;
let _isMprActive = () => false;
let _drawMPR = () => {};
let _updateClipReadouts = () => {};
let _threeModules = null;

function loadThreeModules() {
  if (!_threeModules) {
    _threeModules = Promise.all([
      import('./vendor-three.js'),
      import('./volume-3d-hover.js'),
      import('./volume-3d-views.js'),
      import('./volume-three-bootstrap.js'),
      import('./volume-label-overlay.js'),
      import('./volume-raycast-material.js'),
      import('./volume-texture-capabilities.js'),
    ]).then(([THREE, hover, views, bootstrap, label, material, capabilities]) => {
      hover.initVolume3DHover({ hideHover: _hideHover });
      return {
        THREE,
        MAX_3D_BASE_TEXTURE_BYTES: capabilities.MAX_3D_BASE_TEXTURE_BYTES,
        rendererMax3DTextureSize: capabilities.rendererMax3DTextureSize,
        volumeTextureSizeSupport: capabilities.volumeTextureSizeSupport,
        setThreeDView: views.setThreeDView,
        ensureThreeRenderer: bootstrap.ensureThreeRenderer,
        stopThreeTurntable: bootstrap.stopThreeTurntable,
        toggleThreeTurntable: bootstrap.toggleThreeTurntable,
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

function requestThreeRender(reason = 'update', burstMs = 0) {
  getThreeRuntime().requestRender?.(reason, burstMs);
}

function disposeCurrentVolumeMesh(three) {
  if (!three.mesh) return;
  three.scene?.remove?.(three.mesh);
  three.mesh.geometry?.dispose?.();
  const material = three.mesh.material;
  const uniforms = material?.uniforms || {};
  material?.dispose?.();
  for (const key of ['uVolume', 'uLabel', 'uLabelLUT']) uniforms[key]?.value?.dispose?.();
  setThreeRuntimeMesh(null, { seriesIdx: -1, variant: '', dataKey: '' });
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
  const { setThreeDView: applyThreeDView, stopThreeTurntable } = await loadThreeModules();
  stopThreeTurntable();
  applyThreeDView(view);
}

export async function toggleThreeTurntable() {
  const { toggleThreeTurntable: applyToggle } = await loadThreeModules();
  return applyToggle();
}

/** Push threshold, intensity, clip, and render-mode changes into the live raycast uniforms. */
export function updateUniforms() {
  const three = getThreeRuntime();
  if (!three.mesh) return;
  const u = three.mesh.material.uniforms;
  u.uLowT.value = state.three.lowT;
  u.uHighT.value = state.three.highT;
  u.uIntensity.value = state.three.intensity;
  u.uClipMin.value.fromArray(state.three.clipMin);
  u.uClipMax.value.fromArray(state.three.clipMax);
  const series = state.manifest?.series?.[state.seriesIdx];
  if (series && u.uClipPlane) {
    u.uClipPlane.value.fromArray(volumeClipPlane({
      dims: { W: series.width, H: series.height, D: series.slices },
      spacing: {
        row: series.pixelSpacing?.[0] || 1,
        col: series.pixelSpacing?.[1] || 1,
        slice: effectiveSliceSpacing(series),
      },
      yaw: state.mpr.obYaw,
      pitch: state.mpr.obPitch,
      depth: state.three.clipPlaneDepth,
      invert: state.three.clipPlaneInvert,
    }));
    u.uClipPlaneEnabled.value = state.three.clipPlaneEnabled ? 1 : 0;
  }
  if (u.uMode) {
    u.uMode.value = state.three.renderMode === 'mip' ? 1 : state.three.renderMode === 'minip' ? 2 : 0;
    const textureDims = three.mesh.material.userData.textureDims || {};
    const steps = raycastStepCount({
      width: textureDims.width || series?.width,
      height: textureDims.height || series?.height,
      depth: textureDims.depth || series?.slices,
    });
    u.uSteps.value = steps;
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
  const {
    THREE,
    MAX_3D_BASE_TEXTURE_BYTES,
    rendererMax3DTextureSize,
    volumeTextureSizeSupport,
  } = threeModules;
  const three = getThreeRuntime();
  if (!three.renderer) return;
  const variant = state.overlays.useBrain ? 'brain' : 'base';
  const series = state.manifest.series[state.seriesIdx];
  const W = series.width, H = series.height, D = series.slices;
  const maxTextureSize = rendererMax3DTextureSize(three.renderer);
  const supportFor = (dims) => {
    const texture = volumeTextureSizeSupport(dims, maxTextureSize);
    if (!texture.supported) return texture;
    const sampling = volumeProjectionSamplingSupport({
      width: dims.W,
      height: dims.H,
      depth: dims.D,
    });
    return sampling.supported
      ? { supported: true, reason: '' }
      : { supported: false, reason: `volume needs ${sampling.requiredSteps} ray samples, exceeding the ${sampling.maximum}-sample shader limit` };
  };
  const fullSupport = supportFor({ W, H, D });
  let previewMounted = false;

  // Optional small preview raw: show first, then replace with full-res from R2.
  if (series.hasPreview && series.previewDims) {
    const [pw, ph, pd] = series.previewDims;
    const previewKey = `${variant}|preview:${series.slug}:${pw}x${ph}x${pd}`;
    previewMounted = Boolean(three.mesh && three.seriesIdx === state.seriesIdx && three.dataKey === previewKey);
    try {
      if (!previewMounted && (!three.mesh || three.seriesIdx !== state.seriesIdx)
        && supportFor({ W: pw, H: ph, D: pd }).supported) {
        const response = await fetch(`./data/${series.slug}_preview.raw`);
        if (response.ok) {
          const preview = new Uint8Array(await response.arrayBuffer());
          if (preview.length === pw * ph * pd) {
            uploadVolumeTexture(preview, THREE.UnsignedByteType, pw, ph, pd, series, previewKey, threeModules, {
              maxTextureSize,
              preview: true,
            });
            setThreePreviewShown(true);
            previewMounted = true;
          }
        }
      }
    } catch { /* preview failed — fall through to full-res */ }
  }

  if (!fullSupport.supported) {
    if (!previewMounted) disposeCurrentVolumeMesh(three);
    notify(previewMounted
      ? `Showing the ${series.previewDims.join('×')} 3D preview because ${fullSupport.reason}. MPR remains full resolution.`
      : `3D rendering unavailable: ${fullSupport.reason}. MPR remains available through the CPU path.`, {
      id: 'volume-texture-limit',
      kind: 'warning',
    });
    syncThreeSurfaceState(series);
    return previewMounted;
  }

  if (!ensureVoxels()) {
    syncThreeSurfaceState(series);
    return previewMounted;
  }

  let volumeData = state.voxels;
  let textureType = THREE.UnsignedByteType;
  let dataKey = `vox:${state.voxelsKey}`;

  const useFloatTexture = W * H * D * Float32Array.BYTES_PER_ELEMENT <= MAX_3D_BASE_TEXTURE_BYTES;
  const hr = useFloatTexture ? await ensureHRVoxels() : null;
  if (hr) {
    textureType = THREE.FloatType;
    dataKey = `hr:${state.hrKey}`;
  } else if (!useFloatTexture) {
    notify('3D is using the bounded 8-bit display volume; MPR retains full-precision voxel data.', {
      id: 'volume-texture-precision',
      kind: 'info',
    });
  }

  const nextDataKey = `${variant}|${dataKey}`;
  if (three.dataKey === nextDataKey && three.mesh) {
    await updateLabelTexture();
    syncViewerRuntimeSession(series);
    syncThreeSurfaceState(series);
    requestThreeRender('reuse-volume', 120);
    return true;
  }

  if (hr) {
    const applyMask = state.overlays.useBrain && state.voxels && state.voxels.length === hr.length;
    if (applyMask) {
      const masked = new Float32Array(hr.length);
      const mask = state.voxels;
      for (let i = 0; i < hr.length; i++) masked[i] = mask[i] === 0 ? 0 : hr[i];
      volumeData = masked;
    } else {
      volumeData = hr;
    }
  }

  if (volumeData.byteLength > MAX_3D_BASE_TEXTURE_BYTES) {
    notify(`3D rendering unavailable: the ${volumeData.byteLength}-byte texture exceeds the ${MAX_3D_BASE_TEXTURE_BYTES}-byte base-volume budget.`, {
      id: 'volume-texture-limit',
      kind: 'warning',
    });
    return previewMounted;
  }
  uploadVolumeTexture(volumeData, textureType, W, H, D, series, nextDataKey, threeModules, { maxTextureSize });
  setThreePreviewShown(false);
  syncThreeSurfaceState(series);
  return true;
}

/** Upload a volume array as a 3D texture and create/replace the mesh. */
function uploadVolumeTexture(volumeData, textureType, W, H, D, series, dataKey, threeModules, {
  maxTextureSize = 0,
  preview = false,
} = {}) {
  const { THREE, createVolumeRaycastMaterial } = threeModules;
  const texture = new THREE.Data3DTexture(volumeData, W, H, D);
  texture.format = THREE.RedFormat;
  texture.type = textureType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  const extents = volumeDisplayExtents(series);
  const scale = volumeDisplayScale(series);

  const dummyLabel = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  dummyLabel.format = THREE.RedFormat;
  dummyLabel.type = THREE.UnsignedByteType;
  dummyLabel.minFilter = THREE.NearestFilter;
  dummyLabel.magFilter = THREE.NearestFilter;
  dummyLabel.unpackAlignment = 1;
  dummyLabel.needsUpdate = true;

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
    lutTex,
    width: W,
    height: H,
    depth: D,
    gridWidth: series.width,
    gridHeight: series.height,
    gridDepth: series.slices,
    gridSpacing: [
      extents.colSpacing,
      extents.rowSpacing,
      extents.sliceSpacing,
    ],
    lowT: state.three.lowT,
    highT: state.three.highT,
    intensity: state.three.intensity,
    clipMin: state.three.clipMin,
    clipMax: state.three.clipMax,
    clipPlane: volumeClipPlane({
      dims: { W: series.width, H: series.height, D: series.slices },
      spacing: {
        row: series.pixelSpacing?.[0] || 1,
        col: series.pixelSpacing?.[1] || 1,
        slice: effectiveSliceSpacing(series),
      },
      yaw: state.mpr.obYaw,
      pitch: state.mpr.obPitch,
      depth: state.three.clipPlaneDepth,
      invert: state.three.clipPlaneInvert,
    }),
    clipPlaneEnabled: state.three.clipPlaneEnabled,
    renderMode: state.three.renderMode,
  });
  material.userData.baseTextureBytes = volumeData.byteLength;
  material.userData.max3DTextureSize = maxTextureSize;
  material.userData.preview = preview;

  const three = getThreeRuntime();
  disposeCurrentVolumeMesh(three);

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(scale[0], scale[1], scale[2]);
  three.scene.add(mesh);
  setThreeRuntimeMesh(mesh, {
    seriesIdx: state.seriesIdx,
    variant: state.overlays.useBrain ? 'brain' : 'base',
    dataKey,
  });
  syncViewerRuntimeSession(series);
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
