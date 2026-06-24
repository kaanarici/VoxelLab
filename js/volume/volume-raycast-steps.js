const DEFAULT_RAYCAST_STEPS = 512;
export const MAX_RAYCAST_STEPS = 2048;

export function raycastStepCount({ width = 1, height = 1, depth = 1, renderMode = 'alpha' } = {}) {
  if (renderMode !== 'mip' && renderMode !== 'minip') return DEFAULT_RAYCAST_STEPS;
  const longestAxis = Math.max(Number(width) || 1, Number(height) || 1, Number(depth) || 1);
  return Math.max(DEFAULT_RAYCAST_STEPS, Math.min(MAX_RAYCAST_STEPS, Math.ceil(longestAxis)));
}
