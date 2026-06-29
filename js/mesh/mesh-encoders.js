// Dependency-free 3D mesh encoders (no THREE — vendor-three exposes no STL/OBJ
// writers and is async/3D-only). Both consume { positions: Float32Array (xyz
// triples), indices: Uint32Array (triangle triples), name } in patient mm.

function triangleNormal(positions, ia, ib, ic) {
  const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
  const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
  const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

/**
 * Binary STL: 80-byte header + uint32 triangle count + per-triangle (12-float
 * normal+verts, all LE float32 + uint16 attribute). Returns an ArrayBuffer.
 */
export function encodeStlBinary({ positions, indices, name = 'mesh' } = {}) {
  const triCount = Math.floor((indices?.length || 0) / 3);
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = `VoxelLab STL ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i += 1) view.setUint8(i, header.charCodeAt(i) & 0xff);
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t += 1) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const [nx, ny, nz] = triangleNormal(positions, ia, ib, ic);
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (const base of [ia, ib, ic]) {
      view.setFloat32(offset, positions[base], true);
      view.setFloat32(offset + 4, positions[base + 1], true);
      view.setFloat32(offset + 8, positions[base + 2], true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

/**
 * Wavefront OBJ. Single mesh, or multiple named groups when `parts` is given
 * (each { name, positions, indices }) — groups share one running vertex list
 * with a 1-based index offset, matching the OBJ spec. Returns a string.
 */
export function encodeObj(input) {
  const parts = Array.isArray(input?.parts)
    ? input.parts
    : [{ name: input?.name || 'mesh', positions: input?.positions, indices: input?.indices }];
  const lines = ['# VoxelLab OBJ export'];
  let vertexBase = 0;
  for (const part of parts) {
    const positions = part.positions || new Float32Array(0);
    const indices = part.indices || new Uint32Array(0);
    lines.push(`o ${part.name || 'mesh'}`);
    for (let i = 0; i < positions.length; i += 3) {
      lines.push(`v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`);
    }
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] + 1 + vertexBase;
      const b = indices[t + 1] + 1 + vertexBase;
      const c = indices[t + 2] + 1 + vertexBase;
      lines.push(`f ${a} ${b} ${c}`);
    }
    vertexBase += positions.length / 3;
  }
  return `${lines.join('\n')}\n`;
}

/** Concatenate meshes into one triangle soup with offset indices (for STL). */
export function mergeMeshes(meshes = []) {
  let vertCount = 0;
  let idxCount = 0;
  for (const m of meshes) {
    vertCount += (m.positions?.length || 0);
    idxCount += (m.indices?.length || 0);
  }
  const positions = new Float32Array(vertCount);
  const indices = new Uint32Array(idxCount);
  let pOff = 0;
  let iOff = 0;
  let base = 0;
  for (const m of meshes) {
    const p = m.positions || new Float32Array(0);
    const idx = m.indices || new Uint32Array(0);
    positions.set(p, pOff);
    for (let i = 0; i < idx.length; i += 1) indices[iOff + i] = idx[i] + base;
    pOff += p.length;
    iOff += idx.length;
    base += p.length / 3;
  }
  return { positions, indices };
}
