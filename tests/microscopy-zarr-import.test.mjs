/* global Buffer, ReadableStream */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  chunkedPlaneOmeZarrFiles,
  chunkForDtype,
  installOmeZarrCanvasStub as installCanvasStub,
  manyChunkOmeZarrFiles,
  omeZarrBinaryFile as binaryFileLike,
  omeZarrFixtureBytes as fixtureBytes,
  omeZarrJsonFile as fileLike,
  tinyConsolidatedOmeZarrFiles,
  tinyOmeZarrFiles,
} from './fixtures/microscopy/local-ome-zarr.mjs';

const {
  buildOmeZarrSeriesResults,
  discoverOmeZarrMetadata,
  isOmeZarrFile,
  parseOmeZarrFiles,
} = await import('../js/microscopy/microscopy-zarr-import.js');

test('isOmeZarrFile recognizes standard zarr group metadata files', () => {
  assert.equal(isOmeZarrFile({ webkitRelativePath: 'cells.zarr/.zgroup' }), true);
  assert.equal(isOmeZarrFile({ webkitRelativePath: 'cells/.zgroup' }), true);
  assert.equal(isOmeZarrFile({ webkitRelativePath: 'cells.zarr/.zmetadata' }), true);
  assert.equal(isOmeZarrFile({ webkitRelativePath: 'cells.zarr/zarr.json' }), true);
  assert.equal(isOmeZarrFile({ webkitRelativePath: 'cells.zarr/0/zarr.json' }), true);
});

test('discoverOmeZarrMetadata reads group and array metadata from a zarr v2 file list', async () => {
  const result = await discoverOmeZarrMetadata(tinyOmeZarrFiles());

  assert.ok(result);
  assert.equal(result.rootPath, 'cells.zarr');
  assert.equal(result.rootMetadataPath, 'cells.zarr/.zattrs');
  assert.deepEqual(result.missingArrayMetadata, []);
  assert.equal(result.metadata.pixel.type, 'uint16');
  assert.deepEqual(result.metadata.axes.map((axis) => [axis.name, axis.size, axis.scale, axis.unit]), [
    ['c', 2, 1, ''],
    ['y', 2, 0.25, 'micrometer'],
    ['x', 2, 0.5, 'micrometer'],
  ]);
  assert.deepEqual(result.metadata.channels.map((channel) => [channel.name, channel.color, channel.displayRange]), [
    ['DAPI', '#0000FF', [10, 2000]],
    ['GFP', '#00FF00', [25, 1800]],
  ]);
});

test('parseOmeZarrFiles loads local zarr v2 data from consolidated metadata', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(await tinyConsolidatedOmeZarrFiles());
    const [result] = parsed.results;

    assert.ok(result);
    assert.match(parsed.status, /Loaded Local Zarr v2 · level 1\/1 · full resolution/);
    assert.equal(result.entry.sequence, 'OME-Zarr');
    assert.deepEqual(result.entry.pixelSpacing, [0.00025, 0.0005]);
    assert.deepEqual(Object.keys(result.localStacks).sort(), ['0|0', '1|0']);
    assert.deepEqual(result.entry.microscopyDataset.channels.map(channel => channel.name), ['DAPI', 'GFP']);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles loads local uncompressed zarr v2 single whole-array chunk pixels', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles());
    const [result] = parsed.results;

    assert.ok(result);
    assert.match(parsed.status, /Loaded Local Zarr v2 · level 1\/1 · full resolution/);
    assert.equal(result.entry.name, 'cells');
    assert.equal(result.entry.sequence, 'OME-Zarr');
    assert.deepEqual(result.entry.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(result.entry.microscopy.sizeC, 2);
    assert.equal(result.entry.microscopy.sizeZ, 1);
    assert.deepEqual(Object.keys(result.localStacks).sort(), ['0|0', '1|0']);
    assert.deepEqual(result.entry.microscopyDataset.axes.map(axis => [axis.name, axis.size]), [
      ['x', 2],
      ['y', 2],
      ['z', 1],
      ['c', 2],
      ['t', 1],
    ]);
    assert.deepEqual(result.entry.microscopyDataset.levels, [{
      level: 0,
      path: '0',
      width: 2,
      height: 2,
      tileWidth: 2,
      tileHeight: 2,
      chunkShape: { t: 1, c: 2, z: 1, y: 2, x: 2 },
      downsample: 1,
    }]);
    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.c, plane.z, plane.t]), [[0, 0, 0], [1, 0, 0]]);
    assert.deepEqual(result.entry.microscopyDataset.channels.map(channel => [
      channel.name,
      channel.color,
      channel.displayRange,
      channel.displayRangeSource,
    ]), [
      ['DAPI', '#0000FF', [10, 2000], 'metadata'],
      ['GFP', '#00FF00', [25, 1800], 'metadata'],
    ]);
    assert.deepEqual(result.localStacks['0|0'][0]._microscopyRawRange, [0, 30]);
    assert.deepEqual(result.localStacks['1|0'][0]._microscopyRawRange, [40, 70]);
    assert.deepEqual(result.localStacks['0|0'][0]._microscopyDisplayByteRange, [85, 17000]);
    assert.deepEqual(result.localStacks['1|0'][0]._microscopyDisplayByteRange, [-127.5, 14960]);
  } finally {
    restoreDocument();
  }
});

