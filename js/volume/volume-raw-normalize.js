export const RAW_VOLUME_LIMITS = Object.freeze({
  maxVoxels: 96 * 1024 * 1024,
  maxEncodedBytes: 256 * 1024 * 1024,
  maxWorkingSetBytes: 1024 * 1024 * 1024,
});

function rawVolumeError(detail) {
  return new Error(`raw volume resource limit: ${detail}`);
}

export function createRawVolumePayloadError(detail, cause = null) {
  const error = new Error(`raw volume payload invalid: ${detail}`, cause ? { cause } : undefined);
  error.rawVolumePayloadInvalid = true;
  return error;
}

export function isRawVolumePayloadError(error) {
  return Boolean(error?.rawVolumePayloadInvalid);
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw rawVolumeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function safeMultiply(left, right, label) {
  if (left > Number.MAX_SAFE_INTEGER / right) {
    throw rawVolumeError(`${label} exceeds safe integer precision`);
  }
  return left * right;
}

export function rawVolumeExpectedByteLength(expectedVoxels) {
  const expected = positiveSafeInteger(expectedVoxels, 'voxel count');
  if (expected > RAW_VOLUME_LIMITS.maxVoxels) {
    throw rawVolumeError(`voxel count ${expected} exceeds the ${RAW_VOLUME_LIMITS.maxVoxels} voxel limit`);
  }
  return safeMultiply(expected, Uint16Array.BYTES_PER_ELEMENT, 'decoded byte count');
}

export function rawVolumeResourceBudget(width, height, slices) {
  const dimensions = [width, height, slices].map((value, index) => (
    positiveSafeInteger(value, ['width', 'height', 'slice count'][index])
  ));
  const planeVoxels = safeMultiply(dimensions[0], dimensions[1], 'plane voxel count');
  const expectedVoxels = safeMultiply(planeVoxels, dimensions[2], 'volume voxel count');
  const decodedBytes = rawVolumeExpectedByteLength(expectedVoxels);
  const compressionOverhead = Math.ceil(decodedBytes / 100) + (64 * 1024);
  // Peak compressed-worker construction retains a decoder window, exact
  // decoded output, Float32 normalization, and render handoff (4× decoded),
  // plus streamed parts, their joined buffer, and one cache/fallback copy.
  const fixedWorkingSetBytes = safeMultiply(decodedBytes, 4, 'decoded working-set byte count');
  const encodedWorkingSetBytes = Math.floor(
    (RAW_VOLUME_LIMITS.maxWorkingSetBytes - fixedWorkingSetBytes) / 3,
  );
  if (encodedWorkingSetBytes <= 0) {
    throw rawVolumeError(`decoded working set exceeds the ${RAW_VOLUME_LIMITS.maxWorkingSetBytes} byte limit`);
  }
  const maxEncodedBytes = Math.min(
    RAW_VOLUME_LIMITS.maxEncodedBytes,
    decodedBytes + compressionOverhead,
    encodedWorkingSetBytes,
  );
  return { expectedVoxels, decodedBytes, maxEncodedBytes };
}

export function normalizeUint16RawVolume(buffer, expectedVoxels) {
  const expectedBytes = rawVolumeExpectedByteLength(expectedVoxels);
  const expected = expectedBytes / Uint16Array.BYTES_PER_ELEMENT;
  if (!buffer || Number(buffer.byteLength) !== expectedBytes) {
    throw createRawVolumePayloadError(`byte count mismatch: expected ${expectedBytes}, got ${Number(buffer?.byteLength || 0)}`);
  }

  const u16 = new Uint16Array(buffer);
  if (u16.length !== expected) {
    throw createRawVolumePayloadError(`voxel count mismatch: expected ${expected}, got ${u16.length}`);
  }

  const f32 = new Float32Array(expected);
  const inv = 1 / 65535;
  for (let i = 0; i < expected; i += 1) f32[i] = u16[i] * inv;
  return f32;
}
