import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeTiffLzwStrip } from '../js/microscopy/microscopy-tiff-lzw.js';

const SHORT_IMAGECODECS_VECTOR = Uint8Array.from([
  0x80, 0x02, 0x82, 0x82, 0x33, 0x21, 0xa4, 0xf1, 0x01, 0x00,
]);

test('TIFF LZW decoder matches an independent imagecodecs reference strip', () => {
  assert.deepEqual(
    [...decodeTiffLzwStrip(SHORT_IMAGECODECS_VECTOR, 6)],
    [10, 20, 35, 100, 105, 120],
  );
});

test('TIFF LZW decoder rejects truncated, trailing, and wrong-size strips', () => {
  assert.throws(
    () => decodeTiffLzwStrip(SHORT_IMAGECODECS_VECTOR.subarray(0, -2), 6),
    /truncated or missing its end-of-information code/,
  );
  assert.throws(
    () => decodeTiffLzwStrip(Uint8Array.from([...SHORT_IMAGECODECS_VECTOR, 0]), 6),
    /trailing data/,
  );
  assert.throws(
    () => decodeTiffLzwStrip(SHORT_IMAGECODECS_VECTOR, 5),
    /expands beyond its 5 byte geometry/,
  );
  assert.throws(
    () => decodeTiffLzwStrip(SHORT_IMAGECODECS_VECTOR, 7),
    /decoded to 6 bytes; expected 7/,
  );
});
