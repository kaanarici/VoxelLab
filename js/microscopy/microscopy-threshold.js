// Intensity thresholding on a raw single-channel plane. Pure, no DOM.
// computeThreshold resolves a numeric cut (never a method string) so recipe replay is
// deterministic; applyThreshold turns a [lo,hi] band into a binary mask.

const DEFAULT_BINS = 256;

function planeHistogram(plane, bins = DEFAULT_BINS) {
  const px = plane.pixels;
  const len = (plane.width | 0) * (plane.height | 0);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = px[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 0; }
  const hist = new Float64Array(bins);
  const span = max - min;
  if (span <= 0) { hist[0] = len; return { hist, min, max, bins, span: 0 }; }
  for (let i = 0; i < len; i++) {
    let b = Math.floor(((px[i] - min) / span) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    hist[b]++;
  }
  return { hist, min, max, bins, span };
}

function binToValue(bin, min, span, bins) {
  // Center of the bin, mapped back to the raw value domain.
  return min + ((bin + 0.5) / bins) * span;
}

function otsuBin(hist, bins) {
  let total = 0, sumAll = 0;
  for (let i = 0; i < bins; i++) { total += hist[i]; sumAll += i * hist[i]; }
  if (total === 0) return 0;
  let wB = 0, sumB = 0, best = -1, bestVar = -1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best < 0 ? 0 : best;
}

function triangleBin(hist, bins) {
  let peak = 0;
  for (let i = 1; i < bins; i++) if (hist[i] > hist[peak]) peak = i;
  // Longer tail side from the peak.
  let lo = 0; while (lo < bins && hist[lo] === 0) lo++;
  let hi = bins - 1; while (hi > 0 && hist[hi] === 0) hi--;
  const useRight = (hi - peak) >= (peak - lo);
  const a = useRight ? peak : lo;
  const b = useRight ? hi : peak;
  const dx = b - a;
  const dy = hist[b] - hist[a];
  const norm = Math.hypot(dx, dy) || 1;
  let best = a, bestDist = -1;
  const from = Math.min(a, b), to = Math.max(a, b);
  for (let i = from; i <= to; i++) {
    const dist = Math.abs(dy * (i - a) - dx * (hist[i] - hist[a])) / norm;
    if (dist > bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

export function computeThreshold(plane, { method = 'otsu', value = null, darkBackground = true } = {}) {
  const { hist, min, max, bins, span } = planeHistogram(plane);
  let resolvedValue;
  if (method === 'manual') resolvedValue = Number(value);
  else if (method === 'otsu') resolvedValue = binToValue(otsuBin(hist, bins), min, span, bins);
  else if (method === 'triangle') resolvedValue = binToValue(triangleBin(hist, bins), min, span, bins);
  else throw new Error(`computeThreshold: unknown method ${method}`);
  if (!Number.isFinite(resolvedValue)) throw new Error('computeThreshold: unresolved threshold value');
  const band = darkBackground
    ? { lo: resolvedValue, hi: Infinity }
    : { lo: -Infinity, hi: resolvedValue };
  return {
    lo: band.lo,
    hi: band.hi,
    method,
    resolvedValue,
    darkBackground: !!darkBackground,
    pixelMin: min,
    pixelMax: max,
    histogramBins: bins,
  };
}

export function applyThreshold(plane, { lo, hi }) {
  const px = plane.pixels;
  const len = (plane.width | 0) * (plane.height | 0);
  const mask = new Uint8Array(len);
  for (let i = 0; i < len; i++) mask[i] = (px[i] >= lo && px[i] <= hi) ? 1 : 0;
  return mask;
}
