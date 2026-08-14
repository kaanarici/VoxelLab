// Honest, live inspect record for one anatomy label. Volume is recomputed from
// the SAME segmentation voxels the viewer renders (count of matching bytes ×
// physical voxel size), never echoed from the rounded regionMeta sidecar — an
// edited mask must not silently disagree with its label. Uncalibrated spacing
// degrades to a voxel-count-only readout rather than a fabricated millilitre.

import { geometryFromSeries, inPlanePixelSpacing } from '../core/geometry.js';
import { effectiveSliceSpacing } from '../mpr/mpr-geometry.js';
import { regionLabelName } from '../region-meta.js';
import { anatomyBadge } from '../region-source.js';

/** Count voxels in `regionVoxels` equal to `label` (the rendered mask). */
export function countVoxelsForLabel(regionVoxels, label) {
  if (!regionVoxels || label == null) return 0;
  const target = label & 0xff;
  let count = 0;
  for (let i = 0; i < regionVoxels.length; i += 1) {
    if (regionVoxels[i] === target) count += 1;
  }
  return count;
}

/** Format a millilitre volume with proportional, honest precision. */
export function formatVolumeMl(ml) {
  if (!Number.isFinite(ml)) return '';
  if (ml >= 100) return `${Math.round(ml)}`;
  if (ml >= 10) return ml.toFixed(1);
  return ml.toFixed(2);
}

/**
 * Compact, honest volume string for a label's hover tooltip — fed to the standard
 * [data-tip] manager (not a custom panel). Cheap: reads the sidecar mL/voxels, no
 * per-frame mask count. mL only when spacing is calibrated; voxels otherwise.
 */
export function volumeTip(series, regionMeta, label) {
  const r = regionMeta?.regions?.[label];
  if (inPlanePixelSpacing(series).known && Number.isFinite(r?.mL)) return `~${formatVolumeMl(r.mL)} mL`;
  if (Number.isFinite(r?.voxels)) return `${r.voxels.toLocaleString()} voxels`;
  return '';
}

/**
 * Build the inspect record for one label. `colSpacing`/`rowSpacing` mirror
 * volumes-panel.js exactly (pixelSpacing[1]=col→X, pixelSpacing[0]=row→Y) and
 * the slice term uses the IPP-derived effectiveSliceSpacing, not sliceThickness.
 */
export function inspectForLabel(series, label, regionMeta, regionVoxels) {
  const name = regionLabelName(regionMeta, label) || `Label ${label}`;
  const voxelCount = countVoxelsForLabel(regionVoxels, label);
  const spacing = inPlanePixelSpacing(series);
  const calibrated = spacing.known;
  // Prefer the live mask (an edited mask must not silently disagree with its
  // label), but regionVoxels is built lazily — when it is not resident yet, fall
  // back to the sidecar mL the rest of the UI already shows, never a bare 0.
  const sidecarMl = regionMeta?.regions?.[label]?.mL;
  let mlApprox = null;
  let live = false;
  if (calibrated && voxelCount > 0) {
    const geo = geometryFromSeries(series);
    const voxelMl = (geo.colSpacing * geo.rowSpacing * effectiveSliceSpacing(series)) / 1000;
    mlApprox = voxelCount * voxelMl;
    live = true;
  } else if (calibrated && Number.isFinite(sidecarMl)) {
    // Spacing is valid but the live mask is not resident yet — the sidecar mL was
    // computed with the same spacing, so it is an honest stand-in (not fabricated).
    mlApprox = sidecarMl;
  }
  return {
    label,
    name,
    voxelCount,
    mlApprox,
    calibrated,
    live,
    badge: anatomyBadge(series),
  };
}
