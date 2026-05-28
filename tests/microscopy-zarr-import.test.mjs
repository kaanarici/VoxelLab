/* global Buffer */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { discoverOmeZarrMetadata, parseOmeZarrFiles } = await import('../js/microscopy-zarr-import.js');

function fileLike(path, body) {
  return {
    name: path.split('/').pop(),
    webkitRelativePath: path,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function binaryFileLike(path, bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name: path.split('/').pop(),
    webkitRelativePath: path,
    async arrayBuffer() {
      return buffer;
    },
  };
}

function installCanvasStub() {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(image) {
              canvas._imageData = image;
            },
          };
        },
      };
      return canvas;
    },
  };
  return () => { globalThis.document = previousDocument; };
}

function chunkForDtype(dtype, values) {
  const match = String(dtype).match(/^([<>|])([ui])([12])$/);
  assert.ok(match, `test dtype must be explicit: ${dtype}`);
  const bytes = Number(match[3]);
  const signed = match[2] === 'i';
  const littleEndian = match[1] !== '>';
  const buffer = Buffer.alloc(values.length * bytes);
  values.forEach((value, index) => {
    const offset = index * bytes;
    if (bytes === 1) {
      signed ? buffer.writeInt8(value, offset) : buffer.writeUInt8(value, offset);
    } else if (signed) {
      littleEndian ? buffer.writeInt16LE(value, offset) : buffer.writeInt16BE(value, offset);
    } else {
      littleEndian ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
    }
  });
  return buffer;
}

function tinyOmeZarrFiles({
  withChunk = true,
  dtype = '<u2',
  arrayOverrides = {},
  chunkBytes = null,
  chunkRelativePath = null,
  axes = [
    { name: 'c', type: 'channel' },
    { name: 'y', type: 'space', unit: 'micrometer' },
    { name: 'x', type: 'space', unit: 'micrometer' },
  ],
  scale = [1, 0.25, 0.5],
  versionAtRoot = true,
} = {}) {
  const shape = arrayOverrides.shape || [2, 2, 2];
  const values = Array.from({ length: shape.reduce((product, value) => product * value, 1) }, (_, index) => index * 10);
  const chunk = chunkBytes || (/^[<>|][ui][12]$/.test(dtype) ? chunkForDtype(dtype, values) : chunkForDtype('<u2', values));
  const arrayMeta = {
    zarr_format: 2,
    shape,
    chunks: arrayOverrides.chunks || shape,
    dtype,
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
    ...arrayOverrides,
  };
  const chunkPath = chunkRelativePath || `cells.zarr/0/${Array.from({ length: shape.length }, () => '0').join(arrayMeta.dimension_separator === '/' ? '/' : '.')}`;
  return [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        ...(versionAtRoot ? { version: '0.4' } : {}),
        multiscales: [{
          ...(!versionAtRoot ? { version: '0.4' } : {}),
          name: 'cells',
          axes,
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale }],
          }],
        }],
        omero: {
          channels: [{
            label: 'DAPI',
            color: '0000FF',
            family: 'linear',
            window: { min: 0, max: 4095, start: 10, end: 2000 },
          }, {
            label: 'GFP',
            color: '00FF00',
            family: 'linear',
            window: { min: 0, max: 4095, start: 25, end: 1800 },
          }],
        },
      },
    }),
    fileLike('cells.zarr/0/.zarray', arrayMeta),
    ...(withChunk ? [binaryFileLike(chunkPath, chunk)] : []),
  ];
}

function chunkedPlaneOmeZarrFiles({ omitPath = '', chunkOverrides = {} } = {}) {
  const files = [
    fileLike('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          name: 'cells',
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
          }],
        }],
        omero: {
          channels: [{
            label: 'DAPI',
            color: '0000FF',
            family: 'linear',
            window: { min: 0, max: 4095, start: 0, end: 4095 },
          }],
        },
      },
    }),
    fileLike('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, 3, 4],
      chunks: [1, 2, 3],
      dtype: '<u2',
      compressor: null,
      order: 'C',
      filters: null,
      fill_value: 0,
    }),
  ];
  const chunks = [
    ['cells.zarr/0/0.0.0', [0, 1, 2, 10, 11, 12]],
    ['cells.zarr/0/0.0.1', [3, 13]],
    ['cells.zarr/0/0.1.0', [20, 21, 22]],
    ['cells.zarr/0/0.1.1', [23]],
  ];
  for (const [path, values] of chunks) {
    if (path !== omitPath) files.push(binaryFileLike(path, chunkOverrides[path] || chunkForDtype('<u2', values)));
  }
  return files;
}

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

