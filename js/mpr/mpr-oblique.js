// Oblique MPR — user-defined plane through the volume.
//
// The three orthogonal MPR views (axial / coronal / sagittal) are fixed
// to the DICOM acquisition axes. An oblique plane lets the user pick any
// orientation — useful for following structures that don't lie in a
// canonical plane (aorta, optic nerves, curved vertebrae, etc.).
//
// A plane is defined by:
//   · a point that sits on the plane (we use the MPR crosshair position)
//   · two orthogonal direction vectors spanning the plane (the "u" and
//     "v" axes in the output image)
//
// We parameterize the plane by two angles:
//   · yaw   — rotation around acquisition-grid z
//   · pitch — tilt relative to the axial plane
//
// Starting from the identity orientation (u=+x, v=+y, normal=+z) we
// rotate u and v by (yaw, pitch) to produce any plane. Output pixel (u,v)
// maps to a volume voxel at
//   p = center + u * du + v * dv
// where du and dv are the unit u/v vectors scaled to voxel size.
//
// Orthogonal, oblique, CPU, and GPU paths share trilinear intensity sampling.

import { getFusedWLLut, getFusedWLU32 } from '../colormap.js';
import { drawCompositeSlice } from '../slice-compositor.js';
import { dot3 } from '../core/geometry.js';
import { OVERLAY_CACHE_BY_KIND, overlayBytesPresent } from '../runtime/overlay-cache-keys.js';
import { projectDiscreteSlabLabel, projectVolumeSample } from './mpr-projection.js';
import { obliqueBasis } from './mpr-oblique-geometry.js';
import { sampleTrilinear } from './mpr-sampling.js';

export { obliqueBasis } from './mpr-oblique-geometry.js';

function sampleByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function normalizedPlaneExtent(extent) {
  if (Number.isFinite(extent)) {
    return { widthMm: extent, heightMm: extent, centerOffsetUMm: 0, centerOffsetVMm: 0 };
  }
  const widthMm = Number(extent?.widthMm);
  const heightMm = Number(extent?.heightMm);
  const centerOffsetUMm = Number(extent?.centerOffsetUMm);
  const centerOffsetVMm = Number(extent?.centerOffsetVMm);
  return {
    widthMm: Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 1,
    heightMm: Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 1,
    centerOffsetUMm: Number.isFinite(centerOffsetUMm) ? centerOffsetUMm : 0,
    centerOffsetVMm: Number.isFinite(centerOffsetVMm) ? centerOffsetVMm : 0,
  };
}

