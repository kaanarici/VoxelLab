import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binaryMaskForLabel, marchingCubes } from '../js/mesh/marching-cubes.js';

function edgeManifoldCheck(indices) {
  // Each undirected edge must be shared by exactly two triangles (watertight).
  const counts = new Map();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.values()].every((c) => c === 2);
}

test('binaryMaskForLabel marks only matching voxels', () => {
  const vox = new Uint8Array([0, 3, 3, 1]);
  const mask = binaryMaskForLabel(vox, 2, 2, 1, 3);
  assert.deepEqual([...mask], [0, 1, 1, 0]);
});

test('empty mask yields no triangles', () => {
  const mask = new Uint8Array(2 * 2 * 2);
  const { positions, indices } = marchingCubes({ mask, W: 2, H: 2, D: 2 });
  assert.equal(positions.length, 0);
  assert.equal(indices.length, 0);
});

function signedVolume(positions, indices) {
  let vol6 = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    vol6 += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return vol6 / 6;
}

test('single isolated sample yields a closed, watertight, outward octahedron', () => {
  // One set grid sample in a 3x3x3 field: marching cubes returns the dual
  // octahedron (6 verts, 8 tris) centered on that sample.
  const W = 3, H = 3, D = 3;
  const mask = new Uint8Array(W * H * D);
  mask[(1 * H + 1) * W + 1] = 1;
  const { positions, indices } = marchingCubes({ mask, W, H, D });
  assert.equal(positions.length / 3, 6);
  assert.equal(indices.length / 3, 8);
  assert.ok(edgeManifoldCheck(indices), 'every edge shared by exactly two triangles');
  // Outward winding => positive signed volume (octahedron with radius-1 axes = 4/3·... = 1/6 here).
  assert.ok(Math.abs(signedVolume(positions, indices) - 1 / 6) < 1e-9, 'outward, correct dual volume');
});

test('loop order matches z*W*H + y*W + x layout (off-center sample placement)', () => {
  // A sample at (x=2,y=1,z=0) must produce a surface centered there, proving the
  // iteration indexes the mask as z*W*H + y*W + x.
  const W = 4, H = 3, D = 3;
  const mask = new Uint8Array(W * H * D);
  mask[0 * W * H + 1 * W + 2] = 1;
  const { positions } = marchingCubes({ mask, W, H, D });
  let cx = 0, cy = 0, cz = 0;
  const n = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
  assert.deepEqual([Math.round(cx / n), Math.round(cy / n), Math.round(cz / n)], [2, 1, 0]);
});

test('2x2x2 solid block is watertight with positive enclosed volume', () => {
  const W = 4, H = 4, D = 4;
  const mask = new Uint8Array(W * H * D);
  for (let z = 1; z <= 2; z += 1) for (let y = 1; y <= 2; y += 1) for (let x = 1; x <= 2; x += 1) {
    mask[(z * H + y) * W + x] = 1;
  }
  const { positions, indices } = marchingCubes({ mask, W, H, D });
  assert.ok(edgeManifoldCheck(indices), 'watertight');
  const volume = signedVolume(positions, indices);
  assert.ok(volume > 0, 'outward-facing winding');
  assert.ok(Math.abs(volume - 17 / 3) < 1e-9, 'deterministic dual-surface volume');
});
