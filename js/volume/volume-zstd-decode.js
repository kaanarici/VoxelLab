import {
  createRawVolumePayloadError,
  isRawVolumePayloadError,
  rawVolumeExpectedByteLength,
} from './volume-raw-normalize.js';

function bytesView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('raw volume compressed payload must be bytes');
}

function readLittleEndian(bytes, offset, count, label) {
  if (offset < 0 || count <= 0 || offset + count > bytes.byteLength) {
    throw createRawVolumePayloadError(`zstd frame has a truncated ${label}`);
  }
  let value = 0;
  for (let index = count - 1; index >= 0; index -= 1) {
    value = (value * 256) + bytes[offset + index];
    if (!Number.isSafeInteger(value)) {
      throw createRawVolumePayloadError(`${label} exceeds safe integer precision`);
    }
  }
  return value;
}

const XXH64_PRIME_1 = { lo: 0x85ebca87, hi: 0x9e3779b1 };
const XXH64_PRIME_2 = { lo: 0x27d4eb4f, hi: 0xc2b2ae3d };
const XXH64_PRIME_3 = { lo: 0x9e3779f9, hi: 0x165667b1 };
const XXH64_PRIME_4 = { lo: 0xc2b2ae63, hi: 0x85ebca77 };
const XXH64_PRIME_5 = { lo: 0x165667c5, hi: 0x27d4eb2f };

function set64(target, lo, hi) {
  target[0] = lo >>> 0;
  target[1] = hi >>> 0;
}

function add64(target, lo, hi) {
  const previous = target[0];
  const next = (previous + (lo >>> 0)) >>> 0;
  target[0] = next;
  target[1] = (target[1] + (hi >>> 0) + (next < previous ? 1 : 0)) >>> 0;
}

function multiply64To(aLo, aHi, bLo, bHi, target) {
  const aLow = aLo & 0xffff;
  const aHigh = aLo >>> 16;
  const bLow = bLo & 0xffff;
  const bHigh = bLo >>> 16;
  const lowProduct = aLow * bLow;
  const middle = (lowProduct >>> 16) + (aHigh * bLow) + (aLow * bHigh);
  target[0] = ((middle << 16) | (lowProduct & 0xffff)) >>> 0;
  target[1] = (
    (aHigh * bHigh)
    + Math.floor(middle / 0x1_0000)
    + Math.imul(aHi, bLo)
    + Math.imul(aLo, bHi)
  ) >>> 0;
}

function multiply64(target, prime, scratch) {
  multiply64To(target[0], target[1], prime.lo, prime.hi, scratch);
  set64(target, scratch[0], scratch[1]);
}

function rotateLeft64(target, bits) {
  const lo = target[0];
  const hi = target[1];
  if (bits === 32) {
    set64(target, hi, lo);
  } else if (bits < 32) {
    set64(target, (lo << bits) | (hi >>> (32 - bits)), (hi << bits) | (lo >>> (32 - bits)));
  } else {
    const shift = bits - 32;
    set64(target, (hi << shift) | (lo >>> (32 - shift)), (lo << shift) | (hi >>> (32 - shift)));
  }
}

function shiftRight64To(source, bits, target) {
  if (bits < 32) {
    set64(target, (source[0] >>> bits) | (source[1] << (32 - bits)), source[1] >>> bits);
  } else {
    set64(target, source[1] >>> (bits - 32), 0);
  }
}

function xxh64Round(target, inputLo, inputHi, scratch) {
  multiply64To(inputLo, inputHi, XXH64_PRIME_2.lo, XXH64_PRIME_2.hi, scratch);
  add64(target, scratch[0], scratch[1]);
  rotateLeft64(target, 31);
  multiply64(target, XXH64_PRIME_1, scratch);
}

function xxh64MergeRound(hash, lane, work, scratch) {
  set64(work, 0, 0);
  xxh64Round(work, lane[0], lane[1], scratch);
  hash[0] ^= work[0];
  hash[1] ^= work[1];
  multiply64(hash, XXH64_PRIME_1, scratch);
  add64(hash, XXH64_PRIME_4.lo, XXH64_PRIME_4.hi);
}

