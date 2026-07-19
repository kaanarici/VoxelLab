import { zarrInflate, zarrZstdDecompress } from './zarr-codec-deps.js';
import { bloscDecompress } from './zarr-blosc.js';
import { byteUnshuffle } from './zarr-shuffle.js';

export class ZarrUnsupportedCodecError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ZarrUnsupportedCodecError';
    this.reason = reason;
  }
}

function unsupported(reason) {
  return new ZarrUnsupportedCodecError(reason);
}

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('Zarr chunk input must be byte-addressable.');
}

function compressorId(compressor) {
  if (compressor == null) return 'raw';
  return String(compressor.id || '').trim().toLowerCase();
}

function normalizedFilters(filters, dtype) {
  if (filters == null) return [];
  if (!Array.isArray(filters)) throw unsupported('filters');
  return filters.map((filter) => {
    const id = String(filter?.id || filter?.name || '').trim().toLowerCase();
    if (id !== 'shuffle') throw unsupported(id === 'bitshuffle' ? 'filters: bitshuffle filter' : 'filters');
    const elementsize = Number(filter.elementsize ?? filter.configuration?.elementsize ?? dtype.bytes);
    if (!Number.isSafeInteger(elementsize) || elementsize !== dtype.bytes) throw unsupported('shuffle elementsize');
    return { id, elementsize };
  });
}

function validateExpectedBytes(expectedBytes) {
  const value = Number(expectedBytes);
  if (!Number.isInteger(value) || value < 0) throw unsupported('expectedBytes');
  return value;
}

function validateDtype(dtype) {
  const bytes = Number(dtype?.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) throw unsupported('dtype.bytes');
  return bytes;
}

function validateDecodedLength(output, expectedBytes) {
  if (output.byteLength !== expectedBytes) throw unsupported('expectedBytes decoded length mismatch');
  return output;
}

function validateBloscRequest(compressor) {
  const cname = String(compressor?.cname || '').trim().toLowerCase();
  if (cname === 'snappy' || cname === 'blosclz') throw unsupported(`Blosc cname '${cname}'`);
  const supported = new Set(['lz4', 'lz4hc', 'zlib', 'zstd', 'gzip']);
  if (cname && !supported.has(cname)) throw unsupported(`Blosc cname '${cname}'`);

  if (compressor?.shuffle != null) {
    const shuffle = Number(compressor.shuffle);
    if (shuffle === 2) throw unsupported('Blosc shuffle=2');
    if (shuffle !== 0 && shuffle !== 1) throw unsupported(`Blosc shuffle=${compressor.shuffle}`);
  }
}

async function inflateWithPako(src) {
  return asUint8Array(await zarrInflate(src));
}

async function decompressWithFzstd(src) {
  return asUint8Array(await zarrZstdDecompress(src));
}

function wrapCodecError(error) {
  if (error instanceof ZarrUnsupportedCodecError) throw error;
  if (error?.unsupportedReason) throw unsupported(error.unsupportedReason);
  throw error;
}

export async function decodeZarrChunk(bytes, { compressor = null, filters = null, dtype, expectedBytes } = {}) {
  const dtypeBytes = validateDtype(dtype);
  const normalized = normalizedFilters(filters, { ...dtype, bytes: dtypeBytes });
  const length = validateExpectedBytes(expectedBytes);
  const src = asUint8Array(bytes);
  const id = compressorId(compressor);

  try {
    let output;
    if (id === 'raw') output = new Uint8Array(src);
    if (id === 'blosc') {
      validateBloscRequest(compressor);
      output = await bloscDecompress(src);
    }
    if (id === 'zlib' || id === 'gzip') output = await inflateWithPako(src);
    if (id === 'zstd') output = await decompressWithFzstd(src);
    if (!output) throw unsupported(`compressor.id '${id || 'unknown'}'`);
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      output = byteUnshuffle(output, normalized[index].elementsize);
    }
    return validateDecodedLength(output, length);
  } catch (error) {
    wrapCodecError(error);
  }
}

export function describeZarrCodec(compressor, filters) {
  const filterSuffix = Array.isArray(filters) && filters.length
    ? filters.every(filter => String(filter?.id || filter?.name || '').toLowerCase() === 'shuffle') ? ' + shuffle' : ' + filters'
    : filters != null ? ' + filters' : '';
  const id = compressorId(compressor);
  if (id === 'raw') return `raw${filterSuffix}`;
  if (id === 'blosc') {
    const cname = String(compressor?.cname || 'unknown').trim().toLowerCase() || 'unknown';
    const shuffle = Number(compressor?.shuffle) === 1 ? ', byte-shuffle' : Number(compressor?.shuffle) === 2 ? ', bitshuffle' : '';
    return `blosc(${cname}${shuffle})${filterSuffix}`;
  }
  return `${id || 'unknown'}${filterSuffix}`;
}
