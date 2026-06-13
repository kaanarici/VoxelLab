import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeUint16RawVolume } = await import('../js/volume/volume-raw-normalize.js');

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
