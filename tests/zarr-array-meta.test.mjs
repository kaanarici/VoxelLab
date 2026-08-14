import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseZarrArrayMeta, zarrScalarArrayType } from '../js/microscopy/zarr/zarr-array-meta.js';

function v2(dtype, fillValue) {
  return {
    zarr_format: 2,
    shape: [1],
    chunks: [1],
    dtype,
    compressor: null,
    filters: null,
    order: 'C',
    ...(fillValue !== undefined ? { fill_value: fillValue } : {}),
  };
}

function v3(dataType, fillValue) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [1],
    data_type: dataType,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    ...(fillValue !== undefined ? { fill_value: fillValue } : {}),
  };
}

test('Zarr arrays distinguish concrete zero fill from null or omitted fill', () => {
  assert.deepEqual(
    [parseZarrArrayMeta(v2('|u1', 0)).hasFillValue, parseZarrArrayMeta(v2('|u1', 0)).fillValue],
    [true, 0],
  );
  assert.deepEqual(
    [parseZarrArrayMeta(v2('|u1', null)).hasFillValue, parseZarrArrayMeta(v2('|u1', null)).fillValue],
    [false, null],
  );
  assert.equal(parseZarrArrayMeta(v2('|u1')).hasFillValue, false);
  assert.equal(parseZarrArrayMeta(v3('uint8', null)).hasFillValue, false);
});

test('Zarr integer fill values must fit the declared scalar range', () => {
  assert.throws(() => parseZarrArrayMeta(v2('|u1', '0')), /numeric scalar/);
  assert.throws(() => parseZarrArrayMeta(v2('|u1', -1)), /outside uint8 range/);
  assert.throws(() => parseZarrArrayMeta(v2('|u1', 256)), /outside uint8 range/);
  assert.throws(() => parseZarrArrayMeta(v2('|i1', -129)), /outside int8 range/);
  assert.throws(() => parseZarrArrayMeta(v3('uint32', 4_294_967_296)), /outside uint32 range/);
  assert.equal(parseZarrArrayMeta(v3('uint32', 4_294_967_295)).fillValue, 4_294_967_295);
});

test('Zarr float32 fill values must be finite', () => {
  assert.throws(() => parseZarrArrayMeta(v2('<f4', Number.NaN)), /must be finite/);
  assert.throws(() => parseZarrArrayMeta(v3('float32', Number.POSITIVE_INFINITY)), /must be finite/);
  assert.throws(() => parseZarrArrayMeta(v3('float32', 1e100)), /must be finite/);
  assert.equal(parseZarrArrayMeta(v3('float32', 0.1)).fillValue, Math.fround(0.1));
});

test('Zarr scalar arrays preserve each accepted scalar dtype', () => {
  assert.equal(zarrScalarArrayType(parseZarrArrayMeta(v2('|u1')).dtype), Uint8Array);
  assert.equal(zarrScalarArrayType(parseZarrArrayMeta(v2('<i2')).dtype), Int16Array);
  assert.equal(zarrScalarArrayType(parseZarrArrayMeta(v2('<i4')).dtype), Int32Array);
  assert.equal(zarrScalarArrayType(parseZarrArrayMeta(v2('>u4')).dtype), Uint32Array);
  assert.equal(zarrScalarArrayType(parseZarrArrayMeta(v2('<f4')).dtype), Float32Array);
});
