import {
  dot3,
  isOrthonormalImagePlane,
  norm3,
  orientationFromIOP,
  projectionAlongNormal,
  sliceNormalFromIOP,
} from '../core/geometry.js';
import { getFloatArray } from './dicom-meta.js';

function numberArray(meta, key) {
  return getFloatArray(meta, key);
}

function positiveSpacing(meta) {
  const spacing = numberArray(meta, 'PixelSpacing')?.map(Number);
  return spacing?.[0] > 0 && spacing?.[1] > 0 ? spacing : null;
}

function sameSpacing(a, b) {
  return Math.abs(a[0] - b[0]) <= Math.max(0.001, a[0] * 0.001)
    && Math.abs(a[1] - b[1]) <= Math.max(0.001, a[1] * 0.001);
}

function orientationCornerDriftMm(base, current, meta, spacing) {
  const columns = Math.max(1, Number(meta?.Columns) || 1);
  const rows = Math.max(1, Number(meta?.Rows) || 1);
  const rowAxisSpan = (columns - 1) * spacing[1];
  const colAxisSpan = (rows - 1) * spacing[0];
  const rowDelta = base.row.map((value, index) => (current.row[index] - value) * rowAxisSpan);
  const colDelta = base.col.map((value, index) => (current.col[index] - value) * colAxisSpan);
  return Math.max(
    norm3(rowDelta),
    norm3(colDelta),
    norm3(rowDelta.map((value, index) => value + colDelta[index])),
  );
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

    if (dot3(baseOrientation.row, orientation.row) <= 0 || dot3(baseOrientation.col, orientation.col) <= 0) return false;
    if (orientationCornerDriftMm(baseOrientation, orientation, meta, baseSpacing) > 0.25) return false;
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