test('buildOmeZarrSeriesResults reuses the discovered local zarr file lookup', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const discovery = await discoverOmeZarrMetadata(tinyOmeZarrFiles());
    const results = await buildOmeZarrSeriesResults(discovery);

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.sequence, 'OME-Zarr');
    assert.deepEqual(Object.keys(results[0].localStacks).sort(), ['0|0', '1|0']);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles preserves mixed per-axis OME-Zarr physical units', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
      axes: [
        { name: 'c', type: 'channel' },
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'x', type: 'space', unit: 'millimeter' },
      ],
      scale: [1, 250, 0.5],
    }));
    const [result] = parsed.results;

    assert.deepEqual(result.entry.pixelSpacing, [0.25, 0.5]);
    assert.equal(result.entry.physicalUnit, 'mm');
    assert.deepEqual(result.entry.microscopyDataset.axes.slice(0, 2).map(axis => [axis.name, axis.unit, axis.scale, axis.known]), [
      ['x', 'mm', 0.5, true],
      ['y', 'µm', 250, true],
    ]);
    assert.equal(result.entry.description.includes('0.500 mm/px'), true, result.entry.description);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles does not calibrate spatial scales without axis units', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
      axes: [
        { name: 'c', type: 'channel' },
        { name: 'y', type: 'space' },
        { name: 'x', type: 'space' },
      ],
      scale: [1, 0.25, 0.5],
    }));
    const [result] = parsed.results;

    assert.deepEqual(result.entry.pixelSpacing, [0, 0]);
    assert.equal(result.entry._spacingKnown, false);
    assert.deepEqual(result.entry.microscopyDataset.axes.slice(0, 2).map(axis => [axis.name, axis.unit, axis.scale, axis.known]), [
      ['x', 'mm', 0, false],
      ['y', 'mm', 0, false],
    ]);
    assert.equal(result.entry.microscopyDataset.source.warnings.includes('missing_xy_physical_size'), true);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles assembles zarr v2 edge chunks into one calibrated plane', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles());
    const [result] = parsed.results;
    const image = result.localStacks['0|0'][0]._imageData;
    const reds = [];
    for (let index = 0; index < image.data.length; index += 4) reds.push(image.data[index]);

    assert.match(parsed.status, /Loaded Local Zarr v2 · level 1\/1 · full resolution/);
    assert.deepEqual(result.entry.pixelSpacing, [0.00025, 0.0005]);
    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.c, plane.z, plane.t]), [[0, 0, 0]]);
    assert.deepEqual(reds, [0, 11, 22, 33, 111, 122, 133, 144, 222, 233, 244, 255]);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles bounds concurrent zarr v2 chunk reads', async () => {
  const restoreDocument = installCanvasStub();
  const tracker = { active: 0, maxActive: 0 };
  try {
    const parsed = await parseOmeZarrFiles(manyChunkOmeZarrFiles({ tracker }));

    assert.equal(parsed.results.length, 1, parsed.status);
    assert.match(parsed.status, /Loaded Local Zarr v2 · level 1\/1 · full resolution/);
    assert.ok(tracker.maxActive > 1, `expected chunk reads to remain parallel, saw ${tracker.maxActive}`);
    assert.ok(tracker.maxActive <= 2, `expected at most 2 concurrent chunk reads, saw ${tracker.maxActive}`);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles fills a missing v2 chunk from finite fill_value', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles({
      omitPath: 'cells.zarr/0/0.0.0',
      arrayOverrides: { fill_value: 7 },
    }));
    assert.equal(parsed.results.length, 1);
    assert.deepEqual(Array.from(parsed.results[0].rawPlanes['0|0'][0].pixels.slice(0, 3)), [7, 7, 7]);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles rejects aggregate plane allocations before reading local chunks', async () => {
  let chunkReads = 0;
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [20, 1024, 1024],
      chunks: [1, 1024, 1024],
      dtype: '<u2',
      compressor: null,
      order: 'C',
      filters: null,
    }),
    {
      name: '0.0.0',
      webkitRelativePath: 'cells.zarr/0/0.0.0',
      async arrayBuffer() {
        chunkReads += 1;
        return new ArrayBuffer(0);
      },
    },
  ];

  const parsed = await parseOmeZarrFiles(files);

  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /OME-Zarr resource limit: .*aggregate plane pixels/);
  assert.equal(chunkReads, 0);
});

