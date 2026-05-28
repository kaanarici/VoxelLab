const LENGTH_UNITS_TO_MM = new Map([
  ['ym', 1e-21],
  ['yoctometer', 1e-21],
  ['yoctometre', 1e-21],
  ['zm', 1e-18],
  ['zeptometer', 1e-18],
  ['zeptometre', 1e-18],
  ['am', 1e-15],
  ['attometer', 1e-15],
  ['attometre', 1e-15],
  ['fm', 1e-12],
  ['femtometer', 1e-12],
  ['femtometre', 1e-12],
  ['pm', 1e-9],
  ['picometer', 1e-9],
  ['picometre', 1e-9],
  ['mm', 1],
  ['millimeter', 1],
  ['millimetre', 1],
  ['cm', 10],
  ['centimeter', 10],
  ['centimetre', 10],
  ['dm', 100],
  ['decimeter', 100],
  ['decimetre', 100],
  ['m', 1000],
  ['meter', 1000],
  ['metre', 1000],
  ['hm', 100000],
  ['hectometer', 100000],
  ['hectometre', 100000],
  ['km', 1000000],
  ['kilometer', 1000000],
  ['kilometre', 1000000],
  ['megameter', 1000000000],
  ['megametre', 1000000000],
  ['gigameter', 1000000000000],
  ['gigametre', 1000000000000],
  ['terameter', 1000000000000000],
  ['terametre', 1000000000000000],
  ['petameter', 1000000000000000000],
  ['petametre', 1000000000000000000],
  ['exameter', 1e21],
  ['exametre', 1e21],
  ['zettameter', 1e24],
  ['zettametre', 1e24],
  ['yottameter', 1e27],
  ['yottametre', 1e27],
  ['um', 0.001],
  ['µm', 0.001],
  ['micron', 0.001],
  ['micrometer', 0.001],
  ['micrometre', 0.001],
  ['nm', 0.000001],
  ['nanometer', 0.000001],
  ['nanometre', 0.000001],
  ['angstrom', 0.0000001],
  ['inch', 25.4],
  ['foot', 304.8],
  ['yard', 914.4],
  ['mile', 1609344],
  ['parsec', 3.085677581491367e22],
]);

const UNIT_LABELS = new Map([
  ['yoctometer', 'ym'],
  ['yoctometre', 'ym'],
  ['zeptometer', 'zm'],
  ['zeptometre', 'zm'],
  ['attometer', 'am'],
  ['attometre', 'am'],
  ['femtometer', 'fm'],
  ['femtometre', 'fm'],
  ['picometer', 'pm'],
  ['picometre', 'pm'],
  ['um', 'µm'],
  ['micron', 'µm'],
  ['micrometer', 'µm'],
  ['micrometre', 'µm'],
  ['angstrom', 'angstrom'],
  ['millimeter', 'mm'],
  ['millimetre', 'mm'],
  ['centimeter', 'cm'],
  ['centimetre', 'cm'],
  ['decimeter', 'dm'],
  ['decimetre', 'dm'],
  ['meter', 'm'],
  ['metre', 'm'],
  ['hectometer', 'hm'],
  ['hectometre', 'hm'],
  ['kilometer', 'km'],
  ['kilometre', 'km'],
  ['megameter', 'megameter'],
  ['megametre', 'megameter'],
  ['gigameter', 'gigameter'],
  ['gigametre', 'gigameter'],
  ['terameter', 'terameter'],
  ['terametre', 'terameter'],
  ['petameter', 'petameter'],
  ['petametre', 'petameter'],
  ['exametre', 'exameter'],
  ['zettametre', 'zettameter'],
  ['yottametre', 'yottameter'],
  ['nanometer', 'nm'],
  ['nanometre', 'nm'],
]);

function unitKey(unit = '') {
  return String(unit ?? '').trim().toLowerCase();
}

export function isKnownLengthUnit(unit = '') {
  const key = unitKey(unit);
  return !!key && (LENGTH_UNITS_TO_MM.has(key) || UNIT_LABELS.has(key));
}

export function normalizeLengthUnit(unit = 'mm') {
  const key = unitKey(unit) || 'mm';
  return UNIT_LABELS.get(key) || (LENGTH_UNITS_TO_MM.has(key) ? key : 'mm');
}

export function lengthUnitToMm(unit = 'mm') {
  const key = unitKey(unit) || 'mm';
  return LENGTH_UNITS_TO_MM.get(UNIT_LABELS.get(key) || key) || 1;
}

export function isMicroscopySeries(series = {}) {
  return series?.imageDomain === 'microscopy' || !!series?.microscopy;
}

export function preferredLengthUnit(series = {}) {
  if (isMicroscopySeries(series)) {
    return normalizeLengthUnit(series?.microscopy?.physicalUnit || series?.physicalUnit || 'µm');
  }
  return 'mm';
}

function decimalsFor(value) {
  const abs = Math.abs(value);
  if (abs >= 100) return 0;
  if (abs >= 10) return 1;
  if (abs >= 1) return 2;
  return 3;
}

export function formatLengthFromMm(valueMm, series = {}, fallback = 'px') {
  if (!Number.isFinite(valueMm)) return '—';
  const unit = preferredLengthUnit(series);
  if (!unit) return `${valueMm.toFixed(1)} ${fallback}`;
  const scale = 1 / lengthUnitToMm(unit);
  const value = valueMm * scale;
  return `${value.toFixed(decimalsFor(value))} ${unit}`;
}

export function formatAreaFromMm2(valueMm2, series = {}) {
  if (!Number.isFinite(valueMm2)) return '—';
  const unit = preferredLengthUnit(series);
  const scale = 1 / lengthUnitToMm(unit);
  const value = valueMm2 * scale * scale;
  return `${value.toFixed(decimalsFor(value))} ${unit}²`;
}

export function formatSpacingFromMm(valueMm, series = {}) {
  return formatLengthFromMm(valueMm, series);
}
