import assert from 'node:assert/strict';
import { test } from 'node:test';

const { decodePixelData } = await import('../js/dicom/dicom-codecs.js');

const RLE_LOSSLESS = '1.2.840.10008.1.2.5';

function rleFrame(bytes) {
  return Uint8Array.from(bytes).buffer;
}

test('DICOM RLE decodes a padded deterministic 8-bit grayscale byte vector', async () => {
  // A five-byte PackBits stream is padded with zero to the required even segment length.
  const encoded = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    3, 7, 9, 11, 13, 0,
  ]);

  const pixels = await decodePixelData(encoded, RLE_LOSSLESS, 1, 4, 8);

  assert.ok(pixels instanceof Uint8Array);
  assert.deepEqual(Array.from(pixels), [7, 9, 11, 13]);
});

test('DICOM RLE decodes padded 16-bit planes in DICOM MSB-first order', async () => {
  // Both five-byte PackBits streams carry one zero pad byte. Plane 0 is the high byte.
  const encoded = rleFrame([
    2, 0, 0, 0, 64, 0, 0, 0, 70, 0, 0, 0,
    ...new Array(52).fill(0),
    3, 0, 0, 0, 0, 0,
    3, 1, 2, 3, 4, 0,
  ]);

  const pixels = await decodePixelData(encoded, RLE_LOSSLESS, 1, 4, 16);

  assert.ok(pixels instanceof Int16Array);
  assert.deepEqual(Array.from(pixels), [1, 2, 3, 4]);
});

test('DICOM RLE decodes each row from its own PackBits run', async () => {
  const encoded = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    1, 1, 2,
    1, 3, 4,
  ]);

  const pixels = await decodePixelData(encoded, RLE_LOSSLESS, 2, 2, 8);

  assert.deepEqual(Array.from(pixels), [1, 2, 3, 4]);
});

test('DICOM RLE fails closed for unsupported plane counts and malformed offsets', async () => {
  const wrong8BitSegmentCount = rleFrame([
    2, 0, 0, 0, 64, 0, 0, 0, 66, 0, 0, 0,
    ...new Array(52).fill(0),
    0, 1, 0, 2,
  ]);
  const backwardsOffset = rleFrame([
    2, 0, 0, 0, 64, 0, 0, 0, 63, 0, 0, 0,
    ...new Array(52).fill(0),
    0, 1, 0, 2,
  ]);
  const outOfBoundsOffset = rleFrame([
    1, 0, 0, 0, 66, 0, 0, 0,
    ...new Array(56).fill(0),
  ]);
  const truncatedLiteralRun = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    3, 1,
  ]);

  assert.equal(await decodePixelData(wrong8BitSegmentCount, RLE_LOSSLESS, 1, 1, 8), null);
  assert.equal(await decodePixelData(backwardsOffset, RLE_LOSSLESS, 1, 1, 16), null);
  assert.equal(await decodePixelData(outOfBoundsOffset, RLE_LOSSLESS, 1, 1, 8), null);
  assert.equal(await decodePixelData(truncatedLiteralRun, RLE_LOSSLESS, 1, 4, 8), null);
});

test('DICOM RLE rejects non-zero unused offsets and runs that cross row boundaries', async () => {
  const nonZeroUnusedOffset = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0, 65, 0, 0, 0,
    ...new Array(52).fill(0),
    0, 7,
  ]);
  const crossRowLiteral = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    3, 1, 2, 3, 4, 0,
  ]);

  assert.equal(await decodePixelData(nonZeroUnusedOffset, RLE_LOSSLESS, 1, 1, 8), null);
  assert.equal(await decodePixelData(crossRowLiteral, RLE_LOSSLESS, 2, 2, 8), null);
});

test('DICOM RLE rejects surplus encoded bytes after a complete byte plane', async () => {
  const encoded = rleFrame([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    0, 7,
    0, 9,
  ]);

  assert.equal(await decodePixelData(encoded, RLE_LOSSLESS, 1, 1, 8), null);
});
