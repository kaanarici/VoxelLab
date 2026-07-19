import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDeflateTiff } from './fixtures/microscopy/deflate-tiff.mjs';
import { installMicroscopyCanvasStub } from './fixtures/microscopy/calibrated-ome-tiff.mjs';

const { parseMicroscopyFiles, parseTiffPages } = await import('../js/microscopy/microscopy-import.js');

function fileLike(name, buffer) {
  return { name, async arrayBuffer() { return buffer; } };
}

test('TIFF Compression=8 decodes multistrip Predictor=2 pixels and ImageJ calibration', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const buffer = createDeflateTiff({
      width: 3,
      height: 2,
      pixels: [10, 20, 35, 100, 105, 120],
      predictor: 2,
      rowsPerStrip: 1,
      description: 'ImageJ=1.53\nimages=1\nunit=µm',
      xResolution: 4,
      yResolution: 2,
    });
    const pages = await parseTiffPages(buffer);
    assert.deepEqual(Array.from(pages[0].pixels), [10, 20, 35, 100, 105, 120]);

    const [result] = await parseMicroscopyFiles([fileLike('calibrated-deflate.tif', buffer)]);
    assert.deepEqual(result.entry.pixelSpacing, [0.0005, 0.00025]);
    assert.equal(result.entry.sequence, 'ImageJ-TIFF');
  } finally {
    restore();
  }
});

test('TIFF Compression=32946 reconstructs big-endian signed 16-bit Predictor=2 samples', async () => {
  const pages = await parseTiffPages(createDeflateTiff({
    width: 3,
    pixels: [-1000, -975, -1100],
    bits: 16,
    littleEndian: false,
    compression: 32946,
    predictor: 2,
    sampleFormat: 2,
  }));

  assert.deepEqual(Array.from(pages[0].pixels), [-1000, -975, -1100]);
});

test('TIFF Predictor=2 reconstructs fixed little-endian unsigned 16-bit wraparound bytes', async () => {
  const pages = await parseTiffPages(createDeflateTiff({
    width: 3,
    pixels: [65530, 2, 10],
    bits: 16,
    predictor: 2,
    // Fixed wire values: 65530, (2 - 65530) mod 65536, (10 - 2) mod 65536.
    predictedBytes: [0xfa, 0xff, 0x08, 0x00, 0x08, 0x00],
  }));

  assert.deepEqual(Array.from(pages[0].pixels), [65530, 2, 10]);
});

test('Deflate TIFF rejects unsupported predictors and page geometry before allocation', async () => {
  await assert.rejects(
    () => parseTiffPages(createDeflateTiff({ predictor: 3 })),
    /supports Predictor=1 or Predictor=2; found Predictor=3/,
  );
  await assert.rejects(
    () => parseTiffPages(createDeflateTiff({ width: 1_000_000_000, pixels: [0] })),
    /TIFF resource limit: document pages exceed the 536870912 byte retained-pixel and canvas budget/,
  );
});

test('Deflate TIFF rejects a truncated zlib stream even when it emitted the expected pixels', async () => {
  const buffer = createDeflateTiff({
    width: 65_536,
    pixels: Array.from({ length: 65_536 }, (_, index) => index & 0xff),
  });
  const bytes = new Uint8Array(buffer.slice(0));
  const view = new DataView(bytes.buffer);
  const ifdOffset = view.getUint32(4, true);
  const count = view.getUint16(ifdOffset, true);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (view.getUint16(entryOffset, true) === 279) {
      view.setUint32(entryOffset + 8, view.getUint32(entryOffset + 8, true) - 1, true);
      break;
    }
  }

  await assert.rejects(
    () => parseTiffPages(bytes.buffer),
    /could not be decompressed completely/,
  );
});
