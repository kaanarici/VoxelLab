const MIN_RAYCAST_STEPS = 128;
export const MAX_RAYCAST_STEPS = 2048;

export function volumeProjectionSamplingSupport({ width = 1, height = 1, depth = 1 } = {}) {
  const longestAxis = Math.max(Number(width) || 1, Number(height) || 1, Number(depth) || 1);
  const requiredSteps = Math.ceil(Math.hypot(
    Math.max(0, (Number(width) || 1) - 1),
    Math.max(0, (Number(height) || 1) - 1),
    Math.max(0, (Number(depth) || 1) - 1),
  )) + 1;
  return {
    supported: requiredSteps <= MAX_RAYCAST_STEPS,
    longestAxis,
    requiredSteps,
    maximum: MAX_RAYCAST_STEPS,
  };
}

export function raycastStepCount({ width = 1, height = 1, depth = 1 } = {}) {
  const support = volumeProjectionSamplingSupport({ width, height, depth });
  return Math.max(MIN_RAYCAST_STEPS, Math.min(MAX_RAYCAST_STEPS, support.requiredSteps));
}
