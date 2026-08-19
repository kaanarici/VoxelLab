export const MPR_PROJECTION_MODES = ['thin', 'avg', 'mip', 'minip'];
export const MAX_ACCURATE_SLAB_SAMPLES = 513;
const MAX_SLAB_THICKNESS_MM = 160;
export const MAX_VOXEL_STEP = 0.5;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampObliqueYaw(value) {
  return Math.max(-180, Math.min(180, finite(value, 0)));
}

export function clampObliquePitch(value) {
  return Math.max(-90, Math.min(90, finite(value, 0)));
}

export function clampClipPlaneDepth(value) {
  return Math.max(0, Math.min(1, finite(value, 0.5)));
}

export function normalizeMprProjectionMode(mode) {
  return MPR_PROJECTION_MODES.includes(mode) ? mode : 'thin';
}

function positiveSpacing(spacing) {
  return {
    row: Number(spacing?.row) > 0 ? Number(spacing.row) : 1,
    col: Number(spacing?.col) > 0 ? Number(spacing.col) : 1,
    slice: Number(spacing?.slice) > 0 ? Number(spacing.slice) : 1,
  };
}

export function maximumAccurateSlabThicknessMm(spacing, maxSamples = MAX_ACCURATE_SLAB_SAMPLES) {
  const safe = positiveSpacing(spacing);
  const worstVoxelDistancePerMm = Math.max(1 / safe.col, 1 / safe.row, 1 / safe.slice);
  const maxStepMm = MAX_VOXEL_STEP / worstVoxelDistancePerMm;
  return Math.min(MAX_SLAB_THICKNESS_MM, Math.max(0, maxSamples - 1) * maxStepMm);
}

export function clampSlabThicknessMm(value, spacing = null) {
  const limit = spacing
    ? maximumAccurateSlabThicknessMm(spacing)
    : MAX_SLAB_THICKNESS_MM;
  return Math.max(0, Math.min(limit, Number(value) || 0));
}