export function xxh64Lower32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const hash = new Uint32Array(2);
  const scratch = new Uint32Array(2);
  const work = new Uint32Array(2);
  let offset = 0;
  if (length >= 32) {
    const v1 = new Uint32Array(2);
    const v2 = new Uint32Array([XXH64_PRIME_2.lo, XXH64_PRIME_2.hi]);
    const v3 = new Uint32Array(2);
    const v4 = new Uint32Array([
      (-XXH64_PRIME_1.lo) >>> 0,
      (~XXH64_PRIME_1.hi + (XXH64_PRIME_1.lo === 0 ? 1 : 0)) >>> 0,
    ]);
    set64(v1, XXH64_PRIME_1.lo, XXH64_PRIME_1.hi);
    add64(v1, XXH64_PRIME_2.lo, XXH64_PRIME_2.hi);
    const limit = length - 32;
    while (offset <= limit) {
      xxh64Round(v1, view.getUint32(offset, true), view.getUint32(offset + 4, true), scratch);
      xxh64Round(v2, view.getUint32(offset + 8, true), view.getUint32(offset + 12, true), scratch);
      xxh64Round(v3, view.getUint32(offset + 16, true), view.getUint32(offset + 20, true), scratch);
      xxh64Round(v4, view.getUint32(offset + 24, true), view.getUint32(offset + 28, true), scratch);
      offset += 32;
    }
    for (const [lane, bits] of [[v1, 1], [v2, 7], [v3, 12], [v4, 18]]) {
      set64(work, lane[0], lane[1]);
      rotateLeft64(work, bits);
      add64(hash, work[0], work[1]);
    }
    xxh64MergeRound(hash, v1, work, scratch);
    xxh64MergeRound(hash, v2, work, scratch);
    xxh64MergeRound(hash, v3, work, scratch);
    xxh64MergeRound(hash, v4, work, scratch);
  } else {
    set64(hash, XXH64_PRIME_5.lo, XXH64_PRIME_5.hi);
  }

  add64(hash, length >>> 0, Math.floor(length / 0x1_0000_0000));
  while (offset + 8 <= length) {
    set64(work, 0, 0);
    xxh64Round(work, view.getUint32(offset, true), view.getUint32(offset + 4, true), scratch);
    hash[0] ^= work[0];
    hash[1] ^= work[1];
    rotateLeft64(hash, 27);
    multiply64(hash, XXH64_PRIME_1, scratch);
    add64(hash, XXH64_PRIME_4.lo, XXH64_PRIME_4.hi);
    offset += 8;
  }
  if (offset + 4 <= length) {
    multiply64To(view.getUint32(offset, true), 0, XXH64_PRIME_1.lo, XXH64_PRIME_1.hi, work);
    hash[0] ^= work[0];
    hash[1] ^= work[1];
    rotateLeft64(hash, 23);
    multiply64(hash, XXH64_PRIME_2, scratch);
    add64(hash, XXH64_PRIME_3.lo, XXH64_PRIME_3.hi);
    offset += 4;
  }
  while (offset < length) {
    multiply64To(bytes[offset], 0, XXH64_PRIME_5.lo, XXH64_PRIME_5.hi, work);
    hash[0] ^= work[0];
    hash[1] ^= work[1];
    rotateLeft64(hash, 11);
    multiply64(hash, XXH64_PRIME_1, scratch);
    offset += 1;
  }
  shiftRight64To(hash, 33, work);
  hash[0] ^= work[0];
  hash[1] ^= work[1];
  multiply64(hash, XXH64_PRIME_2, scratch);
  shiftRight64To(hash, 29, work);
  hash[0] ^= work[0];
  hash[1] ^= work[1];
  multiply64(hash, XXH64_PRIME_3, scratch);
  shiftRight64To(hash, 32, work);
  hash[0] ^= work[0];
  hash[1] ^= work[1];
  return hash[0];
}

