import { geometryFromSeries } from './geometry.js';

const PRESET_DIR = {
  axial:    [0, 0, 1],
  bottom:   [0, 0, -1],
  coronal:  [0, -1, 0],
  back:     [0, 1, 0],
  sagittal: [1, 0, 0],
  right:    [-1, 0, 0],
};

const ANAT = {
  L: { short: 'L', tip: 'Left lateral' },
  R: { short: 'R', tip: 'Right lateral' },
  A: { short: 'Front', tip: 'Anterior (front)' },
  P: { short: 'Back', tip: 'Posterior (back)' },
  S: { short: 'Top', tip: 'Superior (top-down)' },
  I: { short: 'Bottom', tip: 'Inferior (bottom-up)' },
};

function majorAxisLabel(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? 'L' : 'R';
  if (ay >= ax && ay >= az) return y > 0 ? 'P' : 'A';
  return z > 0 ? 'S' : 'I';
}

export function hasPatientFrame(series) {
  if (!series || series.imageDomain === 'microscopy') return false;
  if (series.patientFrameTrusted === true || series.patientFrameTrusted === false) return series.patientFrameTrusted;
  if (Object.hasOwn(series, '_niftiSpatialAffineLps')) return Array.isArray(series._niftiSpatialAffineLps);
  return series.orientation?.length >= 6;
}

function anatomicalPlaneForNormal(normal) {
  const absolute = normal.map(Math.abs);
  const maximum = Math.max(...absolute);
  if (!(maximum > 0) || maximum < 0.87) return 'Oblique';
  return ['Sagittal', 'Coronal', 'Axial'][absolute.indexOf(maximum)];
}

export function mprPaneLabels(series) {
  if (!hasPatientFrame(series)) {
    return {
      ax: 'Acquisition XY',
      co: 'Acquisition XZ',
      sa: 'Acquisition YZ',
      ob: 'Oblique · acquisition grid',
    };
  }
  const { row, col, sliceDir } = geometryFromSeries(series);
  return {
    ax: anatomicalPlaneForNormal(sliceDir),
    co: anatomicalPlaneForNormal(col),
    sa: anatomicalPlaneForNormal(row),
    ob: 'Oblique · acquisition grid',
  };
}

export function viewPresetAnatomy(series) {
  if (!hasPatientFrame(series)) return null;
  const { row, col, sliceDir } = geometryFromSeries(series);
  const out = {};
  for (const view in PRESET_DIR) {
    const p = PRESET_DIR[view];
    const x = p[0] * row[0] + p[1] * col[0] + p[2] * sliceDir[0];
    const y = p[0] * row[1] + p[1] * col[1] + p[2] * sliceDir[1];
    const z = p[0] * row[2] + p[1] * col[2] + p[2] * sliceDir[2];
    out[view] = ANAT[majorAxisLabel(x, y, z)];
  }
  return out;
}

export function acquisitionPlane(series) {
  if (!hasPatientFrame(series)) return null;
  const { sliceDir } = geometryFromSeries(series);
  if (!sliceDir) return null;
  return anatomicalPlaneForNormal(sliceDir);
}

export const NEUTRAL_VIEW_LABELS = {
  axial:    { short: 'Z+', tip: 'View along +Z (no patient orientation)' },
  bottom:   { short: 'Z−', tip: 'View along −Z (no patient orientation)' },
  coronal:  { short: 'Y−', tip: 'View along −Y (no patient orientation)' },
  back:     { short: 'Y+', tip: 'View along +Y (no patient orientation)' },
  sagittal: { short: 'X+', tip: 'View along +X (no patient orientation)' },
  right:    { short: 'X−', tip: 'View along −X (no patient orientation)' },
};
