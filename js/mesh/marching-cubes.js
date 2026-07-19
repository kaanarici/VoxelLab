// Dependency-free marching cubes over a binary voxel mask. Produces a surface
// mesh between the labelled voxels (mask==1) and background, faithful to the
// voxel block the viewer renders. Vertices are in VOXEL space (x=column,
// y=row, z=slice); the caller maps them to patient mm via the series affine.
//
// The mask is sampled at voxel centers and cube corners sit at integer voxel
// coordinates. Cubes iterate in z,y,x order matching the row-major layout
// idx = z*W*H + y*W + x. With a binary field every edge crossing is the
// midpoint between corners, so the surface hugs the voxel boundary exactly.

import { EDGE_TABLE, TRI_TABLE } from './marching-cubes-tables.js';

// Corner offsets in (x,y,z), in the canonical marching-cubes vertex order.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
// Each edge connects two corners (canonical order).
const EDGE = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Binary mask (Uint8Array, 1 where voxel==label) over a W×H×D volume. */
export function binaryMaskForLabel(regionVoxels, W, H, D, label) {
  const out = new Uint8Array(W * H * D);
  if (!regionVoxels) return out;
  const target = label & 0xff;
  const n = Math.min(out.length, regionVoxels.length);
  for (let i = 0; i < n; i += 1) if (regionVoxels[i] === target) out[i] = 1;
  return out;
}

function sample(mask, W, H, D, x, y, z) {
  if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) return 0;
  return mask[z * W * H + y * W + x];
}

/**
 * Marching cubes. Returns { positions: Float32Array (xyz triples), indices:
 * Uint32Array }. Triangles are wound so face normals point OUT of the labelled
 * region (toward background), via the iso convention inside < iso == "in".
 */
export function marchingCubes({ mask, W, H, D, iso = 0.5 } = {}) {
  const positions = [];
  const indices = [];
  // Cache vertices per shared edge so neighbouring cubes reuse them, producing a
  // watertight mesh where each interior edge is shared by exactly two triangles.
  const vertexCache = new Map();
  const edgeVerts = new Array(12);

  const cornerValue = (cx, cy, cz, c) => sample(mask, W, H, D, cx + CORNER[c][0], cy + CORNER[c][1], cz + CORNER[c][2]);

  const interpEdge = (cx, cy, cz, e) => {
    const [a, b] = EDGE[e];
    const pa = [cx + CORNER[a][0], cy + CORNER[a][1], cz + CORNER[a][2]];
    const pb = [cx + CORNER[b][0], cy + CORNER[b][1], cz + CORNER[b][2]];
    // Stable key from the two endpoint grid coords (order-independent).
    const ka = (pa[2] * (H + 1) + pa[1]) * (W + 1) + pa[0];
    const kb = (pb[2] * (H + 1) + pb[1]) * (W + 1) + pb[0];
    const key = ka < kb ? `${ka}_${kb}` : `${kb}_${ka}`;
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;
    // Binary field: crossing at the midpoint.
    const idx = positions.length / 3;
    positions.push((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2);
    vertexCache.set(key, idx);
    return idx;
  };

  for (let z = -1; z < D; z += 1) {
    for (let y = -1; y < H; y += 1) {
      for (let x = -1; x < W; x += 1) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c += 1) {
          if (cornerValue(x, y, z, c) >= iso) cubeIndex |= (1 << c);
        }
        const edges = EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;
        for (let e = 0; e < 12; e += 1) {
          edgeVerts[e] = (edges & (1 << e)) ? interpEdge(x, y, z, e) : -1;
        }
        const tris = TRI_TABLE[cubeIndex];
        // Bourke's table winds for inward normals under the "corner>=iso == in"
        // convention; reverse each triangle so face normals point OUT of the
        // labelled region (positive enclosed volume).
        for (let t = 0; t < tris.length; t += 3) {
          indices.push(edgeVerts[tris[t]], edgeVerts[tris[t + 2]], edgeVerts[tris[t + 1]]);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}
