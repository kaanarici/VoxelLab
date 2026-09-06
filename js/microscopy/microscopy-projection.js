export function projectStack(planes, { mode = 'max', zRange = null } = {}) {
  if (!Array.isArray(planes) || planes.length === 0) throw new Error('projectStack: no planes');
  const W = planes[0].width | 0;
  const H = planes[0].height | 0;
  for (const p of planes) {
    if ((p.width | 0) !== W || (p.height | 0) !== H) throw new Error('projectStack: plane size mismatch');
  }
  const lo = zRange ? Math.max(0, zRange[0] | 0) : 0;
  const hi = zRange ? Math.min(planes.length - 1, zRange[1] | 0) : planes.length - 1;
  if (hi < lo) throw new Error('projectStack: empty z range');
  const N = hi - lo + 1;
  const len = W * H;
  const out = new Float64Array(len);

  if (mode === 'max') {
    out.fill(-Infinity);
    for (let z = lo; z <= hi; z++) {
      const px = planes[z].pixels;
      for (let i = 0; i < len; i++) if (px[i] > out[i]) out[i] = px[i];
    }
  } else if (mode === 'mean' || mode === 'sum') {
    for (let z = lo; z <= hi; z++) {
      const px = planes[z].pixels;
      for (let i = 0; i < len; i++) out[i] += px[i];
    }
    if (mode === 'mean') for (let i = 0; i < len; i++) out[i] /= N;
  } else if (mode === 'sd') {
    const mean = new Float64Array(len);
    for (let z = lo; z <= hi; z++) {
      const px = planes[z].pixels;
      for (let i = 0; i < len; i++) mean[i] += px[i];
    }
    for (let i = 0; i < len; i++) mean[i] /= N;
    const m2 = new Float64Array(len);
    for (let z = lo; z <= hi; z++) {
      const px = planes[z].pixels;
      for (let i = 0; i < len; i++) { const d = px[i] - mean[i]; m2[i] += d * d; }
    }

    for (let i = 0; i < len; i++) out[i] = N > 1 ? Math.sqrt(m2[i] / (N - 1)) : 0;
  } else {
    throw new Error(`projectStack: unknown mode ${mode}`);
  }
  return { pixels: out, width: W, height: H, mode, zRange: [lo, hi] };
}
