export function obliqueBasis(yawDeg, pitchDeg) {
  const yaw = yawDeg * Math.PI / 180;
  const pitch = pitchDeg * Math.PI / 180;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const u = [cy, sy, 0];
  const v = [-sy, cy, 0];
  const n = [0, 0, 1];
  return {
    u,
    v: [
      v[0] * cp + n[0] * sp,
      v[1] * cp + n[1] * sp,
      v[2] * cp + n[2] * sp,
    ],
    n: [
      -v[0] * sp + n[0] * cp,
      -v[1] * sp + n[1] * cp,
      -v[2] * sp + n[2] * cp,
    ],
  };
}
