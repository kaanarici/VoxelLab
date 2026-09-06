import { raycastStepCount } from '../core/volume-limits.js';
import * as THREE from './vendor-three.js';

import {
  VOLUME_RAYCAST_FRAGMENT_SHADER,
  VOLUME_RAYCAST_VERTEX_SHADER,
} from './volume-raycast-shaders.js';

export function createVolumeRaycastMaterial(opts) {
  const {
    texture,
    dummyLabel,
    lutTex,
    width: W,
    height: H,
    depth: D,
    gridWidth = W,
    gridHeight = H,
    gridDepth = D,
    gridSpacing = [1, 1, 1],
    lowT,
    highT,
    intensity,
    clipMin,
    clipMax,
    clipPlane,
    clipPlaneEnabled,
    renderMode,
  } = opts;

  const uMode = renderMode === 'mip' ? 1 : renderMode === 'minip' ? 2 : 0;
  const spacing = gridSpacing.map(value => Number(value) > 0 ? Number(value) : 1);
  const densityUnit = Math.min(...spacing);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uVolume:     { value: texture },
      uLabel:      { value: dummyLabel },
      uLabelMode:  { value: 0 },
      uLabelLUT:   { value: lutTex },
      uLabelAlpha: { value: 0.55 },
      uSteps:      { value: raycastStepCount({ width: W, height: H, depth: D, renderMode }) },
      uLowT:       { value: lowT },
      uHighT:      { value: highT },
      uIntensity:  { value: intensity },
      uClipMin:    { value: new THREE.Vector3().fromArray(clipMin) },
      uClipMax:    { value: new THREE.Vector3().fromArray(clipMax) },
      uClipPlane:  { value: new THREE.Vector4().fromArray(clipPlane) },
      uClipPlaneEnabled: { value: clipPlaneEnabled ? 1 : 0 },
      uMode:       { value: uMode },
      uVolSize:    { value: new THREE.Vector3(
        gridWidth * spacing[0] / densityUnit,
        gridHeight * spacing[1] / densityUnit,
        gridDepth * spacing[2] / densityUnit,
      ) },
      uHiddenLabels: { value: new Int32Array(256) },
      uIsolate:    { value: 0 },
    },
    vertexShader: VOLUME_RAYCAST_VERTEX_SHADER,
    fragmentShader: VOLUME_RAYCAST_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.BackSide,
  });

  material.userData.textureDims = { width: W, height: H, depth: D };
  return material;
}
