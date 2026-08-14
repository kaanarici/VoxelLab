// Normalizes one retained microscopy C/T stack for the shared MPR/3D path.
// The result intentionally matches the 2D canvas normalization: each active
// C/T stack gets its own raw range and MINISWHITE planes invert after scaling.

import { rawVolumeResourceBudget } from '../volume/volume-raw-normalize.js';

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Microscopy volume ${label} must be a positive safe integer.`);
  }
  return number;
}

export function microscopyVolumeFailureReason(error) {
  return /^raw volume resource limit:/i.test(String(error?.message || ''))
    ? 'volume_resource_limit'
    : 'volume_data_invalid';
}

export function microscopyZCoverage(planes, declaredSizeZ) {
  const expectedSizeZ = positiveInteger(declaredSizeZ, 'declared Z size');
  const positions = Array.isArray(planes)
    ? planes.map(plane => Number(plane?.z))
    : [];
  const validPositions = positions.length > 0
    && positions.every(Number.isSafeInteger)
    && positions.every((position, index) => index === 0 || position > positions[index - 1]);
  const contiguous = validPositions
    && positions.every((position, index) => position === positions[0] + index);
  const complete = contiguous
    && positions.length === expectedSizeZ
    && positions[0] === 0
    && positions[positions.length - 1] === expectedSizeZ - 1;
  return {
    complete,
    contiguous,
    positions,
    firstZ: validPositions ? positions[0] : 0,
    lastZ: validPositions ? positions[positions.length - 1] : 0,
  };
}

export function microscopyRawVolumeForPlanes(planes, width, height, declaredSizeZ = planes?.length) {
  const expectedWidth = positiveInteger(width, 'width');
  const expectedHeight = positiveInteger(height, 'height');
  const coverage = microscopyZCoverage(planes, declaredSizeZ);
  if (!coverage.complete || planes.length < 2) {
    throw new Error('Microscopy volume needs complete contiguous Z coverage with at least two planes.');
  }
  const budget = rawVolumeResourceBudget(expectedWidth, expectedHeight, planes.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (const plane of planes) {
    if (Number(plane?.width) !== expectedWidth || Number(plane?.height) !== expectedHeight
      || Number(plane?.pixels?.length) !== expectedWidth * expectedHeight) {
      throw new Error('Microscopy volume planes must have one consistent pixel grid.');
    }
    for (const value of plane.pixels) {
      if (!Number.isFinite(value)) throw new Error('Microscopy volume pixels must be finite.');
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  const range = hi - lo || 1;
  const volume = new Float32Array(budget.expectedVoxels);
  const planeVoxels = expectedWidth * expectedHeight;
  for (let z = 0; z < planes.length; z += 1) {
    const plane = planes[z];
    const invert = Number(plane.photometric) === 0;
    for (let index = 0; index < planeVoxels; index += 1) {
      const normalized = Math.max(0, Math.min(1, (plane.pixels[index] - lo) / range));
      volume[z * planeVoxels + index] = invert ? 1 - normalized : normalized;
    }
  }
  return volume;
}