test('parseOmeZarrFiles loads local uncompressed zarr v2 single whole-array chunk pixels', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles());
    const [result] = parsed.results;

    assert.ok(result);
    assert.equal(parsed.status.includes('Loaded local uncompressed level-0 chunk data'), true);
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

test('parseOmeZarrFiles assembles uncompressed zarr v2 edge chunks into one calibrated plane', async () => {
  const restoreDocument = installCanvasStub();
  try {
    const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles());
    const [result] = parsed.results;
    const image = result.localStacks['0|0'][0]._imageData;
    const reds = [];
    for (let index = 0; index < image.data.length; index += 4) reds.push(image.data[index]);

    assert.equal(parsed.status.includes('Loaded local uncompressed level-0 chunk data'), true);
    assert.deepEqual(result.entry.pixelSpacing, [0.00025, 0.0005]);
    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.c, plane.z, plane.t]), [[0, 0, 0]]);
    assert.deepEqual(reds, [0, 11, 22, 33, 111, 122, 133, 144, 222, 233, 244, 255]);
  } finally {
    restoreDocument();
  }
});

test('parseOmeZarrFiles falls back when a required uncompressed zarr v2 chunk is missing', async () => {
  const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles({
    omitPath: 'cells.zarr/0/0.0.0',
  }));

  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.status.includes('OME-Zarr metadata recognized'), true);
  assert.equal(parsed.status.includes('level 0 chunk is missing: cells.zarr/0/0.0.0'), true, parsed.status);
});

test('parseOmeZarrFiles falls back when an edge chunk byte count is wrong', async () => {
  const parsed = await parseOmeZarrFiles(chunkedPlaneOmeZarrFiles({
    chunkOverrides: {
      'cells.zarr/0/0.0.1': chunkForDtype('<u2', [3]),
    },
  }));

  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.status.includes('byte length'), true, parsed.status);
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

for (const dtype of ['<u1', '|u1', '<u2', '>u2', '<i2', '>i2']) {
  test(`parseOmeZarrFiles accepts supported explicit ${dtype} single-chunk arrays`, async () => {
    const restoreDocument = installCanvasStub();
    try {
      const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ dtype }));
      assert.equal(parsed.results.length, 1);
      assert.equal(parsed.status.includes('Loaded local uncompressed level-0 chunk data'), true);
    } finally {
      restoreDocument();
    }
  });
}

test('parseOmeZarrFiles falls back to metadata-only when the level chunk is missing', async () => {
  const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles({ withChunk: false }));

  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.status.includes('OME-Zarr metadata recognized'), true);
  assert.equal(parsed.status.includes('level 0 chunk is missing'), true);
});

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

for (const [name, options, expected] of [
  ['missing endian dtype', { dtype: 'u2' }, 'uint8/int8/uint16/int16'],
  ['byte-order independent 16-bit dtype', { dtype: '|u2' }, 'uint8/int8/uint16/int16'],
  ['Fortran order', { arrayOverrides: { order: 'F' } }, 'explicit C-order'],
  ['missing order', { arrayOverrides: { order: undefined } }, 'explicit C-order'],
  ['compressed chunk', { arrayOverrides: { compressor: { id: 'gzip' } } }, 'uncompressed chunks only'],
  ['filtered chunk', { arrayOverrides: { filters: [{ id: 'delta' }] } }, 'zarr filters'],
  ['extra chunk bytes', { chunkBytes: Buffer.concat([chunkForDtype('<u2', Array.from({ length: 8 }, (_, index) => index)), Buffer.from([0])]) }, 'byte length'],
]) {
  test(`parseOmeZarrFiles falls back for unsupported ${name}`, async () => {
    const parsed = await parseOmeZarrFiles(tinyOmeZarrFiles(options));
    assert.deepEqual(parsed.results, []);
    assert.equal(parsed.status.includes(expected), true, parsed.status);
  });
}

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
    /axes_channel_or_custom_order_invalid/,
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