test('parseOmeZarrFiles rejects a large custom axis before reading local chunks', async () => {
  let chunkReads = 0;
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'phase', type: 'custom' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [100_000_000, 1, 1],
      chunks: [100_000_000, 1, 1],
      dtype: '|u1',
      compressor: null,
      order: 'C',
      filters: null,
    }),
    {
      name: '0.0.0',
      webkitRelativePath: 'cells.zarr/0/0.0.0',
      async arrayBuffer() {
        chunkReads += 1;
        return new ArrayBuffer(0);
      },
    },
  ];

  const parsed = await parseOmeZarrFiles(files);

  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /unsupported axis 'phase' has size 100000000/);
  assert.equal(chunkReads, 0);
});

test('parseOmeZarrFiles rejects an oversized local chunk from File.size before reading it', async () => {
  let chunkReads = 0;
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, 1, 1],
      chunks: [1, 1, 1],
      dtype: '|u1',
      compressor: null,
      order: 'C',
      filters: null,
    }),
    {
      name: '0.0.0',
      size: 32 * 1024 * 1024 + 1,
      webkitRelativePath: 'cells.zarr/0/0.0.0',
      async arrayBuffer() {
        chunkReads += 1;
        return new ArrayBuffer(0);
      },
    },
  ];

  const parsed = await parseOmeZarrFiles(files);

  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /encoded chunk exceeds the 33554432 byte budget/);
  assert.equal(chunkReads, 0);
});

test('parseOmeZarrFiles rejects a local chunk without bounded streaming before arrayBuffer', async () => {
  let arrayBufferCalls = 0;
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, 1, 1],
      chunks: [1, 1, 1],
      dtype: '|u1',
      compressor: null,
      order: 'C',
      filters: null,
    }),
    {
      name: '0.0.0',
      webkitRelativePath: 'cells.zarr/0/0.0.0',
      async arrayBuffer() {
        arrayBufferCalls += 1;
        return new ArrayBuffer((32 * 1024 * 1024) + 1);
      },
    },
  ];

  const parsed = await parseOmeZarrFiles(files);

  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /bounded encoded chunk streaming is unavailable/);
  assert.equal(arrayBufferCalls, 0);
});

test('parseOmeZarrFiles caps a streamed local chunk whose declared size is understated', async () => {
  let arrayBufferCalls = 0;
  let streamCancelled = false;
  const chunkBytes = 16 * 1024 * 1024;
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, 1, 1],
      chunks: [1, 1, 1],
      dtype: '|u1',
      compressor: null,
      order: 'C',
      filters: null,
    }),
    {
      name: '0.0.0',
      size: 1,
      webkitRelativePath: 'cells.zarr/0/0.0.0',
      async arrayBuffer() {
        arrayBufferCalls += 1;
        throw new Error('arrayBuffer must not be used for bounded local chunks');
      },
      stream() {
        let index = 0;
        return new ReadableStream({
          pull(controller) {
            if (index < 2) {
              index += 1;
              controller.enqueue(new Uint8Array(chunkBytes));
              return;
            }
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            streamCancelled = true;
          },
        });
      },
    },
  ];

  const parsed = await parseOmeZarrFiles(files);

  assert.deepEqual(parsed.results, []);
  assert.match(parsed.status, /encoded chunk exceeds the 33554432 byte budget while streaming/);
  assert.equal(arrayBufferCalls, 0);
  assert.equal(streamCancelled, true);
});

