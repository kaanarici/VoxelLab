function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ellipsePerimeter(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

function polygonPerimeter(points, scaleX = 1, scaleY = 1) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += Math.hypot((x2 - x1) * scaleX, (y2 - y1) * scaleY);
  }
  return total;
}

export function roiPerimeterValues({
  kind = '',
  points = [],
  series = {},
  stats = {},
} = {}) {
  // Traced particle outlines carry an authoritative ImageJ corner-corrected perimeter; a plain
  // euclidean recompute of the staircase polygon would overstate it, so honor the stored value.
  if (stats.perimeterMethod === 'imagej-traced') {
    return { mm: finiteNumber(stats.perimeter_mm), px: finiteNumber(stats.perimeter_px) };
  }
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing.map(finiteNumber) : [];
  const xyKnown = spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0 && series._spacingKnown !== false;
  let perimeterPx = null;
  let perimeterMm = null;
  if (kind === 'ellipse' && points.length >= 2) {
    const [[x1, y1], [x2, y2]] = points;
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    perimeterPx = ellipsePerimeter(rx, ry);
    perimeterMm = xyKnown ? ellipsePerimeter(rx * spacing[1], ry * spacing[0]) : null;
  } else if (kind === 'polygon') {
    perimeterPx = polygonPerimeter(points);
    perimeterMm = xyKnown ? polygonPerimeter(points, spacing[1], spacing[0]) : null;
  }
  return {
    mm: perimeterMm ?? finiteNumber(stats.perimeter_mm),
    px: perimeterPx ?? finiteNumber(stats.perimeter_px),
  };
}

export function roiCircularityValue({
  areaMm2 = null,
  pixels = null,
  perimeterMm = null,
  perimeterPx = null,
} = {}) {
  const physicalArea = finiteNumber(areaMm2);
  const physicalPerimeter = finiteNumber(perimeterMm);
  if (physicalArea > 0 && physicalPerimeter > 0) {
    return Math.min(1, (4 * Math.PI * physicalArea) / (physicalPerimeter * physicalPerimeter));
  }
  const pixelArea = finiteNumber(pixels);
  const pixelPerimeter = finiteNumber(perimeterPx);
  if (pixelArea > 0 && pixelPerimeter > 0) {
    return Math.min(1, (4 * Math.PI * pixelArea) / (pixelPerimeter * pixelPerimeter));
  }
  return null;
}

export function roiCoordinateValues(point = {}, series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing.map(finiteNumber) : [];
  const xyKnown = spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0 && series._spacingKnown !== false;
  const xPx = finiteNumber(point.x);
  const yPx = finiteNumber(point.y);
  return {
    xMm: xyKnown && xPx != null ? xPx * spacing[1] : null,
    yMm: xyKnown && yPx != null ? yPx * spacing[0] : null,
  };
}
