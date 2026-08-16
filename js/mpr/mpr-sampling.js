function sampleBilinearXY(vox, z, x, y, W, H) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const base = z * W * H;
  const c00 = vox[base + y0 * W + x0];
  const c10 = vox[base + y0 * W + x1];
  const c01 = vox[base + y1 * W + x0];
  const c11 = vox[base + y1 * W + x1];
  const top = c00 * (1 - fx) + c10 * fx;
  const bottom = c01 * (1 - fx) + c11 * fx;
  return top * (1 - fy) + bottom * fy;
}

export function sampleTrilinear(vox, x, y, z, W, H, D) {
  const cx = Math.max(0, Math.min(W - 1, x));
  const cy = Math.max(0, Math.min(H - 1, y));
  const cz = Math.max(0, Math.min(D - 1, z));
  const z0 = Math.floor(cz);
  const z1 = Math.min(D - 1, z0 + 1);
  const fraction = cz - z0;
  const lower = sampleBilinearXY(vox, z0, cx, cy, W, H);
  const upper = sampleBilinearXY(vox, z1, cx, cy, W, H);
  return lower * (1 - fraction) + upper * fraction;
}
