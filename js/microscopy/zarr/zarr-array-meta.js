import { ZarrUnsupportedCodecError } from './zarr-codecs.js';

function unsupported(reason) {
  throw new ZarrUnsupportedCodecError(reason);
}

function positiveIntegers(value, label) {
  if (!Array.isArray(value) || !value.length) unsupported(`${label} must be a non-empty integer array`);
  const result = value.map(Number);
  if (result.some(number => !Number.isSafeInteger(number) || number <= 0)) unsupported(`${label} must contain positive safe integers`);
  return result;
}

export function zarrDtypeInfo(rawDtype, { endian = '' } = {}) {
  const token = String(rawDtype || '').trim().toLowerCase();
  const v2 = token.match(/^([<>|])([ui f])([124])$/i);
  const v3 = token.match(/^(u?int|float)(8|16|32)$/);
  let kind = '';
  let bits = 0;
  let byteOrder = endian;
  if (v2) {
    kind = v2[2].replace(/\s/g, '');
    bits = Number(v2[3]) * 8;
    byteOrder = v2[1];
  } else if (v3) {
    kind = v3[1] === 'float' ? 'f' : v3[1] === 'int' ? 'i' : 'u';
    bits = Number(v3[2]);
  } else {
    return null;
  }
  if (!['u', 'i', 'f'].includes(kind) || ![8, 16, 32].includes(bits)) return null;
  if (kind === 'f' && bits !== 32) return null;
  if (bits > 8 && !['<', '>', 'little', 'big'].includes(byteOrder)) return null;
  return {
    bytes: bits / 8,
    bits,
    kind,
    littleEndian: byteOrder !== '>' && byteOrder !== 'big',
    sampleFormat: kind === 'f' ? 3 : kind === 'i' ? 2 : 1,
  };
}

function finiteFillValue(value, dtype) {
  if (value == null) return { hasFillValue: false, fillValue: null };
  if (typeof value !== 'number') unsupported('fill_value must be a numeric scalar');
  const number = dtype.kind === 'f' ? Math.fround(value) : value;
  if (!Number.isFinite(number)) unsupported('fill_value must be finite for supported scalar arrays');
  if (dtype.kind !== 'f') {
    if (!Number.isSafeInteger(number)) unsupported('integer fill_value must be an integer');
    const unsigned = dtype.kind === 'u';
    const minimum = unsigned ? 0 : -(2 ** (dtype.bits - 1));
    const maximum = unsigned ? (2 ** dtype.bits) - 1 : (2 ** (dtype.bits - 1)) - 1;
    if (number < minimum || number > maximum) {
      unsupported(`fill_value ${number} is outside ${unsigned ? 'uint' : 'int'}${dtype.bits} range`);
    }
  }
  return { hasFillValue: true, fillValue: number };
}

function v3CodecConfiguration(arrayMeta) {
  const codecs = Array.isArray(arrayMeta.codecs) ? arrayMeta.codecs : null;
  if (!codecs?.length) unsupported('Zarr v3 array requires codecs');
  const bytes = codecs.filter(codec => String(codec?.name || '').toLowerCase() === 'bytes');
  if (bytes.length !== 1 || codecs[0] !== bytes[0]) unsupported('Zarr v3 requires a leading bytes codec');
  const byteOrder = String(bytes[0]?.configuration?.endian || '').toLowerCase();
  const decodedDtype = zarrDtypeInfo(arrayMeta.data_type, { endian: byteOrder });
  if (!decodedDtype) unsupported(`Zarr v3 dtype '${arrayMeta.data_type || 'unknown'}' is unsupported`);
  if (decodedDtype.bytes > 1 && byteOrder !== 'little' && byteOrder !== 'big') unsupported('Zarr v3 multi-byte arrays require bytes codec endian little or big');
  const transformCodecs = codecs.slice(1);
  if (transformCodecs.length > 1) unsupported('Zarr v3 supports one bytes-to-bytes compression codec');
  const codec = transformCodecs[0];
  const name = String(codec?.name || '').toLowerCase();
  let compressor = null;
  if (name) {
    if (!['gzip', 'zstd', 'blosc'].includes(name)) unsupported(`Zarr v3 codec '${name}'`);
    compressor = { id: name, ...(codec.configuration || {}) };
  }
  return { dtype: decodedDtype, compressor, filters: null };
}

