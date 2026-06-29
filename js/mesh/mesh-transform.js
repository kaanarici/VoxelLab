// Map marching-cubes voxel-space vertices into patient LPS millimetres using the
// series affine from geometryFromSeries(). Axis pairing is deliberate and must
// match the affine columns: vertex.x = DICOM column (scaled by colSpacing),
// vertex.y = DICOM row (scaled by rowSpacing), vertex.z = slice. Reusing the 3D
// display's max-axis-normalized scale here would distort real-world dimensions.

/**
 * Transform a flat xyz positions array (voxel coords) into LPS mm in place into
 * a new Float32Array, using `affineLps` (4×4, row-major as nested arrays).
 */
export function applyAffineToPositions(positions, affineLps) {
  const out = new Float32Array(positions.length);
  const m = affineLps;
  for (let i = 0; i < positions.length; i += 3) {
    const vx = positions[i];     // DICOM column
    const vy = positions[i + 1]; // DICOM row
    const vz = positions[i + 2]; // slice
    out[i] = m[0][0] * vx + m[0][1] * vy + m[0][2] * vz + m[0][3];
    out[i + 1] = m[1][0] * vx + m[1][1] * vy + m[1][2] * vz + m[1][3];
    out[i + 2] = m[2][0] * vx + m[2][1] * vy + m[2][2] * vz + m[2][3];
  }
  return out;
}
