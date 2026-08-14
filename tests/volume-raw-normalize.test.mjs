import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decompress } from 'fzstd';

const {
  RAW_VOLUME_LIMITS,
  normalizeUint16RawVolume,
  rawVolumeResourceBudget,
} = await import('../js/volume/volume-raw-normalize.js');
const {
  decodeZstdRawVolume,
  xxh64Lower32,
} = await import('../js/volume/volume-zstd-decode.js');

function singleSegmentRawZstd(payload, declaredBytes = payload.byteLength, checksum = null) {
  if (declaredBytes > 255 || payload.byteLength > 255) throw new Error('test frame is too large');
  const blockHeader = (payload.byteLength << 3) | 1;
  const checksumBytes = checksum == null ? [] : [
    checksum & 0xff,
    (checksum >>> 8) & 0xff,
    (checksum >>> 16) & 0xff,
    (checksum >>> 24) & 0xff,
  ];
  return Uint8Array.from([
    0x28, 0xb5, 0x2f, 0xfd,
    0x20 | (checksum == null ? 0 : 0x04),
    declaredBytes,
    blockHeader & 0xff,
    (blockHeader >> 8) & 0xff,
    (blockHeader >> 16) & 0xff,
    ...payload,
    ...checksumBytes,
  ]);
}

test('normalizeUint16RawVolume converts exact-size uint16 payloads to normalized floats', () => {
  const voxels = new Uint16Array([0, 32768, 65535]);
  const normalized = normalizeUint16RawVolume(voxels.buffer, 3);

  assert.equal(normalized.length, 3);
  assert.equal(normalized[0], 0);
  assert.ok(Math.abs(normalized[1] - (32768 / 65535)) < 1e-6);
  assert.equal(normalized[2], 1);
});

test('normalizeUint16RawVolume rejects short or oversized raw payloads', () => {
  assert.throws(() => normalizeUint16RawVolume(new Uint16Array([1, 2]).buffer, 3), /byte count mismatch/);
  assert.throws(() => normalizeUint16RawVolume(new Uint16Array([1, 2, 3, 4]).buffer, 3), /byte count mismatch/);
});

test('rawVolumeResourceBudget rejects unsafe shapes before byte allocation', () => {
  assert.deepEqual(rawVolumeResourceBudget(2, 3, 4), {
    expectedVoxels: 24,
    decodedBytes: 48,
    maxEncodedBytes: 65_585,
  });
  assert.throws(
    () => rawVolumeResourceBudget(RAW_VOLUME_LIMITS.maxVoxels + 1, 1, 1),
    /exceeds the .* voxel limit/,
  );
  assert.throws(() => rawVolumeResourceBudget(2.5, 1, 1), /width must be a positive safe integer/);

  const existingLargeStudy = rawVolumeResourceBudget(512, 792, 192);
  assert.equal(existingLargeStudy.expectedVoxels, 77_856_768);
  assert.ok(existingLargeStudy.maxEncodedBytes > 68_354_972);
});

test('decodeZstdRawVolume enforces one declared, exact-size bounded frame', () => {
  const raw = Uint8Array.from([0, 0, 255, 255]);
  const decoded = decodeZstdRawVolume(singleSegmentRawZstd(raw), 2, Decompress);
  assert.deepEqual([...new Uint8Array(decoded)], [...raw]);

  assert.throws(
    () => decodeZstdRawVolume(singleSegmentRawZstd(raw.subarray(0, 2), 4), 2, Decompress),
    /byte count mismatch: expected 4, got 2/,
  );
  const twoFrames = new Uint8Array([
    ...singleSegmentRawZstd(raw),
    ...singleSegmentRawZstd(raw),
  ]);
  assert.throws(
    () => decodeZstdRawVolume(twoFrames, 2, Decompress),
    /must contain exactly one frame/,
  );

  const checksum = 0xd173_aedb;
  assert.deepEqual(
    [...new Uint8Array(decodeZstdRawVolume(singleSegmentRawZstd(raw, 4, checksum), 2, Decompress))],
    [...raw],
  );
  assert.throws(
    () => decodeZstdRawVolume(singleSegmentRawZstd(raw, 4, 0), 2, Decompress),
    /content checksum mismatch/,
  );
});

test('xxh64Lower32 matches reference XXH64 vectors across stripe boundaries', () => {
  assert.equal(xxh64Lower32(new Uint8Array()), 0x51d8_e999);
  assert.equal(
    xxh64Lower32(Uint8Array.from({ length: 33 }, (_, index) => 255 - index)),
    0x225a_4e5f,
  );
  assert.equal(
    xxh64Lower32(Uint8Array.from({ length: 64 }, (_, index) => index)),
    0xdb67_13f0,
  );
});
