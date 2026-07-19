// Mesh export orchestrator (impure edge): turn segmentation label masks into
// true-to-life 3D surface meshes and download them. Per-item exports one
// structure; whole-study merges every label. Geometry flows: binary mask →
// marching cubes (voxel space) → affine to patient LPS mm → STL/OBJ encode →
// blob download (the same anchor pattern as roi-results-export, the only
// cross-target path since Electron exposes no save IPC here).

import { state } from '../core/state.js';
import { geometryFromSeries } from '../core/geometry.js';
import { regionLabelName } from '../region-meta.js';
import { notify } from '../notify.js';
import { allLabelsFromMeta } from '../atlas/label-selection.js';
import { ensureActiveOverlayVolumes, ensureRegionVoxelsSync } from '../overlay/overlay-volumes.js';
import { binaryMaskForLabel, marchingCubes } from './marching-cubes.js';
import { applyAffineToPositions } from './mesh-transform.js';
import { encodeObj, encodeStlBinary, mergeMeshes } from './mesh-encoders.js';

const MIME = {
  stl: 'model/stl',
  obj: 'model/obj',
};

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'structure';
}

function exportOutcome(ok, message, extras = {}) {
  return { ok, message, ...extras };
}

function finishExport(result, opts = {}) {
  if (opts.notify && result.message) {
    notify(result.message, {
      id: result.ok ? 'mesh-export-complete' : 'mesh-export-unavailable',
      duration: result.ok ? 1800 : 4200,
    });
  }
  return result;
}

function formatName(fmt) {
  return fmt === 'obj' ? 'OBJ' : 'STL';
}

export function downloadMeshBlob(data, filename, fmt) {
  const blob = new Blob([data], { type: MIME[fmt] || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function regionVoxelsFor(series) {
  const cached = ensureRegionVoxelsSync(series);
  if (cached) return cached;
  ensureActiveOverlayVolumes();
  return ensureRegionVoxelsSync(series);
}

/** Build a patient-space surface mesh for one label, or null when it has no voxels. */
function buildLabelMesh(series, voxels, affine, label) {
  const W = series.width | 0;
  const H = series.height | 0;
  const D = series.slices | 0;
  const mask = binaryMaskForLabel(voxels, W, H, D, label);
  const { positions, indices } = marchingCubes({ mask, W, H, D });
  if (!indices.length) return null;
  return { positions: applyAffineToPositions(positions, affine), indices };
}

function encode(mesh, fmt, name) {
  if (fmt === 'obj') return encodeObj({ ...mesh, name });
  return encodeStlBinary({ ...mesh, name });
}

/** Export one segmentation structure as an STL/OBJ surface mesh. */
export function exportLabelMesh(series = state.manifest?.series?.[state.seriesIdx], label, fmt = 'stl', opts = {}) {
  const format = fmt === 'obj' ? 'obj' : 'stl';
  if (!series) return finishExport(exportOutcome(false, 'No loaded series available for mesh export.', { reason: 'no-series' }), opts);
  if (label == null) return finishExport(exportOutcome(false, 'No structure selected for mesh export.', { reason: 'no-label' }), opts);
  const voxels = regionVoxelsFor(series);
  if (!voxels) {
    return finishExport(exportOutcome(false, 'Segmentation labels are still loading or unavailable for this series.', { reason: 'labels-unavailable' }), opts);
  }
  const affine = geometryFromSeries(series).affineLps;
  const mesh = buildLabelMesh(series, voxels, affine, Number(label));
  const name = regionLabelName(state.regionMeta, label) || `label-${label}`;
  if (!mesh) return finishExport(exportOutcome(false, `${name} has no exportable surface voxels.`, { reason: 'empty-label' }), opts);
  const data = encode(mesh, format, name);
  const filename = `${slugify(series.slug || 'series')}-${slugify(name)}.${format}`;
  downloadMeshBlob(data, filename, format);
  return finishExport(exportOutcome(true, `Exported ${name} mesh as ${formatName(format)}.`, {
    filename,
    format,
    label: Number(label),
  }), opts);
}

/**
 * Export the whole study (every anatomy label) as one 3D object. OBJ keeps a
 * named group per structure (shared vertex list); STL is a merged triangle soup.
 */
export function exportStudyMesh(series = state.manifest?.series?.[state.seriesIdx], fmt = 'stl', opts = {}) {
  const format = fmt === 'obj' ? 'obj' : 'stl';
  if (!series) return finishExport(exportOutcome(false, 'No loaded series available for mesh export.', { reason: 'no-series' }), opts);
  const voxels = regionVoxelsFor(series);
  if (!voxels) {
    return finishExport(exportOutcome(false, 'Segmentation labels are still loading or unavailable for this series.', { reason: 'labels-unavailable' }), opts);
  }
  const affine = geometryFromSeries(series).affineLps;
  const labels = [...allLabelsFromMeta(state.regionMeta)].sort((a, b) => a - b);
  if (!labels.length) {
    return finishExport(exportOutcome(false, 'No anatomy labels are available for mesh export.', { reason: 'no-labels' }), opts);
  }
  const parts = [];
  for (const label of labels) {
    const mesh = buildLabelMesh(series, voxels, affine, label);
    if (mesh) parts.push({ ...mesh, name: regionLabelName(state.regionMeta, label) || `label-${label}` });
  }
  if (!parts.length) {
    return finishExport(exportOutcome(false, 'No anatomy structures have exportable surface voxels.', { reason: 'empty-labels' }), opts);
  }
  const filename = `${slugify(series.slug || 'series')}-segmentations.${format}`;
  if (format === 'obj') {
    downloadMeshBlob(encodeObj({ parts }), filename, format);
  } else {
    downloadMeshBlob(encodeStlBinary({ ...mergeMeshes(parts), name: 'segmentations' }), filename, format);
  }
  return finishExport(exportOutcome(true, `Exported ${parts.length} structure mesh${parts.length === 1 ? '' : 'es'} as ${formatName(format)}.`, {
    filename,
    format,
    labels: parts.map(part => part.name),
  }), opts);
}