test('parseOmeZarrFiles falls back when an edge chunk decoded byte count is wrong', async () => {
  const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles({
    chunkOverrides: {
      'cells.zarr/0/0.0.1': chunkForDtype('<u2', [3]),
    },
  }));

  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.status.includes('expectedBytes decoded length mismatch'), true, parsed.status);
});

test('parseOmeZarrFiles accepts real NGFF 0.4-style multiscales version placement', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ versionAtRoot: false }));
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].entry.sequence, 'OME-Zarr');
  } finally {
    restoreDocument();
  }
});

for (const dtype of ['<u1', '|u1', '<u2', '>u2', '<i2', '>i2', '<u4', '>i4', '<f4']) {
  test(`parseOmeZarrFiles accepts supported explicit ${dtype} single-chunk arrays`, async () => {
    const restoreDocument = installCanvasStub();
    try {
      const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ dtype }));
      assert.equal(parsed.results.length, 1);
      assert.match(parsed.status, /Loaded Local Zarr v2 · level 1\/1 · full resolution/);
    } finally {
      restoreDocument();
    }
  });
}

test('chunkForDtype refuses unsupported float widths', () => {
  assert.throws(() => chunkForDtype('<f2', [1]), /explicit integer or float32 type/);
});

for (const [dtype, values, ArrayType] of [
  ['<i4', [16_777_216, 16_777_217, -16_777_216, -16_777_217], Int32Array],
  ['>u4', [4_000_000_000, 4_000_000_001, 16_777_216, 16_777_217], Uint32Array],
]) {
  test(`parseOmeZarrFiles keeps ${dtype} scalar values exact across local chunk copies`, async () => {
    const restoreDocument = installCanvasStub();
    try {
      const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
        dtype,
        arrayOverrides: { shape: [1, 2, 2], chunks: [1, 2, 2] },
        chunkBytes: chunkForDtype(dtype, values),
      }));
      assert.equal(parsed.results.length, 1, parsed.status);
      const pixels = parsed.results[0].rawPlanes['0|0'][0].pixels;
      assert.equal(pixels instanceof ArrayType, true);
      assert.deepEqual(Array.from(pixels), values);
      assert.equal(parsed.results[0].entry.microscopyDataset.pixel.type, dtype === '<i4' ? 'int32' : 'uint32');
    } finally {
      restoreDocument();
    }
  });
}

test('parseOmeZarrFiles fills a missing whole-array v2 chunk with a declared zero fill value', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ withChunk: false }));
    assert.equal(parsed.results.length, 1);
    assert.deepEqual(Array.from(parsed.results[0].rawPlanes['0|0'][0].pixels), [0, 0, 0, 0]);
  } finally {
    restoreDocument();
  }
});

for (const [label, fillValue] of [['null', null], ['omitted', undefined]]) {
  test(`parseOmeZarrFiles fails a missing v2 chunk closed when fill_value is ${label}`, async () => {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
      withChunk: false,
      arrayOverrides: { fill_value: fillValue },
    }));
    assert.deepEqual(parsed.results, []);
    assert.match(parsed.status, /no concrete fill_value/);
  });
}

