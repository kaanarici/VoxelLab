import { cross3 } from '../core/geometry.js';
import {
  MAX_ACCURATE_SLAB_SAMPLES,
  MAX_VOXEL_STEP,
  MPR_PROJECTION_MODES,
  clampSlabThicknessMm,
  maximumAccurateSlabThicknessMm,
  normalizeMprProjectionMode,
} from '../core/view-limits.js';

export { MAX_ACCURATE_SLAB_SAMPLES, MPR_PROJECTION_MODES, clampSlabThicknessMm, maximumAccurateSlabThicknessMm, normalizeMprProjectionMode };

function voxelToPhysical(vec, spacing) {
  return [
    vec[0] * spacing.col,
    vec[1] * spacing.row,
    vec[2] * spacing.slice,
  ];
}

function positiveSpacing(spacing) {
  return {
    row: Number(spacing?.row) > 0 ? Number(spacing.row) : 1,
    col: Number(spacing?.col) > 0 ? Number(spacing.col) : 1,
    slice: Number(spacing?.slice) > 0 ? Number(spacing.slice) : 1,
  };
}

// Shape: { origin: [0, 0, 12], axisU: [255, 0, 0], axisV: [0, 255, 0] } in voxel coordinates.
export function planeForAxis(axis, outW, outH, series, crosshair, mprVoxelForPixel) {
  const tl = mprVoxelForPixel(axis, 0, 0, outW, outH, series, crosshair);
  const tr = mprVoxelForPixel(axis, Math.max(1, outW - 1), 0, outW, outH, series, crosshair);
  const bl = mprVoxelForPixel(axis, 0, Math.max(1, outH - 1), outW, outH, series, crosshair);
  return {
    origin: tl,
    axisU: [tr[0] - tl[0], tr[1] - tl[1], tr[2] - tl[2]],
    axisV: [bl[0] - tl[0], bl[1] - tl[1], bl[2] - tl[2]],
  };
}

export function planeForOblique(outW, outH, center, du, dv) {
  const halfW = (outW - 1) / 2;
  const halfH = (outH - 1) / 2;
  return {
    origin: [
      center[0] - halfW * du[0] - halfH * dv[0],
      center[1] - halfW * du[1] - halfH * dv[1],
      center[2] - halfW * du[2] - halfH * dv[2],
    ],
    axisU: [du[0] * Math.max(1, outW - 1), du[1] * Math.max(1, outW - 1), du[2] * Math.max(1, outW - 1)],
    axisV: [dv[0] * Math.max(1, outH - 1), dv[1] * Math.max(1, outH - 1), dv[2] * Math.max(1, outH - 1)],
  };
}

// Shape: { mode: "mip", slabThicknessMm: 12, sampleCount: 13, slabStep: [0, 0, 1] }.
export function createMprProjection(
  { mode = 'thin', slabThicknessMm = 0 } = {},
  spacing = { row: 1, col: 1, slice: 1 },
  plane = null,
) {
  const normalizedMode = normalizeMprProjectionMode(mode);
  const safeSpacing = positiveSpacing(spacing);
  const thickness = clampSlabThicknessMm(slabThicknessMm, safeSpacing);
  if (!plane || normalizedMode === 'thin' || thickness <= 0) {
    return {
      mode: normalizedMode,
      slabThicknessMm: thickness,
      sampleCount: 1,
      slabStep: [0, 0, 0],
    };
  }
  const physicalNormal = cross3(
    voxelToPhysical(plane.axisU, safeSpacing),
    voxelToPhysical(plane.axisV, safeSpacing),
  );
  const normalMm = Math.hypot(physicalNormal[0], physicalNormal[1], physicalNormal[2]);
  if (!(normalMm > 0)) {
    return {
      mode: normalizedMode,
      slabThicknessMm: thickness,
      sampleCount: 1,
      slabStep: [0, 0, 0],
    };
  }
  const physicalUnitNormal = physicalNormal.map((value) => value / normalMm);
  const voxelDistancePerMm = Math.hypot(
    physicalUnitNormal[0] / safeSpacing.col,
    physicalUnitNormal[1] / safeSpacing.row,
    physicalUnitNormal[2] / safeSpacing.slice,
  );
  const maxStepMm = MAX_VOXEL_STEP / Math.max(voxelDistancePerMm, 1e-12);
  const halfSteps = Math.max(1, Math.ceil((thickness / 2) / maxStepMm));
  const sampleCount = Math.min(MAX_ACCURATE_SLAB_SAMPLES, halfSteps * 2 + 1);
  const stepMm = thickness / Math.max(1, sampleCount - 1);
  const physicalStep = physicalUnitNormal.map((value) => value * stepMm);
  return {
    mode: normalizedMode,
    slabThicknessMm: thickness,
    sampleCount,
    slabStep: [
      physicalStep[0] / safeSpacing.col,
      physicalStep[1] / safeSpacing.row,
      physicalStep[2] / safeSpacing.slice,
    ],
  };
}

