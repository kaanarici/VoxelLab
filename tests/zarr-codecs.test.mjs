import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { decodeZarrChunk, describeZarrCodec, ZarrUnsupportedCodecError } from '../js/microscopy/zarr/zarr-codecs.js';
import { lz4BlockDecompress } from '../js/microscopy/zarr/zarr-lz4.js';
import { byteUnshuffle } from '../js/microscopy/zarr/zarr-shuffle.js';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function byteShuffle(bytes, typesize) {
  const count = bytes.byteLength / typesize;
  const dest = new Uint8Array(bytes.byteLength);
  for (let byte = 0; byte < typesize; byte += 1) {
    for (let i = 0; i < count; i += 1) {
      dest[(byte * count) + i] = bytes[(i * typesize) + byte];
    }
  }
  return dest;
}

function uint16Stats(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  const values = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const value = view.getUint16(offset, true);
    if (values.length < 8) values.push(value);
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { first8: values, min, max, sum };
}

test('lz4BlockDecompress decodes a literal-only block', () => {
  const encoded = Uint8Array.from([0x50, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.deepEqual(Array.from(lz4BlockDecompress(encoded, 5)), [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
});

test('lz4BlockDecompress decodes a literal plus match sequence', () => {
  const encoded = Uint8Array.from([0x32, 0x61, 0x62, 0x63, 0x03, 0x00]);
  assert.deepEqual(Array.from(lz4BlockDecompress(encoded, 9)), [
    0x61, 0x62, 0x63,
    0x61, 0x62, 0x63,
    0x61, 0x62, 0x63,
  ]);
});

test('byteUnshuffle reverses byte-shuffled typed values', () => {
  const raw = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  assert.deepEqual(Array.from(byteUnshuffle(byteShuffle(raw, 2), 2)), Array.from(raw));
});

test('decodeZarrChunk decodes the IDR Blosc LZ4 byte-shuffled uint16 golden', async () => {
  const chunk = await readFile(new URL('./fixtures/zarr/idr0062A-6001240-L0-c0z0.blosc', import.meta.url));
  const golden = JSON.parse(await readFile(new URL('./fixtures/zarr/idr0062A-6001240-L0-c0z0.golden.json', import.meta.url), 'utf8'));
  const output = await decodeZarrChunk(chunk, {
    compressor: { id: 'blosc', cname: 'lz4', shuffle: 1, clevel: 5, blocksize: 0 },
    filters: null,
    dtype: { bytes: 2 },
    expectedBytes: 149_050,
  });
  const stats = uint16Stats(output);

  assert.equal(output.byteLength, 149_050);
  assert.equal(sha256(output), golden.sha256_decoded);
  assert.deepEqual(stats.first8, golden.first8);
  assert.equal(stats.min, golden.min);
  assert.equal(stats.max, golden.max);
  assert.equal(stats.sum, golden.sum);
});

test('decodeZarrChunk decodes Blosc lz4hc/zlib/zstd and raw zstd/gzip against numcodecs vectors', async () => {
  const vectors = JSON.parse(await readFile(new URL('./fixtures/zarr/codec-vectors.json', import.meta.url), 'utf8'));
  const orig = vectors._orig;
  const cases = [
    ['blosc-zlib-noshuffle', { id: 'blosc', cname: 'zlib', shuffle: 0 }],
    ['blosc-zstd-noshuffle', { id: 'blosc', cname: 'zstd', shuffle: 0 }],
    ['blosc-lz4hc-shuffle', { id: 'blosc', cname: 'lz4hc', shuffle: 1 }],
    ['raw-zstd', { id: 'zstd' }],
    ['raw-gzip', { id: 'gzip' }],
  ];
  for (const [name, compressor] of cases) {
    const encoded = await readFile(new URL(`./fixtures/zarr/${vectors[name].encoded}`, import.meta.url));
    const output = await decodeZarrChunk(encoded, {
      compressor,
      filters: null,
      dtype: { bytes: 2 },
      expectedBytes: orig.bytes,
    });
    assert.equal(output.byteLength, orig.bytes, name);
    assert.equal(sha256(output), orig.sha256, name);
    assert.deepEqual(uint16Stats(output).first8, orig.first8, name);
  }
});

test('decodeZarrChunk fails closed with named unsupported reasons', async () => {
  await assert.rejects(
    decodeZarrChunk(Uint8Array.of(), {
      compressor: null,
      filters: [{ id: 'delta' }],
      dtype: { bytes: 2 },
      expectedBytes: 0,
    }),
    (error) => error instanceof ZarrUnsupportedCodecError && error.reason === 'filters',
  );
  await assert.rejects(
    decodeZarrChunk(Uint8Array.of(), {
      compressor: { id: 'blosc', cname: 'snappy', shuffle: 1 },
      filters: null,
      dtype: { bytes: 2 },
      expectedBytes: 0,
    }),
    (error) => error instanceof ZarrUnsupportedCodecError && error.reason === "Blosc cname 'snappy'",
  );
  await assert.rejects(
    decodeZarrChunk(Uint8Array.of(), {
      compressor: { id: 'blosc', cname: 'lz4', shuffle: 2 },
      filters: null,
      dtype: { bytes: 2 },
      expectedBytes: 0,
    }),
    (error) => error instanceof ZarrUnsupportedCodecError && error.reason === 'Blosc shuffle=2',
  );
});

test('describeZarrCodec reports stable human labels', () => {
  assert.equal(describeZarrCodec(null, null), 'raw');
  assert.equal(describeZarrCodec({ id: 'blosc', cname: 'lz4', shuffle: 1 }, null), 'blosc(lz4, byte-shuffle)');
  assert.equal(describeZarrCodec({ id: 'gzip' }, [{ id: 'delta' }]), 'gzip + filters');
});
