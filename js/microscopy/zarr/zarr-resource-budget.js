// OME-Zarr import materializes every selected C×Z×T plane as Float32 pixels and
// RGBA display data before the series can enter the viewer. Keep those eager
// allocations bounded before creating plane arrays or scheduling chunk reads.
export const DEFAULT_MAX_OME_ZARR_PLANE_PIXELS = 4_000_000;
export const MAX_OME_ZARR_ALLOCATED_PLANE_BYTES = 128 * 1024 * 1024;
export const MAX_OME_ZARR_CHUNKS_PER_PLANE = 4_096;
export const MAX_OME_ZARR_DECODED_CHUNK_BYTES = 32 * 1024 * 1024;
export const MAX_OME_ZARR_ENCODED_CHUNK_BYTES = 32 * 1024 * 1024;

const ALLOCATED_PLANE_BYTES_PER_PIXEL = Float32Array.BYTES_PER_ELEMENT + 4;

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function product(values) {
  let total = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0 || total > Number.MAX_SAFE_INTEGER / value) return 0;
    total *= value;
  }
  return total;
}

function resourceLimit(reason) {
  return `OME-Zarr resource limit: ${reason}`;
}

function bytesView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('OME-Zarr chunk stream returned non-byte data.');
}

export async function readBoundedOmeZarrByteStream(stream, {
  maxBytes = MAX_OME_ZARR_ENCODED_CHUNK_BYTES,
  createLimitError = message => new Error(message),
} = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error(resourceLimit('bounded encoded chunk streaming is unavailable.'));
  }
  const byteBudget = Math.min(
    positiveInteger(maxBytes, MAX_OME_ZARR_ENCODED_CHUNK_BYTES),
    MAX_OME_ZARR_ENCODED_CHUNK_BYTES,
  );
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = bytesView(value);
      if (bytes.byteLength > byteBudget - length) {
        void Promise.resolve(reader.cancel()).catch(() => {});
        throw createLimitError(`Encoded Zarr chunk exceeds the ${byteBudget} byte budget while streaming.`);
      }
      parts.push(bytes);
      length += bytes.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function unsupportedAxis(axes, shape) {
  if (!Array.isArray(axes) || !Array.isArray(shape) || axes.length !== shape.length) return '';
  for (let index = 0; index < axes.length; index += 1) {
    const name = String(axes[index]?.name || '').toLowerCase();
    if (!['x', 'y', 'c', 'z', 't'].includes(name) && shape[index] !== 1) {
      return `unsupported axis '${name || index}' has size ${shape[index]}; only singleton non-X/Y/C/Z/T axes can be ignored.`;
    }
  }
  return '';
}

export function omeZarrResourceBudget({
  width,
  height,
  sizeC = 1,
  sizeZ = 1,
  sizeT = 1,
  chunkWidth = width,
  chunkHeight = height,
  axes,
  shape,
  chunks,
  bytesPerElement,
  maxPlanePixels = DEFAULT_MAX_OME_ZARR_PLANE_PIXELS,
  maxAllocatedPlaneBytes = MAX_OME_ZARR_ALLOCATED_PLANE_BYTES,
  maxChunksPerPlane = MAX_OME_ZARR_CHUNKS_PER_PLANE,
  maxDecodedChunkBytes = MAX_OME_ZARR_DECODED_CHUNK_BYTES,
} = {}) {
  const dimensions = [width, height, sizeC, sizeZ, sizeT].map(positiveSafeInteger);
  const [safeWidth, safeHeight, safeC, safeZ, safeT] = dimensions;
  if (dimensions.some(value => value === 0)) {
    return { ok: false, reason: resourceLimit('array dimensions must be positive safe integers.') };
  }

  const unsupported = unsupportedAxis(axes, shape);
  if (unsupported) return { ok: false, reason: resourceLimit(unsupported) };

  const planePixels = product([safeWidth, safeHeight]);
  const planeCount = product([safeC, safeZ, safeT]);
  const totalPlanePixels = product([planePixels, planeCount]);
  if (!planePixels || !planeCount || !totalPlanePixels) {
    return { ok: false, reason: resourceLimit('array dimensions exceed safe integer precision.') };
  }

  const safeChunkWidth = positiveSafeInteger(chunkWidth);
  const safeChunkHeight = positiveSafeInteger(chunkHeight);
  if (!safeChunkWidth || !safeChunkHeight) {
    return { ok: false, reason: resourceLimit('x/y chunk dimensions must be positive safe integers.') };
  }

  const maxPixels = Math.min(positiveInteger(maxPlanePixels, DEFAULT_MAX_OME_ZARR_PLANE_PIXELS), DEFAULT_MAX_OME_ZARR_PLANE_PIXELS);
  const maxBytes = Math.min(positiveInteger(maxAllocatedPlaneBytes, MAX_OME_ZARR_ALLOCATED_PLANE_BYTES), MAX_OME_ZARR_ALLOCATED_PLANE_BYTES);
  const maxChunks = Math.min(positiveInteger(maxChunksPerPlane, MAX_OME_ZARR_CHUNKS_PER_PLANE), MAX_OME_ZARR_CHUNKS_PER_PLANE);
  const maxDecodedBytes = Math.min(positiveInteger(maxDecodedChunkBytes, MAX_OME_ZARR_DECODED_CHUNK_BYTES), MAX_OME_ZARR_DECODED_CHUNK_BYTES);
  const chunkCount = product([
    Math.ceil(safeWidth / safeChunkWidth),
    Math.ceil(safeHeight / safeChunkHeight),
  ]);
  const allocatedPlaneBytes = product([totalPlanePixels, ALLOCATED_PLANE_BYTES_PER_PIXEL]);

  if (planePixels > maxPixels) {
    return {
      ok: false,
      reason: resourceLimit(`${planePixels} pixels per plane exceeds the ${maxPixels} pixel budget.`),
    };
  }
  if (!allocatedPlaneBytes || allocatedPlaneBytes > maxBytes) {
    return {
      ok: false,
      reason: resourceLimit(`${totalPlanePixels} aggregate plane pixels require ${allocatedPlaneBytes || 'more than safe-integer'} bytes; the budget is ${maxBytes} bytes.`),
    };
  }
  if (!chunkCount || chunkCount > maxChunks) {
    return {
      ok: false,
      reason: resourceLimit(`${chunkCount || 'more than safe-integer'} chunks per plane exceeds the ${maxChunks} chunk budget.`),
    };
  }

  if (Array.isArray(shape) || Array.isArray(chunks) || bytesPerElement != null) {
    const safeShape = Array.isArray(shape) ? shape.map(positiveSafeInteger) : [];
    const safeChunks = Array.isArray(chunks) ? chunks.map(positiveSafeInteger) : [];
    const safeBytes = positiveSafeInteger(bytesPerElement);
    const fullChunkBytes = safeShape.length === safeChunks.length && safeBytes
      ? product([...safeChunks, safeBytes])
      : 0;
    if (!fullChunkBytes || fullChunkBytes > maxDecodedBytes) {
      return {
        ok: false,
        reason: resourceLimit(`${fullChunkBytes || 'more than safe-integer'} decoded bytes per chunk exceeds the ${maxDecodedBytes} byte budget.`),
      };
    }
  }

  return {
    ok: true,
    width: safeWidth,
    height: safeHeight,
    planePixels,
    planeCount,
    totalPlanePixels,
    allocatedPlaneBytes,
    chunkCount,
  };
}