export function projectionCacheToken(projection = null) {
  if (!projection || projection.sampleCount <= 1) return 'thin:0:1';
  return `${projection.mode}:${projection.slabThicknessMm}:${projection.sampleCount}`;
}

export function voxelCoordinateInside(dims, x, y, z) {
  const epsilon = 1e-5;
  return x >= -epsilon && x <= dims.W - 1 + epsilon
    && y >= -epsilon && y <= dims.H - 1 + epsilon
    && z >= -epsilon && z <= dims.D - 1 + epsilon;
}

function nearestDiscreteSample(volume, x, y, z, dims) {
  if (!voxelCoordinateInside(dims, x, y, z)) return 0;
  const ix = Math.max(0, Math.min(dims.W - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(dims.H - 1, Math.round(y)));
  const iz = Math.max(0, Math.min(dims.D - 1, Math.round(z)));
  return volume[iz * dims.W * dims.H + iy * dims.W + ix] || 0;
}

export function projectDiscreteSlabLabel(labelVolume, baseVolume, x, y, z, dims, baseSampler, projection = null) {
  if (!projection || projection.sampleCount <= 1 || projection.mode === 'thin') {
    return nearestDiscreteSample(labelVolume, x, y, z, dims);
  }
  const centerOffset = (projection.sampleCount - 1) / 2;
  if (projection.mode === 'avg') {
    let closestLabel = 0;
    let closestDistance = Infinity;
    for (let i = 0; i < projection.sampleCount; i++) {
      const offset = i - centerOffset;
      const sx = x + projection.slabStep[0] * offset;
      const sy = y + projection.slabStep[1] * offset;
      const sz = z + projection.slabStep[2] * offset;
      if (!voxelCoordinateInside(dims, sx, sy, sz)) continue;
      const label = nearestDiscreteSample(
        labelVolume,
        sx,
        sy,
        sz,
        dims,
      );
      const distance = Math.abs(offset);
      if (label && distance < closestDistance) {
        closestLabel = label;
        closestDistance = distance;
      }
    }
    return closestLabel;
  }

  let bestIntensity = projection.mode === 'minip' ? Infinity : -Infinity;
  let bestLabel = 0;
  for (let i = 0; i < projection.sampleCount; i++) {
    const offset = i - centerOffset;
    const sx = x + projection.slabStep[0] * offset;
    const sy = y + projection.slabStep[1] * offset;
    const sz = z + projection.slabStep[2] * offset;
    if (!voxelCoordinateInside(dims, sx, sy, sz)) continue;
    const intensity = baseSampler(baseVolume, sx, sy, sz, dims.W, dims.H, dims.D);
    const better = projection.mode === 'minip' ? intensity < bestIntensity : intensity > bestIntensity;
    if (better) {
      bestIntensity = intensity;
      bestLabel = nearestDiscreteSample(labelVolume, sx, sy, sz, dims);
    }
  }
  return bestLabel;
}

export function projectVolumeSample(volume, x, y, z, dims, sampler, projection = null) {
  if (!projection || projection.sampleCount <= 1 || projection.mode === 'thin') {
    return voxelCoordinateInside(dims, x, y, z)
      ? sampler(volume, x, y, z, dims.W, dims.H, dims.D)
      : 0;
  }
  const centerOffset = (projection.sampleCount - 1) / 2;
  if (projection.mode === 'avg') {
    let sum = 0;
    let validSamples = 0;
    for (let i = 0; i < projection.sampleCount; i++) {
      const offset = i - centerOffset;
      const sx = x + projection.slabStep[0] * offset;
      const sy = y + projection.slabStep[1] * offset;
      const sz = z + projection.slabStep[2] * offset;
      if (!voxelCoordinateInside(dims, sx, sy, sz)) continue;
      sum += sampler(volume, sx, sy, sz, dims.W, dims.H, dims.D);
      validSamples += 1;
    }
    return validSamples ? sum / validSamples : 0;
  }
  let best = projection.mode === 'minip' ? Infinity : -Infinity;
  for (let i = 0; i < projection.sampleCount; i++) {
    const offset = i - centerOffset;
    const sx = x + projection.slabStep[0] * offset;
    const sy = y + projection.slabStep[1] * offset;
    const sz = z + projection.slabStep[2] * offset;
    if (!voxelCoordinateInside(dims, sx, sy, sz)) continue;
    const sample = sampler(volume, sx, sy, sz, dims.W, dims.H, dims.D);
    if (projection.mode === 'minip') best = Math.min(best, sample);
    else best = Math.max(best, sample);
  }
  return Number.isFinite(best) ? best : 0;
}
