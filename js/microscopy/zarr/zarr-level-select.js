import { DEFAULT_MAX_OME_ZARR_PLANE_PIXELS } from './zarr-resource-budget.js';

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function planePixels(level) {
  const width = positiveNumber(level?.width, 0);
  const height = positiveNumber(level?.height, 0);
  return width > 0 && height > 0 ? width * height : 0;
}

function levelLabel(level, fallbackIndex) {
  return level?.level ?? fallbackIndex;
}

function reasonFor(selection, budget) {
  const text = `level ${selection.path || selection.level}`;
  const size = `${selection.width}x${selection.height}`;
  return `Selected coarsest pyramid ${text} (${size}, ${selection.pixels} pixels) within ${budget} pixel budget.`;
}

export function selectPyramidLevel(levels, { maxPlanePixels = DEFAULT_MAX_OME_ZARR_PLANE_PIXELS } = {}) {
  const budget = Math.min(positiveNumber(maxPlanePixels, DEFAULT_MAX_OME_ZARR_PLANE_PIXELS), DEFAULT_MAX_OME_ZARR_PLANE_PIXELS);
  const candidates = Array.from(levels || [])
    .map((level, index) => ({
      index,
      level: levelLabel(level, index),
      path: String(level?.path ?? levelLabel(level, index)),
      width: positiveNumber(level?.width, 0),
      height: positiveNumber(level?.height, 0),
      downsample: positiveNumber(level?.downsample, 1),
      pixels: planePixels(level),
    }))
    .filter((level) => level.pixels > 0);

  if (!candidates.length) {
    return {
      level: null,
      path: '',
      width: 0,
      height: 0,
      downsample: 1,
      reason: 'No pyramid levels are available.',
    };
  }

  const byCoarsest = (left, right) =>
    left.pixels - right.pixels
    || right.downsample - left.downsample
    || right.index - left.index;

  const eligible = candidates.filter((level) => level.pixels <= budget).sort(byCoarsest);
  const selected = eligible[0];
  if (!selected) {
    const coarsest = candidates.slice().sort(byCoarsest)[0];
    return {
      level: null,
      path: '',
      width: 0,
      height: 0,
      downsample: 1,
      reason: `No pyramid level fits ${budget} pixel budget; coarsest level ${coarsest.path || coarsest.level} is ${coarsest.pixels} pixels.`,
    };
  }

  return {
    level: selected.level,
    path: selected.path,
    width: selected.width,
    height: selected.height,
    downsample: selected.downsample,
    reason: reasonFor(selected, budget),
  };
}
