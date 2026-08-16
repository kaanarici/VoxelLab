// Pure orthogonal MPR geometry. The volume is stored row-major as (z, y, x);
// x is DICOM column, y is DICOM row, z is slice index.

import { geometryFromSeries } from '../core/geometry.js';

function positiveNumber(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function effectiveSliceSpacing(series) {
  return positiveNumber(geometryFromSeries(series).sliceSpacing, positiveNumber(series?.sliceThickness, 1));
}

export function mprPlaneSizes(series) {
  const D = series.slices;
  const W = series.width;
  const H = series.height;
  // Use shared geometry contract for all spacing values.
  const geo = geometryFromSeries(series);
  const colSpacing = positiveNumber(geo.colSpacing, 1);
  const rowSpacing = positiveNumber(geo.rowSpacing, colSpacing);
  const zSpacing = positiveNumber(geo.sliceSpacing, 1);
  const physicalRaster = (widthCount, heightCount, widthSpacing, heightSpacing) => {
    const referenceSpacing = Math.max(1e-6, Math.min(widthSpacing, heightSpacing));
    const rawWidth = widthCount > 1 ? 1 + ((widthCount - 1) * widthSpacing / referenceSpacing) : 1;
    const rawHeight = heightCount > 1 ? 1 + ((heightCount - 1) * heightSpacing / referenceSpacing) : 1;
    const scale = Math.min(1, 2048 / Math.max(rawWidth, rawHeight));
    return {
      width: Math.max(1, Math.round(rawWidth * scale)),
      height: Math.max(1, Math.round(rawHeight * scale)),
    };
  };
  const axial = physicalRaster(W, H, colSpacing, rowSpacing);
  const coronal = physicalRaster(W, D, colSpacing, zSpacing);
  const sagittal = physicalRaster(H, D, rowSpacing, zSpacing);
  return {
    axW: axial.width,
    axH: axial.height,
    coW: coronal.width,
    coH: coronal.height,
    saW: sagittal.width,
    saH: sagittal.height,
  };
}

function sourceCoordinateForPixel(pixel, outputSize, sourceSize, { invert = false } = {}) {
  if (!(sourceSize > 1)) return 0;
  if (!(outputSize > 1)) return (sourceSize - 1) / 2;
  const output = invert ? outputSize - 1 - pixel : pixel;
  return output * (sourceSize - 1) / (outputSize - 1);
}

export function mprVoxelForPixel(axis, ox, oy, outW, outH, series, crosshair) {
  const W = series.width;
  const H = series.height;
  const D = series.slices;
  const xFromPixel = sourceCoordinateForPixel(ox, outW, W);
  const yFromPixel = sourceCoordinateForPixel(ox, outW, H);
  const zFromPixel = sourceCoordinateForPixel(oy, outH, D, { invert: true });
  if (axis === 'ax') return [xFromPixel, sourceCoordinateForPixel(oy, outH, H), crosshair.z];
  if (axis === 'co') return [xFromPixel, crosshair.y, zFromPixel];
  return [crosshair.x, yFromPixel, zFromPixel];
}
