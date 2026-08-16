import assert from 'node:assert/strict';
import { test } from 'node:test';

let drawCalls = 0;

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    let currentImage = null;
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage(img) {
          drawCalls += 1;
          currentImage = img;
        },
        getImageData(_x, _y, w, h) {
          const bytes = currentImage?._bytesBySize?.[`${w}x${h}`] || new Uint8Array(w * h);
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0, p = 0; i < bytes.length; i += 1, p += 4) {
            data[p] = bytes[i];
            data[p + 1] = bytes[i];
            data[p + 2] = bytes[i];
            data[p + 3] = 255;
          }
          return { data };
        },
      }),
    };
  },
};

const { readImageByteData, readOverlayData } = await import('../js/overlay/overlay-data.js');
const { createLocalByteSlice, downsampleLocalByteSlice } = await import('../js/series/local-byte-slice.js');
const { getRawSliceData } = await import('../js/raw-slice-data.js');
const { state } = await import('../js/core/state.js');

test('overlay pixel cache keeps decoded data for multiple sizes of the same image', () => {
  drawCalls = 0;
  const img = {
    complete: true,
    naturalWidth: 4,
    _bytesBySize: {
      '2x2': Uint8Array.from([1, 2, 3, 4]),
      '4x1': Uint8Array.from([5, 6, 7, 8]),
    },
  };

  const firstSmall = readImageByteData(img, 2, 2);
  const firstWide = readImageByteData(img, 4, 1);
  const secondSmall = readImageByteData(img, 2, 2);
  const secondWideRgba = readOverlayData(img, 4, 1);
  const secondWide = readImageByteData(img, 4, 1);

  assert.deepEqual([...firstSmall], [1, 2, 3, 4]);
  assert.deepEqual([...firstWide], [5, 6, 7, 8]);
  assert.equal(secondSmall, firstSmall);
  assert.equal(secondWide, firstWide);
  assert.equal(secondWideRgba.length, 16);
  assert.equal(drawCalls, 2);
});

test('local byte slices bypass canvas decoding and expose grayscale overlay data on demand', () => {
  drawCalls = 0;
  const slice = createLocalByteSlice(Uint8Array.from([2, 4, 6, 8]), 2, 2);

  const bytes = readImageByteData(slice, 2, 2);
  const rgba = readOverlayData(slice, 2, 2);

  assert.deepEqual([...bytes], [2, 4, 6, 8]);
  assert.deepEqual([...rgba.slice(0, 8)], [2, 2, 2, 255, 4, 4, 4, 255]);
  assert.equal(drawCalls, 0);
});

test('local byte thumbnails downsample into a bounded aspect-preserving buffer', () => {
  const bytes = Uint8Array.from({ length: 320 * 80 }, (_, index) => index % 256);

  const thumbnail = downsampleLocalByteSlice(bytes, 320, 80, 160);

  assert.deepEqual(
    { width: thumbnail.width, height: thumbnail.height, byteLength: thumbnail.bytes.byteLength },
    { width: 160, height: 40, byteLength: 160 * 40 },
  );
  assert.equal(thumbnail.bytes[0], bytes[1 * 320 + 1]);
  assert.equal(thumbnail.bytes.at(-1), bytes[79 * 320 + 319]);
});

test('raw slice reads follow image identity after a series index is reused', () => {
  const previousManifest = state.manifest;
  const previousSeriesIdx = state.seriesIdx;
  const previousSliceIdx = state.sliceIdx;
  const previousImages = state.imgs;
  try {
    state.manifest = { series: [{ slug: 'removed', width: 2, height: 2 }] };
    state.seriesIdx = 0;
    state.sliceIdx = 0;
    state.imgs = [createLocalByteSlice(Uint8Array.from([1, 2, 3, 4]), 2, 2)];
    assert.deepEqual([...getRawSliceData()].filter((_, index) => index % 4 === 0), [1, 2, 3, 4]);

    state.manifest.series = [{ slug: 'successor', width: 2, height: 2 }];
    state.imgs = [createLocalByteSlice(Uint8Array.from([9, 8, 7, 6]), 2, 2)];
    assert.deepEqual([...getRawSliceData()].filter((_, index) => index % 4 === 0), [9, 8, 7, 6]);
  } finally {
    state.manifest = previousManifest;
    state.seriesIdx = previousSeriesIdx;
    state.sliceIdx = previousSliceIdx;
    state.imgs = previousImages;
  }
});
