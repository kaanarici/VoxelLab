export function normalizeUint16RawVolume(buffer, expectedVoxels) {
  const expected = Math.floor(Number(expectedVoxels));
  if (!(expected > 0)) throw new Error('raw volume expected voxel count is invalid');
  if (!buffer || Number(buffer.byteLength) !== expected * 2) {
    throw new Error(`raw volume byte count mismatch: expected ${expected * 2}, got ${Number(buffer?.byteLength || 0)}`);
  }

  const u16 = new Uint16Array(buffer);
  if (u16.length !== expected) {
    throw new Error(`raw volume voxel count mismatch: expected ${expected}, got ${u16.length}`);
  }

  const f32 = new Float32Array(expected);
  const inv = 1 / 65535;
  for (let i = 0; i < expected; i += 1) f32[i] = u16[i] * inv;
  return f32;
}
