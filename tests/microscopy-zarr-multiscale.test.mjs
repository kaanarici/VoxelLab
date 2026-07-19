/* global Blob */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOmeZarrFiles } from '../js/microscopy/microscopy-zarr-import.js';

function jsonFile(path, value) {
  return {
    name: path.split('/').pop(),
    webkitRelativePath: path,
    async text() { return JSON.stringify(value); },
  };
}

function binaryFile(path, bytes) {
  const body = Uint8Array.from(bytes);
  return {
    name: path.split('/').pop(),
    webkitRelativePath: path,
    size: body.byteLength,
    stream() { return new Blob([body]).stream(); },
  };
}

function canvasStub() {
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        getContext() {
          return {
            createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
            putImageData() {},
          };
        },
      };
    },
  };
  return () => { globalThis.document = previous; };
}

function multiscaleFiles({ coarseChannels = 1, includeChunk = true } = {}) {
  const axes = [
    { name: 't', type: 'time' },
    { name: 'c', type: 'channel' },
    { name: 'z', type: 'space', unit: 'micrometer' },
    { name: 'y', type: 'space', unit: 'micrometer' },
    { name: 'x', type: 'space', unit: 'micrometer' },
  ];
  const attrs = {
    ome: {
      version: '0.4',
      multiscales: [{
        axes,
        datasets: [
          { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 0.5, 0.5] }] },
          { path: '1', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 2, 2, 2] }] },
        ],
      }],
    },
  };
  const base = {
    zarr_format: 2,
    shape: [1, 1, 4, 3000, 3000],
    chunks: [1, 1, 1, 2, 2],
    dtype: '|u1',
    compressor: null,
    filters: null,
    order: 'C',
    fill_value: null,
  };
  const coarse = {
    zarr_format: 2,
    shape: [1, coarseChannels, 2, 2, 2],
    chunks: [1, coarseChannels, 2, 2, 2],
    dtype: '|u1',
    compressor: null,
    filters: null,
    order: 'C',
    fill_value: 0,
  };
  return [
    jsonFile('cells.zarr/.zattrs', attrs),
    jsonFile('cells.zarr/0/.zarray', base),
    jsonFile('cells.zarr/1/.zarray', coarse),
    ...(includeChunk ? [binaryFile('cells.zarr/1/0.0.0.0.0', [1, 2, 3, 4, 5, 6, 7, 8])]: []),
  ];
}

test('local multiscale import derives Z/C/T and calibration from the selected coarse level', async () => {
  const restore = canvasStub();
  try {
    const parsed = await parseOmeZarrFiles(multiscaleFiles());
    assert.equal(parsed.results.length, 1, parsed.status);
    const result = parsed.results[0];
    assert.equal(result.entry.slices, 2);
    assert.equal(result.entry.microscopy.sizeZ, 2);
    assert.equal(result.entry.microscopy.sizeC, 1);
    assert.equal(result.entry.microscopy.sizeT, 1);
    assert.deepEqual(Array.from(result.rawPlanes['0|0'][0].pixels), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(result.rawPlanes['0|0'][1].pixels), [5, 6, 7, 8]);
    assert.deepEqual(result.entry.pixelSpacing, [0.002, 0.002]);
    assert.match(result.entry.microscopy.storageProvenance, /Local Zarr v2 · level 2\/2 · ×4 downsample/);
    assert.match(parsed.status, /Loaded Local Zarr v2 · level 2\/2 · ×4 downsample/);
  } finally {
    restore();
  }
});

test('local multiscale import rejects a selected level that changes channel cardinality', async () => {
  const parsed = await parseOmeZarrFiles(multiscaleFiles({ coarseChannels: 2, includeChunk: false }));
  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /changes non-spatial axis 'c' from 1 to 2/);
});