test('parseOmeZarrFiles supports slash-separated single-chunk paths', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
      arrayOverrides: { dimension_separator: '/' },
      chunkRelativePath: 'cells.zarr/0/0/0/0',
    }));
    assert.equal(parsed.results.length, 1);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles loads a bounded unsharded OME-NGFF 0.5 Zarr v3 array', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const attrs = {
      zarr_format: 3,
      node_type: 'group',
      attributes: {
        ome: {
          version: '0.5',
          multiscales: [{
            axes: [
              { name: 'c', type: 'channel' },
              { name: 'y', type: 'space', unit: 'micrometer' },
              { name: 'x', type: 'space', unit: 'micrometer' },
            ],
            datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 2, 3] }] }],
          }],
        },
      },
    };
    const array = {
      zarr_format: 3,
      node_type: 'array',
      shape: [1, 2, 2],
      data_type: 'float32',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 1, 1] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    };
    const parsed = await parseOmeZarrFiles([
      fileLike('cells.zarr/zarr.json', attrs),
      fileLike('cells.zarr/0/zarr.json', array),
      binaryFileLike('cells.zarr/0/c/0/0/0', chunkForDtype('<f4', [1.5])),
      binaryFileLike('cells.zarr/0/c/0/0/1', chunkForDtype('<f4', [2.5])),
      binaryFileLike('cells.zarr/0/c/0/1/0', chunkForDtype('<f4', [3.5])),
      binaryFileLike('cells.zarr/0/c/0/1/1', chunkForDtype('<f4', [4.5])),
    ]);
    assert.equal(parsed.results.length, 1, parsed.status);
    assert.deepEqual(Array.from(parsed.results[0].rawPlanes['0|0'][0].pixels), [1.5, 2.5, 3.5, 4.5]);
    assert.deepEqual(parsed.results[0].entry.microscopyDataset.levels[0].chunkShape, { t: 1, c: 1, z: 1, y: 1, x: 1 });
    assert.equal(parsed.results[0].entry.microscopyDataset.levels[0].tileWidth, 1);
    assert.equal(parsed.results[0].entry.microscopyDataset.levels[0].tileHeight, 1);
    assert.match(parsed.results[0].entry.microscopy.storageProvenance, /Local Zarr v3/);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles rejects Zarr v3 sharding and non-default chunk keys', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const files = tinyOmeZarrFiles();
    const attrs = JSON.parse(await files[0].text());
    attrs.ome.version = '0.5';
    files[0] = fileLike('cells.zarr/zarr.json', { zarr_format: 3, node_type: 'group', attributes: { ome: attrs.ome } });
    files[1] = fileLike('cells.zarr/0/zarr.json', {
      zarr_format: 3, node_type: 'array', shape: [2, 2, 2], data_type: 'uint16',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 2, 2] } },
      chunk_key_encoding: { name: 'v2', configuration: { separator: '.' } },
      codecs: [{ name: 'sharding_indexed', configuration: {} }], fill_value: 0,
    });
    const parsed = await parseOmeZarrFiles(files);
    assert.deepEqual(parsed.results, []);
    assert.match(parsed.status, /chunk_key_encoding/);
  } finally {
    restoreDocument();
  }
});

for (const [name, options, expected] of [
  ['missing endian dtype', { dtype: 'u2' }, 'dtype'],
  ['byte-order independent 16-bit dtype', { dtype: '|u2' }, 'dtype'],
  ['Fortran order', { arrayOverrides: { order: 'F' } }, 'explicit C-order'],
  ['missing order', { arrayOverrides: { order: undefined } }, 'explicit C-order'],
  ['extra chunk bytes', { chunkBytes: Buffer.concat([chunkForDtype('<u2', Array.from({ length: 8 }, (_, index) => index)), Buffer.from([0])]) }, 'expectedBytes decoded length mismatch'],
]) {
  test(`parseOmeZarrFiles falls back for unsupported ${name}`, async () => {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles(options));
    assert.deepEqual(parsed.results, []);
    assert.equal(parsed.status.includes('No image series was added'), true, parsed.status);
    assert.equal(parsed.status.includes(expected), true, parsed.status);
  });
}

