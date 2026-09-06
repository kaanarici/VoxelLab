import { geometryFromSeries, inPlanePixelSpacing } from '../core/geometry.js';
import { effectiveSliceSpacing } from '../mpr/mpr-geometry.js';
import { regionLabelName } from '../core/region-meta.js';
import { anatomyBadge } from '../region-source.js';

export function countVoxelsForLabel(regionVoxels, label) {
  if (!regionVoxels || label == null) return 0;
  const target = label & 0xff;
  let count = 0;
  for (let i = 0; i < regionVoxels.length; i += 1) {
    if (regionVoxels[i] === target) count += 1;
  }
  return count;
}

export function formatVolumeMl(ml) {
  if (!Number.isFinite(ml)) return '';
  if (ml >= 100) return `${Math.round(ml)}`;
  if (ml >= 10) return ml.toFixed(1);
  return ml.toFixed(2);
}

export function volumeTip(series, regionMeta, label) {
  const r = regionMeta?.regions?.[label];
  if (inPlanePixelSpacing(series).known && Number.isFinite(r?.mL)) return `~${formatVolumeMl(r.mL)} mL`;
  if (Number.isFinite(r?.voxels)) return `${r.voxels.toLocaleString()} voxels`;
  return '';
}

export function inspectForLabel(series, label, regionMeta, regionVoxels) {
  const name = regionLabelName(regionMeta, label) || `Label ${label}`;
  const voxelCount = countVoxelsForLabel(regionVoxels, label);
  const spacing = inPlanePixelSpacing(series);
  const calibrated = spacing.known;

  const sidecarMl = regionMeta?.regions?.[label]?.mL;
  let mlApprox = null;
  let live = false;
  if (calibrated && voxelCount > 0) {
    const geo = geometryFromSeries(series);
    const voxelMl = (geo.colSpacing * geo.rowSpacing * effectiveSliceSpacing(series)) / 1000;
    mlApprox = voxelCount * voxelMl;
    live = true;
  } else if (calibrated && Number.isFinite(sidecarMl)) {

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
