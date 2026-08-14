/**
 * Draw a binary mask as a transparent colored overlay on a canvas 2D context.
 */
export function overlayMask(ctx, result, opts = {}) {
  if (!ctx || !result || !result.mask) return;
  const { mask, width, height } = result;
  if (ctx.canvas && (ctx.canvas.width !== width || ctx.canvas.height !== height)) {
    console.warn(
      `[slimsam] mask size ${width}x${height} does not match canvas ` +
      `${ctx.canvas.width}x${ctx.canvas.height}`
    );
    return;
  }
  if (mask.length !== width * height) return;
  const color = Array.isArray(opts.color) ? opts.color : [];
  const r = opts.r ?? color[0] ?? 0;
  const g = opts.g ?? color[1] ?? 180;
  const b = opts.b ?? color[2] ?? 255;
  const a = Math.round((opts.a ?? opts.opacity ?? 0.35) * 255);
  const smooth = opts.smooth !== false;

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;

  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i] ? a : smoothEdgeAlpha(mask, width, height, i, a, smooth);
    if (!alpha) continue;
    const p = i * 4;
    const srcA = alpha / 255;
    const invA = 1 - srcA;
    d[p]     = Math.round(d[p]     * invA + r * srcA);
    d[p + 1] = Math.round(d[p + 1] * invA + g * srcA);
    d[p + 2] = Math.round(d[p + 2] * invA + b * srcA);
  }

  ctx.putImageData(imageData, 0, 0);
}

function smoothEdgeAlpha(mask, width, height, i, alpha, smooth) {
  if (!smooth) return 0;
  const x = i % width;
  const y = Math.floor(i / width);
  let neighbors = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      if (xx >= 0 && xx < width && mask[yy * width + xx]) neighbors += 1;
    }
  }
  return neighbors ? Math.round(alpha * Math.min(0.45, neighbors / 18)) : 0;
}