test('parseOmeZarrFiles decodes the committed Blosc LZ4 byte-shuffle golden through the local path', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const chunk = fixtureBytes('idr0062A-6001240-L0-c0z0.blosc');
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({
      axes: [
        { name: 'c', type: 'channel' },
        { name: 'z', type: 'space', unit: 'micrometer' },
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'x', type: 'space', unit: 'micrometer' },
      ],
      scale: [1, 1, 0.5, 0.5],
      arrayOverrides: {
        shape: [1, 1, 275, 271],
        chunks: [1, 1, 275, 271],
        compressor: { id: 'blosc', cname: 'lz4', shuffle: 1, clevel: 5, blocksize: 0 },
      },
      chunkBytes: chunk,
    }));
    const plane = parsed.results[0].rawPlanes['0|0'][0];

    assert.equal(parsed.results.length, 1);
    assert.deepEqual(Array.from(plane.pixels.slice(0, 8)), [8, 9, 8, 10, 8, 11, 9, 9]);
    assert.equal(plane.pixels.length, 275 * 271);
    assert.equal(parsed.results[0].entry.microscopy.storageProvenance, 'Local Zarr v2 · level 1/1 · full resolution · blosc(lz4, byte-shuffle)');
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles decodes gzip-compressed edge chunks', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const chunks = {
      'cells.zarr/0/0.0.0': gzipSync(chunkForDtype('<u2', [0, 1, 2, 10, 11, 12])),
      'cells.zarr/0/0.0.1': gzipSync(chunkForDtype('<u2', [3, 999, 999, 13, 999, 999])),
      'cells.zarr/0/0.1.0': gzipSync(chunkForDtype('<u2', [20, 21, 22, 999, 999, 999])),
      'cells.zarr/0/0.1.1': gzipSync(chunkForDtype('<u2', [23, 999, 999, 999, 999, 999])),
    };
    const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles({
      chunkOverrides: chunks,
      arrayOverrides: { compressor: { id: 'gzip' } },
    }));
    const image = parsed.results[0].localStacks['0|0'][0]._imageData;
    const reds = [];
    for (let index = 0; index < image.data.length; index += 4) reds.push(image.data[index]);

    assert.equal(parsed.results.length, 1);
    assert.deepEqual(reds, [0, 11, 22, 33, 111, 122, 133, 144, 222, 233, 244, 255]);
    assert.equal(parsed.results[0].entry.microscopy.storageProvenance, 'Local Zarr v2 · level 1/1 · full resolution · gzip');
  } finally {
    restoreDocument();
  }
});

for (const [name, arrayOverrides, expected] of [
  ['filters', { filters: [{ id: 'delta' }] }, 'filters'],
  ['Blosc bitshuffle', { compressor: { id: 'blosc', cname: 'lz4', shuffle: 2 } }, 'Blosc shuffle=2'],
  ['unknown compressor', { compressor: { id: 'snappy' } }, "compressor.id 'snappy'"],
]) {
  test(`parseOmeZarrFiles fails closed for unsupported ${name}`, async () => {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ arrayOverrides }));

    assert.deepEqual(parsed.results, []);
    assert.match(parsed.status, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('parseOmeZarrFiles marks NGFF 0.5 metadata on zarr v2 arrays as nonconforming compatibility input', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const files = tinyOmeZarrFiles();
    const attrs = JSON.parse(await files[0].text());
    attrs.ome.version = '0.5';
    files[0] = fileLike('cells.zarr/.zattrs', attrs);
    const parsed = await parseOmeZarrFiles(files);

    assert.equal(parsed.results.length, 1);
    assert.equal(
      parsed.results[0].entry.microscopyDataset.source.warnings.includes(
        'Nonconforming OME-Zarr 0.5 metadata on a Zarr v2 array loaded in compatibility mode',
      ),
      true,
    );
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles rejects axis order that cannot map an OME plane safely', async () => {
  await assert.rejects(
    parseOmeZarrFiles(tinyOmeZarrFiles({
      axes: [
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'x', type: 'space', unit: 'micrometer' },
        { name: 'c', type: 'channel' },
      ],
      scale: [0.25, 0.5, 1],
    })),
    /Channel\/custom axes must appear before spatial axes/,
  );
});

test('discoverOmeZarrMetadata reports missing level array metadata without claiming pixel type', async () => {
  const result = await discoverOmeZarrMetadata([
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.5',
        multiscales: [{
          axes: [
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale: [0.25, 0.25] }],
          }],
        }],
      },
    }),
  ]);

  assert.ok(result);
  assert.deepEqual(result.missingArrayMetadata, ['0']);
  assert.equal(result.metadata.pixel.type, 'unknown');
  assert.equal(result.metadata.warnings.includes('array_metadata_missing_0'), true);
  assert.equal(result.metadata.warnings.includes('pixel_type_unresolved'), true);
});

test('discoverOmeZarrMetadata returns null when no OME multiscales metadata is present', async () => {
  const result = await discoverOmeZarrMetadata([
    fileLike('plain.zarr/.zattrs', { zarr_format: 2 }),
  ]);

  assert.equal(result, null);
});
