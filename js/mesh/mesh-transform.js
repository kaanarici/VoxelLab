export function applyAffineToPositions(positions, affineLps) {
  const out = new Float32Array(positions.length);
  const m = affineLps;
  for (let i = 0; i < positions.length; i += 3) {
    const vx = positions[i];
    const vy = positions[i + 1];
    const vz = positions[i + 2];
    out[i] = m[0][0] * vx + m[0][1] * vy + m[0][2] * vz + m[0][3];
    out[i + 1] = m[1][0] * vx + m[1][1] * vy + m[1][2] * vz + m[1][3];
    out[i + 2] = m[2][0] * vx + m[2][1] * vy + m[2][2] * vz + m[2][3];
  }
  return out;
}
