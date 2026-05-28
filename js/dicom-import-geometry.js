import {
  dot3,
  isOrthonormalImagePlane,
  norm3,
  orientationFromIOP,
  projectionAlongNormal,
  sliceNormalFromIOP,
} from './geometry.js';

function numberArray(meta, key) {
  const value = meta?.[key];
  if (!value) return null;
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') return value.split('\\').map(Number);
  return null;
}

function positiveSpacing(meta) {
  const spacing = numberArray(meta, 'PixelSpacing')?.map(Number);
  return spacing?.[0] > 0 && spacing?.[1] > 0 ? spacing : null;
}

function sameSpacing(a, b) {
  return Math.abs(a[0] - b[0]) <= Math.max(0.001, a[0] * 0.001)
    && Math.abs(a[1] - b[1]) <= Math.max(0.001, a[1] * 0.001);
}

export function hasVolumeStackGeometry(metas = []) {
  if (metas.length < 2) return false;
  const baseFrame = String(metas[0]?.FrameOfReferenceUID || '').trim();
  const baseIop = numberArray(metas[0], 'ImageOrientationPatient');
  const baseOrientation = orientationFromIOP(baseIop);
  const normal = sliceNormalFromIOP(baseIop);
  if (!baseOrientation || !normal || !isOrthonormalImagePlane(baseIop)) return false;
  const baseSpacing = positiveSpacing(metas[0]);
  if (!baseSpacing) return false;

  const positions = [];
  const seenProjections = new Set();
  for (const meta of metas) {
    const frame = String(meta?.FrameOfReferenceUID || '').trim();
    if (frame !== baseFrame) return false;
    const iop = numberArray(meta, 'ImageOrientationPatient');
    const orientation = orientationFromIOP(iop);
    const ipp = numberArray(meta, 'ImagePositionPatient')?.slice(0, 3).map(Number);
    const spacing = positiveSpacing(meta);
    if (!orientation || !isOrthonormalImagePlane(iop) || !ipp?.every(Number.isFinite) || !spacing) return false;
    // DICOM Image Plane orientation values are row/column direction cosines.
    // https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html
    if (dot3(baseOrientation.row, orientation.row) <= 0.999 || dot3(baseOrientation.col, orientation.col) <= 0.999) return false;
    if (!sameSpacing(baseSpacing, spacing)) return false;

    const projection = projectionAlongNormal(meta, normal);
    if (projection == null) return false;
    const projectionKey = projection.toFixed(3);
    if (seenProjections.has(projectionKey)) return false;
    seenProjections.add(projectionKey);
    if (positions.length) {
      const delta = ipp.map((value, index) => value - positions[0].ipp[index]);
      const axial = dot3(delta, normal);
      const residual = delta.map((value, index) => value - normal[index] * axial);
      if (norm3(residual) > 0.1) return false;
    }
    positions.push({ projection, ipp });
  }

  const projections = positions.map(position => position.projection);
  if (Math.max(...projections) - Math.min(...projections) < 0.01) return false;
  return new Set(projections.map(projection => projection.toFixed(3))).size >= 2;
}
