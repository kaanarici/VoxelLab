const DEFAULT_MAX_PLANE_PIXELS = 4_000_000;

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

function reasonFor(selection, budget, withinBudget) {
  const text = `level ${selection.path || selection.level}`;
  const size = `${selection.width}x${selection.height}`;
  if (withinBudget) {
    return `Selected coarsest pyramid ${text} (${size}, ${selection.pixels} pixels) within ${budget} pixel budget.`;
  }
  return `Selected coarsest available pyramid ${text} (${size}, ${selection.pixels} pixels); no level fits ${budget} pixel budget.`;
}

export function selectPyramidLevel(levels, { maxPlanePixels = DEFAULT_MAX_PLANE_PIXELS } = {}) {
  const budget = positiveNumber(maxPlanePixels, DEFAULT_MAX_PLANE_PIXELS);
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
  const selected = eligible[0] || candidates.slice().sort(byCoarsest)[0];
  const withinBudget = selected.pixels <= budget;

  return {
    level: selected.level,
    path: selected.path,
    width: selected.width,
    height: selected.height,
    downsample: selected.downsample,
    reason: reasonFor(selected, budget, withinBudget),
  };
}