// Shape: { widthMm: 192, heightMm: 176 } for the current oblique plane through the volume.
export function obliquePlaneExtentMm(dims, spacing, center, yaw, pitch) {
  const { W, H, D } = dims;
  const basis = obliqueBasis(yaw, pitch);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const z of [0, Math.max(0, D - 1)]) {
    for (const y of [0, Math.max(0, H - 1)]) {
      for (const x of [0, Math.max(0, W - 1)]) {
        const rel = [
          (x - center[0]) * spacing.col,
          (y - center[1]) * spacing.row,
          (z - center[2]) * spacing.slice,
        ];
        const u = dot3(rel, basis.u);
        const v = dot3(rel, basis.v);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  const pad = 0.02;
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  const paddedMinU = minU - spanU * pad;
  const paddedMaxU = maxU + spanU * pad;
  const paddedMinV = minV - spanV * pad;
  const paddedMaxV = maxV + spanV * pad;
  return {
    widthMm: Math.max(spacing.col, paddedMaxU - paddedMinU),
    heightMm: Math.max(spacing.row, paddedMaxV - paddedMinV),
    centerOffsetUMm: (paddedMinU + paddedMaxU) / 2,
    centerOffsetVMm: (paddedMinV + paddedMaxV) / 2,
  };
}

export function obliqueSamplingCenterVoxel(center, spacing, yaw, pitch, extentMm) {
  const extent = normalizedPlaneExtent(extentMm);
  const basis = obliqueBasis(yaw, pitch);
  return [
    center[0] + (basis.u[0] * extent.centerOffsetUMm + basis.v[0] * extent.centerOffsetVMm) / spacing.col,
    center[1] + (basis.u[1] * extent.centerOffsetUMm + basis.v[1] * extent.centerOffsetVMm) / spacing.row,
    center[2] + (basis.u[2] * extent.centerOffsetUMm + basis.v[2] * extent.centerOffsetVMm) / spacing.slice,
  ];
}

// Shape: { width: 820, height: 608 } chosen to fill the visible oblique stage.
export function fitObliqueCanvas(availableWidth, availableHeight, extent) {
  const width = Math.max(1, Math.round(availableWidth || 1));
  const height = Math.max(1, Math.round(availableHeight || 1));
  const safe = normalizedPlaneExtent(extent);
  const aspect = safe.widthMm / safe.heightMm;
  if (!(aspect > 0)) return { width, height };
  const targetHeight = Math.min(height, Math.round(width / aspect));
  const targetWidth = Math.min(width, Math.round(targetHeight * aspect));
  return {
    width: Math.max(1, targetWidth),
    height: Math.max(1, targetHeight),
  };
}

export function obliqueRasterSize(displaySize, maxEdge = 1024) {
  const width = Math.max(1, Number(displaySize?.width || 1));
  const height = Math.max(1, Number(displaySize?.height || 1));
  const cap = Math.max(1, Number(maxEdge || 1));
  const scale = Math.min(1, cap / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function ensureObliqueBuffers(target, width, height, overlays) {
  const planeSize = width * height;
  const next = target?.width === width && target?.height === height
    ? target
    : { width, height };
  next.width = width;
  next.height = height;
  if (!next.baseBytes || next.baseBytes.length !== planeSize) next.baseBytes = new Uint8Array(planeSize);
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    if (overlays[cache.voxels]) {
      if (!next[cache.bytes] || next[cache.bytes].length !== planeSize) {
        next[cache.bytes] = new Uint8Array(planeSize);
      }
    } else {
      next[cache.bytes] = null;
    }
  }
  return next;
}

// Shape: { width: 512, height: 512, baseBytes: Uint8Array(...), segBytes: null, regionBytes: null, symBytes: null, fusionBytes: null }.
export function sampleObliqueCompositeSlice(width, height, vox, voxScale, dims, spacing, center, yaw, pitch, extentMm, overlays = null, target = null, sampleVolume = sampleTrilinear, projection = null) {
  const { W, H, D } = dims;
  const overlayState = overlays || {};
  const sampled = ensureObliqueBuffers(target, width, height, overlayState);
  const { baseBytes } = sampled;
  const extent = normalizedPlaneExtent(extentMm);
  const basis = obliqueBasis(yaw, pitch);
  const samplingCenter = obliqueSamplingCenterVoxel(center, spacing, yaw, pitch, extent);
  const stepUMm = extent.widthMm / Math.max(1, width - 1);
  const stepVMm = extent.heightMm / Math.max(1, height - 1);
  const du = [basis.u[0] * stepUMm / spacing.col, basis.u[1] * stepUMm / spacing.row, basis.u[2] * stepUMm / spacing.slice];
  const dv = [basis.v[0] * stepVMm / spacing.col, basis.v[1] * stepVMm / spacing.row, basis.v[2] * stepVMm / spacing.slice];
  const halfW = (width - 1) / 2;
  const halfH = (height - 1) / 2;
  const maxVx = W - 1;
  const maxVy = H - 1;
  const maxVz = D - 1;
  const isThinProjection = !projection || projection.sampleCount <= 1 || projection.mode === 'thin';

  let sampleIndex = 0;
  for (let oy = 0; oy < height; oy++) {
    const rowX = samplingCenter[0] + (oy - halfH) * dv[0] - halfW * du[0];
    const rowY = samplingCenter[1] + (oy - halfH) * dv[1] - halfW * du[1];
    const rowZ = samplingCenter[2] + (oy - halfH) * dv[2] - halfW * du[2];

    for (let ox = 0; ox < width; ox++, sampleIndex++) {
      const vx = rowX + ox * du[0];
      const vy = rowY + ox * du[1];
      const vz = rowZ + ox * du[2];

      if (vx < 0 || vx > maxVx || vy < 0 || vy > maxVy || vz < 0 || vz > maxVz) {
        baseBytes[sampleIndex] = 0;
        for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
          const dest = sampled[cache.bytes];
          if (dest) dest[sampleIndex] = 0;
        }
        continue;
      }

      baseBytes[sampleIndex] = sampleByte(
        (isThinProjection
          ? sampleVolume(vox, vx, vy, vz, W, H, D)
          : projectVolumeSample(vox, vx, vy, vz, dims, sampleVolume, projection))
        * voxScale,
      );
      for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
        const dest = sampled[cache.bytes];
        if (!dest) continue;
        const volume = overlayState[cache.voxels];
        dest[sampleIndex] = cache.sample === 'nearest'
          ? projectDiscreteSlabLabel(volume, vox, vx, vy, vz, dims, sampleVolume, projection)
          : sampleByte(
            isThinProjection
              ? sampleVolume(volume, vx, vy, vz, W, H, D)
              : projectVolumeSample(volume, vx, vy, vz, dims, sampleVolume, projection),
          );
      }
    }
  }
  return sampled;
}

// Draw an oblique reslice onto a 2D canvas.
//
//   canvas     — target HTMLCanvasElement
//   vox        — Uint8Array | Float32Array (row-major D,H,W)
//   voxScale   — multiply sampled value by this (1 for uint8, 255 for float)
//   dims       — { W, H, D }
//   spacing    — { px, py, sz } mm per voxel
//   center     — [x, y, z] voxel coordinate the plane passes through
//   yaw, pitch — plane orientation in degrees
//   extentMm   — physical size of the output window in mm (square)
//   lo, hi     — reserved (W/L + colormap come from state via fused LUTs)
//
// Output matches 2D / orthogonal MPR: same window/level and colormap as
// drawSlice (getFusedWLU32 / getFusedWLLut).
export function drawObliqueMPR(canvas, vox, voxScale, dims, spacing, center, yaw, pitch, extentMm, _lo, _hi, overlays = null, sampleVolume = sampleTrilinear, projection = null) {
  const outW = canvas.width;
  const outH = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Shape: reusable sampled-byte planes for the current oblique canvas size.
  canvas._obliqueComposite = sampleObliqueCompositeSlice(
    outW,
    outH,
    vox,
    voxScale,
    dims,
    spacing,
    center,
    yaw,
    pitch,
    extentMm,
    overlays,
    canvas._obliqueComposite,
    sampleVolume,
    projection,
  );
  const sampled = canvas._obliqueComposite;
  const hasOverlays = overlayBytesPresent(sampled);

  if (!hasOverlays) {
    const imgData = canvas._obliqueImageData?.width === outW && canvas._obliqueImageData?.height === outH
      ? canvas._obliqueImageData
      : ctx.createImageData(outW, outH);
    canvas._obliqueImageData = imgData;
    const out32 = new Uint32Array(imgData.data.buffer);
    const fusedU32 = getFusedWLU32();
    for (let i = 0; i < sampled.baseBytes.length; i++) out32[i] = fusedU32[sampled.baseBytes[i]];
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  const forceTextureUploads = { base: true };
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    forceTextureUploads[cache.type] = !!sampled[cache.bytes];
  }
  drawCompositeSlice(ctx, outW, outH, {
    baseBytes: sampled.baseBytes,
    overlayBytes: sampled,
    wlLut: getFusedWLLut(),
    regionColors: overlays?.regionColors || null,
    regionAlpha: overlays?.regionAlpha,
    fusionAlpha: overlays?.fusionAlpha,
    hotLut: overlays?.hotLut || null,
    forceTextureUploads,
  });
}
