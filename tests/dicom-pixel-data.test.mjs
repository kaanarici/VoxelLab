import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  arrayBufferForBytes,
  bytesFromValue,
  pixelDataRestrictionReason,
  typedPixelsFromBytes,
} = await import('../js/dicom/dicom-pixel-data.js');

test('bytesFromValue accepts ArrayBuffer, views, and base64 strings', () => {
  assert.deepEqual(Array.from(bytesFromValue(new Uint8Array([1, 2]).buffer)), [1, 2]);
  assert.deepEqual(Array.from(bytesFromValue(new Uint8Array([9, 1, 2, 8]).subarray(1, 3))), [1, 2]);
  assert.deepEqual(Array.from(bytesFromValue('AQI=')), [1, 2]);
  assert.equal(bytesFromValue({}), null);
});

test('arrayBufferForBytes returns an aligned buffer for sliced byte views', () => {
  const view = new Uint8Array([9, 1, 0, 2, 0]).subarray(1);
  const aligned = arrayBufferForBytes(view);

  assert.equal(aligned.byteLength, 4);
  assert.deepEqual(Array.from(new Uint16Array(aligned)), [1, 2]);
});

test('typedPixelsFromBytes handles misaligned 16-bit DICOM byte views', () => {
  const view = new Uint8Array([99, 1, 0, 255, 255]).subarray(1);

  assert.deepEqual(Array.from(typedPixelsFromBytes(view, 16, 0, 2)), [1, 65535]);
  assert.deepEqual(Array.from(typedPixelsFromBytes(view, 16, 1, 2)), [1, -1]);
});

test('typedPixelsFromBytes honors explicit big-endian 16-bit DICOM bytes', () => {
  const view = new Uint8Array([99, 0, 1, 255, 255]).subarray(1);

  assert.deepEqual(Array.from(typedPixelsFromBytes(view, 16, 0, 2, { littleEndian: false })), [1, 65535]);
  assert.deepEqual(Array.from(typedPixelsFromBytes(view, 16, 1, 2, { littleEndian: false })), [1, -1]);
});

test('pixelDataRestrictionReason fails closed on unsupported DICOM pixel layouts', () => {
  assert.equal(pixelDataRestrictionReason({
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: 16,
    BitsStored: 12,
  }), '');
  assert.match(pixelDataRestrictionReason({ SamplesPerPixel: 3 }), /single-sample pixels/);
  assert.match(pixelDataRestrictionReason({ PhotometricInterpretation: 'RGB' }), /MONOCHROME1\/2/);
  assert.match(pixelDataRestrictionReason({ BitsAllocated: 32 }), /8- or 16-bit/);
  assert.match(pixelDataRestrictionReason({ BitsAllocated: 16, BitsStored: 0 }), /BitsStored/);
});
