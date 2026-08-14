// Pure raw-plane quantification helpers. Canvas coordinates are pixel-edge coordinates;
// scalar samples live at pixel centers (x + 0.5, y + 0.5).

function validPlane(plane) {
  const width = Number(plane?.width);
  const height = Number(plane?.height);
  return Number.isInteger(width) && width > 0
    && Number.isInteger(height) && height > 0
    && plane?.pixels?.length === width * height;
}

function fail(reason) {
  return { ok: false, reason };
}

function finiteLine(line = {}) {
  const values = ['x1', 'y1', 'x2', 'y2'].map(key => Number(line[key]));
  return values.every(Number.isFinite) ? values : null;
}

function nearestValue(plane, x, y) {
  const px = Math.round(x - 0.5);
  const py = Math.round(y - 0.5);
  if (px < 0 || py < 0 || px >= plane.width || py >= plane.height) return null;
  return plane.pixels[py * plane.width + px];
}

function bilinearValue(plane, x, y) {
  const ux = x - 0.5;
  const uy = y - 0.5;
  const x0 = Math.floor(ux);
  const y0 = Math.floor(uy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= plane.width || y1 >= plane.height) return null;
  const tx = ux - x0;
  const ty = uy - y0;
  const a = plane.pixels[y0 * plane.width + x0];
  const b = plane.pixels[y0 * plane.width + x1];
  const c = plane.pixels[y1 * plane.width + x0];
  const d = plane.pixels[y1 * plane.width + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

export function sampleLineProfile(plane, line, {
  sampling = 'nearest', rowMm = null, colMm = null,
} = {}) {
  if (!validPlane(plane)) return fail('invalid_raw_plane');
  if (sampling !== 'nearest' && sampling !== 'bilinear') return fail('invalid_sampling');
  const coords = finiteLine(line);
  if (!coords) return fail('invalid_line');
  const [x1, y1, x2, y2] = coords;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthPx = Math.hypot(dx, dy);
  if (!(lengthPx > 0)) return fail('degenerate_line');
  const row = Number(rowMm);
  const col = Number(colMm);
  const calibrated = row > 0 && col > 0 && Number.isFinite(row) && Number.isFinite(col);
  const totalDistance = calibrated ? Math.hypot(dx * col, dy * row) : lengthPx;
  const count = Math.max(2, Math.ceil(lengthPx) + 1);
  const valueAt = sampling === 'bilinear' ? bilinearValue : nearestValue;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const fraction = index / (count - 1);
    const x = x1 + dx * fraction;
    const y = y1 + dy * fraction;
    const value = valueAt(plane, x, y);
    if (!Number.isFinite(value)) return fail(value == null ? 'line_out_of_bounds' : 'nonfinite_raw_value');
    samples.push({ distance: totalDistance * fraction, value, x, y });
  }
  return {
    ok: true,
    sampling,
    samples,
    totalDistance,
    distanceUnit: calibrated ? 'mm' : 'px',
    calibrated,
  };
}

// Pearson is evaluated over all included pixels. Manders uses strict signal-above-threshold
// denominators/numerators so thresholds remain explicit, reproducible provenance.
export function pixelwiseColocalization(planeA, planeB, {
  thresholdA, thresholdB, mask = null,
} = {}) {
  if (!validPlane(planeA) || !validPlane(planeB)
    || planeA.width !== planeB.width || planeA.height !== planeB.height) return fail('incompatible_raw_planes');
  const ta = Number(thresholdA);
  const tb = Number(thresholdB);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta < 0 || tb < 0) return fail('invalid_threshold');
  if (mask != null && typeof mask !== 'function') return fail('invalid_mask');
  let n = 0;
  let meanA = 0, meanB = 0, varianceA = 0, varianceB = 0, covariance = 0;
  let aboveA = 0, aboveB = 0, coincidentA = 0, coincidentB = 0;
  for (let index = 0; index < planeA.pixels.length; index += 1) {
    const x = index % planeA.width;
    const y = Math.floor(index / planeA.width);
    if (mask && !mask(x + 0.5, y + 0.5, index)) continue;
    const a = planeA.pixels[index];
    const b = planeB.pixels[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return fail('nonfinite_raw_value');
    if (a < 0 || b < 0) return fail('negative_raw_value');
    n += 1;
    const deltaA = a - meanA;
    const deltaB = b - meanB;
    meanA += deltaA / n;
    meanB += deltaB / n;
    varianceA += deltaA * (a - meanA);
    varianceB += deltaB * (b - meanB);
    covariance += deltaA * (b - meanB);
    if (a > ta) aboveA += a;
    if (b > tb) aboveB += b;
    if (a > ta && b > tb) {
      coincidentA += a;
      coincidentB += b;
    }
  }
  if (n < 2) return fail('too_few_pixels');
  if (!(varianceA > 0) || !(varianceB > 0)) return fail('constant_intensity');
  if (!(aboveA > 0) || !(aboveB > 0)) return fail('no_signal_above_threshold');
  const pearson = covariance / Math.sqrt(varianceA * varianceB);
  return {
    ok: true,
    pixels: n,
    pearson,
    tM1: coincidentA / aboveA,
    tM2: coincidentB / aboveB,
    thresholdA: ta,
    thresholdB: tb,
  };
}
