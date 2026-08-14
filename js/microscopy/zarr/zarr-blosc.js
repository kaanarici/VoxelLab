import { zarrInflate, zarrZstdDecompress } from './zarr-codec-deps.js';
import { lz4BlockDecompress } from './zarr-lz4.js';
import { byteUnshuffle } from './zarr-shuffle.js';

const BLOSC_HEADER_BYTES = 16;
const BLOSC_FLAG_BYTE_SHUFFLE = 1;
const BLOSC_FLAG_MEMCPYED = 2;
const BLOSC_FLAG_BIT_SHUFFLE = 4;

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('Blosc input must be byte-addressable.');
}

function unsupported(reason) {
  const error = new Error(reason);
  error.unsupportedReason = reason;
  throw error;
}

// The Blosc header flags byte (bits 5-7) stores a 3-bit compressed-FORMAT code,
// not the c-blosc library compcode: 0=BLOSCLZ, 1=LZ4 (also LZ4HC, which emits the
// same LZ4 block format), 2=SNAPPY, 3=ZLIB, 4=ZSTD. BLOSCLZ and SNAPPY are not
// implemented and fail closed.
async function decompressCodecPayload(codecId, src, destLen) {
  let output = null;
  if (codecId === 1) output = lz4BlockDecompress(src, destLen);
  if (codecId === 3) output = asUint8Array(await zarrInflate(src));
  if (codecId === 4) output = asUint8Array(await zarrZstdDecompress(src));
  if (codecId === 0) unsupported("Blosc cname 'blosclz'");
  if (codecId === 2) unsupported("Blosc cname 'snappy'");
  if (!output) unsupported(`Blosc compressor format ${codecId}`);
  if (output.byteLength !== destLen) throw new Error('Invalid Blosc buffer: block decoded length mismatch.');
  return output;
}

function readPayloadLength(view, offset, payloadEnd) {
  if (offset + 4 > payloadEnd) throw new Error('Invalid Blosc buffer: block length is truncated.');
  const length = view.getInt32(offset, true);
  if (length < 0 || offset + 4 + length > payloadEnd) {
    throw new Error('Invalid Blosc buffer: block payload is truncated.');
  }
  return length;
}

async function decompressSplitPayload(codecId, view, blockStart, blockEnd, destLen, typesize) {
  if (destLen % typesize !== 0) throw new Error('Invalid Blosc buffer: split block size is not type-aligned.');
  const laneLength = destLen / typesize;
  const output = new Uint8Array(destLen);
  let offset = blockStart;
  let lane = 0;

  while (offset < blockEnd && lane < typesize) {
    const length = readPayloadLength(view, offset, blockEnd);
    const payloadStart = offset + 4;
    const payload = new Uint8Array(view.buffer, view.byteOffset + payloadStart, length);
    output.set(await decompressCodecPayload(codecId, payload, laneLength), lane * laneLength);
    offset = payloadStart + length;
    lane += 1;
  }

  if (offset !== blockEnd || lane !== typesize) throw new Error('Invalid Blosc buffer: split payload count mismatch.');
  return output;
}

async function decompressBlockPayload(codecId, view, blockStart, blockEnd, destLen, { byteShuffle, typesize }) {
  const length = readPayloadLength(view, blockStart, blockEnd);
  const payloadStart = blockStart + 4;
  const payloadEnd = payloadStart + length;
  let splitError = null;

  if (byteShuffle && typesize > 1 && payloadEnd < blockEnd) {
    try {
      return await decompressSplitPayload(codecId, view, blockStart, blockEnd, destLen, typesize);
    } catch (error) {
      splitError = error;
    }
  }

  const payload = new Uint8Array(view.buffer, view.byteOffset + payloadStart, length);
  try {
    return await decompressCodecPayload(codecId, payload, destLen);
  } catch (error) {
    if (splitError) throw splitError;
    throw error;
  }
}

function unshuffleBlocks(buf, { blocksize, nbytes, typesize }) {
  const dest = new Uint8Array(nbytes);
  let offset = 0;
  while (offset < nbytes) {
    const blockBytes = Math.min(blocksize, nbytes - offset);
    dest.set(byteUnshuffle(buf.subarray(offset, offset + blockBytes), typesize), offset);
    offset += blockBytes;
  }
  return dest;
}

export async function bloscDecompress(srcBytes) {
  const src = asUint8Array(srcBytes);
  if (src.byteLength < BLOSC_HEADER_BYTES) throw new Error('Invalid Blosc buffer: header is truncated.');

  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const flags = view.getUint8(2);
  const typesize = view.getUint8(3);
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  const cbytes = view.getUint32(12, true);
  if (cbytes > src.byteLength) throw new Error('Invalid Blosc buffer: cbytes exceeds input length.');
  if (typesize <= 0) throw new Error('Invalid Blosc buffer: typesize must be positive.');
  if (nbytes === 0) return new Uint8Array(0);
  if (blocksize <= 0) throw new Error('Invalid Blosc buffer: blocksize must be positive.');
  if (flags & BLOSC_FLAG_BIT_SHUFFLE) unsupported('Blosc shuffle=2');

  if (flags & BLOSC_FLAG_MEMCPYED) {
    const rawStart = BLOSC_HEADER_BYTES;
    const rawEnd = rawStart + nbytes;
    if (rawEnd > cbytes) throw new Error('Invalid Blosc buffer: memcpy payload is truncated.');
    return new Uint8Array(src.subarray(rawStart, rawEnd));
  }

  const codecId = flags >> 5;
  const nblocks = Math.ceil(nbytes / blocksize);
  const tableEnd = BLOSC_HEADER_BYTES + (nblocks * 4);
  if (tableEnd > cbytes) throw new Error('Invalid Blosc buffer: block table is truncated.');

  const blockStarts = [];
  for (let blockIndex = 0; blockIndex < nblocks; blockIndex += 1) {
    const blockStart = view.getInt32(BLOSC_HEADER_BYTES + (blockIndex * 4), true);
    if (blockStart < tableEnd || blockStart + 4 > cbytes) {
      throw new Error('Invalid Blosc buffer: block start is outside the container.');
    }
    blockStarts.push(blockStart);
  }

  const decoded = new Uint8Array(nbytes);
  for (let blockIndex = 0; blockIndex < nblocks; blockIndex += 1) {
    const blockStart = blockStarts[blockIndex];
    const blockEnd = blockIndex + 1 < nblocks ? blockStarts[blockIndex + 1] : cbytes;
    if (blockEnd < blockStart + 4) throw new Error('Invalid Blosc buffer: block payload is truncated.');
    const destOffset = blockIndex * blocksize;
    const destLen = Math.min(blocksize, nbytes - destOffset);
    const block = await decompressBlockPayload(codecId, view, blockStart, blockEnd, destLen, {
      byteShuffle: Boolean(flags & BLOSC_FLAG_BYTE_SHUFFLE),
      typesize,
    });
    decoded.set(block, destOffset);
  }

  if (flags & BLOSC_FLAG_BYTE_SHUFFLE) return unshuffleBlocks(decoded, { blocksize, nbytes, typesize });
  return decoded;
}
