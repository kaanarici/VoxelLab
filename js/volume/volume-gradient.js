// Precomputes a per-voxel surface-normal + edge texture for the volume raycaster.
//
// The fragment shader otherwise reconstructs the gradient on the fly with a
// 6-tap central difference at every shaded sample — by far the heaviest part of
// the march. Baking it once collapses that to a single texture fetch. The result
// is a close visual match to the 6-tap path, not a bit-exact one: it carries
// 8-bit quantization and interpolates the baked values rather than re-deriving
// them per sample, so shading/edges can differ slightly at strong boundaries.
//
// Layout (RGBA8, sampled linearly):
//   rgb = unit gradient direction encoded as n * 0.5 + 0.5
//         (flat voxels decode to ~0; flatness is detected via the edge term)
//   a   = clamp(|grad| * 8, 0, 1)   — edge term; exactly 0 on flat voxels, which
//         is what the shader keys off to pick the flat-vs-surface lighting branch

/**
 * @param {Uint8Array|Float32Array} src   intensity volume, z-major (z*W*H + y*W + x)
 * @param {number} isFloat                truthy: src already in [0,1]; else uint8/255
 * @returns {Uint8Array} length W*H*D*4
 */
export function computeGradientRGBA8(src, W, H, D, isFloat) {
  const WH = W * H;
  const out = new Uint8Array(WH * D * 4);
  const s = isFloat ? 1 : 1 / 255;
  let o = 0;
  for (let z = 0; z < D; z++) {
    const zm = (z > 0 ? z - 1 : 0) * WH;
    const zp = (z < D - 1 ? z + 1 : D - 1) * WH;
    const z0 = z * WH;
    for (let y = 0; y < H; y++) {
      const ym = (y > 0 ? y - 1 : 0) * W;
      const yp = (y < H - 1 ? y + 1 : H - 1) * W;
      const y0 = y * W;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < W - 1 ? x + 1 : W - 1;
        // Central difference (one-sided at borders, matching clamp-to-edge sampling).
        const dx = (src[z0 + y0 + xp] - src[z0 + y0 + xm]) * s;
        const dy = (src[z0 + yp + x] - src[z0 + ym + x]) * s;
        const dz = (src[zp + y0 + x] - src[zm + y0 + x]) * s;
        const gmag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let nx = 0.5, ny = 0.5, nz = 0.5;
        if (gmag > 1e-4) {
          const inv = 0.5 / gmag;
          nx = dx * inv + 0.5; ny = dy * inv + 0.5; nz = dz * inv + 0.5;
        }
        out[o]     = (nx * 255 + 0.5) | 0;
        out[o + 1] = (ny * 255 + 0.5) | 0;
        out[o + 2] = (nz * 255 + 0.5) | 0;
        const e8 = gmag * 8;
        out[o + 3] = e8 >= 1 ? 255 : (e8 * 255 + 0.5) | 0;
        o += 4;
      }
    }
  }
  return out;
}
