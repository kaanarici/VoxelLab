// Anatomical labels for the 3D view-preset buttons, derived from the series'
// patient orientation rather than hardcoded to axial. The 3D mesh maps voxel
// axes to world axes with no flips (worldX = column = patient `row`, worldY =
// row = patient `col`, worldZ = slice = `sliceDir`), so the anatomy a camera
// preset reveals is majorAxis(cameraDir · [row, col, sliceDir]). The old
// hardcoded axial-LPS labels show the WRONG side for native sagittal/coronal/
// feet-first acquisitions — a confident wrong-side claim, the worst kind.

import { geometryFromSeries } from './geometry.js';

// Camera direction (world axes) for each anatomical preset button.
const PRESET_DIR = {
  axial:    [0, 0, 1],
  bottom:   [0, 0, -1],
  coronal:  [0, -1, 0],
  back:     [0, 1, 0],
  sagittal: [1, 0, 0],
  right:    [-1, 0, 0],
};

// LPS axis sign → short button label + tooltip.
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
  if (ax >= ay && ax >= az) return x > 0 ? 'L' : 'R'; // +X LPS = Left
  if (ay >= ax && ay >= az) return y > 0 ? 'P' : 'A'; // +Y LPS = Posterior
  return z > 0 ? 'S' : 'I';                            // +Z LPS = Superior
}

/** True when the series has a real patient frame, so anatomical labels are meaningful. */
export function hasPatientFrame(series) {
  return !!series && series.orientation?.length >= 6 && series.imageDomain !== 'microscopy';
}

/**
 * Anatomical {short, tip} for each 3D view preset, computed from the series
 * basis. Returns null when the series has no real patient frame — callers should
 * then show neutral labels (NEUTRAL_VIEW_LABELS) rather than assert a side.
 */
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

/**
 * Acquisition plane (Axial / Coronal / Sagittal / Oblique) from the slice normal,
 * or null when there is no real patient frame — never assert a plane we can't
 * derive. Oblique when the normal isn't within ~30° of a patient axis.
 */
export function acquisitionPlane(series) {
  if (!hasPatientFrame(series)) return null;
  const { sliceDir } = geometryFromSeries(series);
  if (!sliceDir) return null;
  const a = sliceDir.map(Math.abs);
  const max = Math.max(a[0], a[1], a[2]);
  if (!(max > 0)) return null;
  if (max < 0.87) return 'Oblique';
  return ['Sagittal', 'Coronal', 'Axial'][a.indexOf(max)];
}

// Neutral labels when there is no patient frame — view-axis directions only, no
// anatomical claim (the volume's orientation to the patient is unknown).
export const NEUTRAL_VIEW_LABELS = {
  axial:    { short: 'Z+', tip: 'View along +Z (no patient orientation)' },
  bottom:   { short: 'Z−', tip: 'View along −Z (no patient orientation)' },
  coronal:  { short: 'Y−', tip: 'View along −Y (no patient orientation)' },
  back:     { short: 'Y+', tip: 'View along +Y (no patient orientation)' },
  sagittal: { short: 'X+', tip: 'View along +X (no patient orientation)' },
  right:    { short: 'X−', tip: 'View along −X (no patient orientation)' },
};
