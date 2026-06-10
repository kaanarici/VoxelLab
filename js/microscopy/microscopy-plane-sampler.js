// Pure single-channel intensity sampler shared by raw-domain microscopy ROI stats and
// Analyze Particles. Reads one sample per pixel (`pixels[py*W+px]`) — NOT RGBA stride-4 —
// so it works directly on retained raw uint16/int16/uint8 plane buffers.

// plane:  { pixels: Float32Array|TypedArray, width, height }
// inside: (cx, cy) => boolean, tested at pixel centers (px+0.5, py+0.5)
// bbox:   { minX, maxX, minY, maxY } inclusive; clamped to the plane here.
// Returns { n, sum, sum2, min, max } (min=+Inf, max=-Inf when n===0) — callers derive
// mean = sum/n and variance = max(0, sum2/n - mean*mean).
export function samplePlaneIntensity(plane, inside, bbox = {}) {
  const W = plane.width | 0;
  const H = plane.height | 0;
  const px0 = Math.max(0, Math.floor(bbox.minX ?? 0));
  const px1 = Math.min(W - 1, Math.ceil(bbox.maxX ?? W - 1));
  const py0 = Math.max(0, Math.floor(bbox.minY ?? 0));
  const py1 = Math.min(H - 1, Math.ceil(bbox.maxY ?? H - 1));
  const data = plane.pixels;
  let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity;
  for (let py = py0; py <= py1; py++) {
    const row = py * W;
    for (let px = px0; px <= px1; px++) {
      if (!inside(px + 0.5, py + 0.5)) continue;
      const v = data[row + px];
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { n, sum, sum2, min, max };
}

export function boundsOfPoints(pts = []) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}
