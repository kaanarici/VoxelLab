function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(value, digits = 2) {
  const n = finiteNumber(value);
  if (n == null) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(digits);
}

// Intensity ROI sources whose integrated-density columns are derived from mean × area/pixels
// when not explicitly supplied: the 8-bit display domain and the raw 16-bit domain (D1b).
export function isIntensityValueSource(valueSource) {
  return valueSource === 'display_8bit' || valueSource === 'raw_16bit';
}

export function rawIntDenForRow(row = {}) {
  const explicit = finiteNumber(row.rawIntDen);
  if (explicit != null) return explicit;
  const mean = finiteNumber(row.mean);
  const pixels = finiteNumber(row.pixels);
  return mean != null && pixels != null && isIntensityValueSource(row.valueSource) ? mean * pixels : null;
}

export function intDenForRow(row = {}) {
  const explicit = finiteNumber(row.intDen);
  if (explicit != null) return explicit;
  const mean = finiteNumber(row.mean);
  const area = finiteNumber(row.areaUnit2);
  return mean != null && area != null && isIntensityValueSource(row.valueSource) ? mean * area : null;
}

export function intDenMm2ForRow(row = {}) {
  const explicit = finiteNumber(row.intDenMm2);
  if (explicit != null) return explicit;
  const mean = finiteNumber(row.mean);
  const area = finiteNumber(row.areaMm2);
  return mean != null && area != null && isIntensityValueSource(row.valueSource) ? mean * area : null;
}