function assertSingleZstdFrame(bytes, expectedBytes) {
  if (bytes.byteLength < 9 || bytes[0] !== 0x28 || bytes[1] !== 0xb5
      || bytes[2] !== 0x2f || bytes[3] !== 0xfd) {
    throw createRawVolumePayloadError('zstd payload has an invalid frame header');
  }
  const descriptor = bytes[4];
  if (descriptor & 0x18) throw createRawVolumePayloadError('zstd frame uses a reserved descriptor bit');
  const singleSegment = (descriptor >> 5) & 1;
  const contentSizeFlag = descriptor >> 6;
  const dictionaryFlag = descriptor & 3;
  if (dictionaryFlag) throw createRawVolumePayloadError('zstd dictionaries are not supported');
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag ? (1 << contentSizeFlag) : singleSegment;
  if (!contentSizeBytes) {
    throw createRawVolumePayloadError('zstd frame must declare its decoded content size');
  }
  const contentSizeOffset = (6 - singleSegment) + dictionaryBytes;
  let declaredBytes = readLittleEndian(bytes, contentSizeOffset, contentSizeBytes, 'content size');
  if (contentSizeFlag === 1) declaredBytes += 256;
  if (declaredBytes !== expectedBytes) {
    throw createRawVolumePayloadError(`zstd content size mismatch: expected ${expectedBytes}, got ${declaredBytes}`);
  }

  if (!singleSegment) {
    const windowDescriptor = bytes[5];
    const windowBase = 2 ** (10 + (windowDescriptor >> 3));
    const windowBytes = windowBase + ((windowBase / 8) * (windowDescriptor & 7));
    if (!Number.isSafeInteger(windowBytes) || windowBytes > expectedBytes) {
      throw createRawVolumePayloadError(
        `zstd window ${windowBytes} bytes exceeds the ${expectedBytes} byte decoded budget`,
      );
    }
  }

  let offset = contentSizeOffset + contentSizeBytes;
  while (true) {
    const blockHeader = readLittleEndian(bytes, offset, 3, 'block header');
    offset += 3;
    const lastBlock = blockHeader & 1;
    const blockType = (blockHeader >> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) throw createRawVolumePayloadError('zstd frame uses a reserved block type');
    if (blockSize > 128 * 1024) {
      throw createRawVolumePayloadError('zstd frame block exceeds the 128 KiB format limit');
    }
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (offset + payloadBytes > bytes.byteLength) {
      throw createRawVolumePayloadError('zstd frame has a truncated block payload');
    }
    offset += payloadBytes;
    if (lastBlock) break;
  }
  let checksum = null;
  if (descriptor & 0x04) {
    checksum = readLittleEndian(bytes, offset, 4, 'content checksum');
    offset += 4;
  }
  if (offset !== bytes.byteLength) {
    throw createRawVolumePayloadError('zstd payload must contain exactly one frame');
  }
  return checksum;
}

export function decodeZstdRawVolume(value, expectedVoxels, Decompress) {
  if (typeof Decompress !== 'function') throw new TypeError('raw volume zstd decoder is unavailable');
  const bytes = bytesView(value);
  const expectedBytes = rawVolumeExpectedByteLength(expectedVoxels);
  const expectedChecksum = assertSingleZstdFrame(bytes, expectedBytes);

  const output = new Uint8Array(expectedBytes);
  let written = 0;
  const decoder = new Decompress((chunk) => {
    const part = bytesView(chunk);
    if (part.byteLength > expectedBytes - written) {
      throw createRawVolumePayloadError(`decoded data exceeds the ${expectedBytes} byte budget`);
    }
    output.set(part, written);
    written += part.byteLength;
  });
  try {
    decoder.push(bytes, true);
  } catch (error) {
    if (isRawVolumePayloadError(error)) throw error;
    throw createRawVolumePayloadError(error?.message || 'zstd decoding failed', error);
  }
  if (written !== expectedBytes) {
    throw createRawVolumePayloadError(`byte count mismatch: expected ${expectedBytes}, got ${written}`);
  }
  if (expectedChecksum != null) {
    const actualChecksum = xxh64Lower32(output);
    if (actualChecksum !== expectedChecksum) {
      throw createRawVolumePayloadError(
        `zstd content checksum mismatch: expected ${expectedChecksum.toString(16).padStart(8, '0')}, got ${actualChecksum.toString(16).padStart(8, '0')}`,
      );
    }
  }
  return output.buffer;
}