export function parseZarrArrayMeta(arrayMeta = {}, { context = 'OME-Zarr image loading' } = {}) {
  const version = Number(arrayMeta?.zarr_format);
  if (version === 2) {
    if (String(arrayMeta.order || '').toUpperCase() !== 'C') unsupported(`${context} supports explicit C-order chunks only`);
    const shape = positiveIntegers(arrayMeta.shape, 'shape');
    const chunks = positiveIntegers(arrayMeta.chunks, 'chunks');
    if (shape.length !== chunks.length) unsupported('shape/chunks rank mismatch');
    const dtype = zarrDtypeInfo(arrayMeta.dtype);
    if (!dtype) unsupported(`dtype '${arrayMeta.dtype || 'unknown'}' (supported: int8/uint8/int16/uint16/int32/uint32/float32)`);
    const fill = finiteFillValue(arrayMeta.fill_value, dtype);
    return {
      version,
      shape,
      chunks,
      dtype,
      compressor: arrayMeta.compressor ?? null,
      filters: arrayMeta.filters ?? null,
      ...fill,
      chunkKey(coords) { return coords.join(arrayMeta.dimension_separator === '/' ? '/' : '.'); },
    };
  }
  if (version !== 3) unsupported(`${context} supports Zarr v2 or bounded Zarr v3 arrays`);
  if (String(arrayMeta.node_type || '').toLowerCase() !== 'array') unsupported('Zarr v3 node_type must be array');
  if (String(arrayMeta.chunk_grid?.name || '').toLowerCase() !== 'regular') unsupported('Zarr v3 requires a regular chunk grid');
  const shape = positiveIntegers(arrayMeta.shape, 'shape');
  const chunks = positiveIntegers(arrayMeta.chunk_grid?.configuration?.chunk_shape, 'chunk_grid.configuration.chunk_shape');
  if (shape.length !== chunks.length) unsupported('shape/chunk_shape rank mismatch');
  const encoding = arrayMeta.chunk_key_encoding || {};
  if (String(encoding.name || '').toLowerCase() !== 'default') unsupported('Zarr v3 requires default chunk_key_encoding');
  const separator = String(encoding.configuration?.separator || '/');
  if (separator !== '/' && separator !== '.') unsupported('Zarr v3 chunk key separator must be / or .');
  const codec = v3CodecConfiguration(arrayMeta);
  const fill = finiteFillValue(arrayMeta.fill_value, codec.dtype);
  return {
    version,
    shape,
    chunks,
    dtype: codec.dtype,
    compressor: codec.compressor,
    filters: codec.filters,
    ...fill,
    chunkKey(coords) { return separator === '/' ? `c/${coords.join('/')}` : `c.${coords.join('.')}`; },
  };
}

export function zarrChunkPath(arrayPath, parsed, coords) {
  return `${String(arrayPath || '').replace(/\/+$/, '')}/${parsed.chunkKey(coords)}`.replace(/^\/+/, '');
}

export function zarrArrayMetaForDataset(arrayMeta, parsed) {
  if (!arrayMeta || typeof arrayMeta !== 'object' || parsed?.version !== 3) return arrayMeta;
  return { ...arrayMeta, chunks: [...parsed.chunks] };
}

export function zarrScalarArrayType(dtype) {
  if (dtype.kind === 'f') return Float32Array;
  if (dtype.bits === 8) return dtype.kind === 'i' ? Int8Array : Uint8Array;
  if (dtype.bits === 16) return dtype.kind === 'i' ? Int16Array : Uint16Array;
  return dtype.kind === 'i' ? Int32Array : Uint32Array;
}

export function zarrPixelAt(view, index, dtype, fillValue = null) {
  if (!view) return fillValue;
  const offset = index * dtype.bytes;
  if (dtype.kind === 'f') return view.getFloat32(offset, dtype.littleEndian);
  if (dtype.bits === 8) return dtype.kind === 'i' ? view.getInt8(offset) : view.getUint8(offset);
  if (dtype.bits === 16) return dtype.kind === 'i' ? view.getInt16(offset, dtype.littleEndian) : view.getUint16(offset, dtype.littleEndian);
  return dtype.kind === 'i' ? view.getInt32(offset, dtype.littleEndian) : view.getUint32(offset, dtype.littleEndian);
}
