import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildMicroscopyDataset,
  channelMetadata,
  datasetSpacingMm,
} = await import('../js/microscopy-dataset-model.js');

test('buildMicroscopyDataset normalizes hyperstack axes, pixels, channels, and provenance', () => {
  const dataset = buildMicroscopyDataset({
    fileName: 'cells.ome.tiff',
    slugBase: 'micro_cells',
    metadata: {
      source: 'OME-TIFF',
      sizeX: 2,
      sizeY: 2,
      sizeZ: 2,
      sizeC: 2,
      sizeT: 1,
      physicalSizeX: 0.5,
      physicalSizeY: 0.25,
      physicalSizeZ: 2,
      physicalUnit: 'µm',
      channelNames: ['DAPI', 'GFP'],
    },
    pages: [
      { width: 2, height: 2, bitsPerSample: 16, samplesPerPixel: 1, pixels: new Float32Array([0, 50, 100, 150]) },
      { width: 2, height: 2, bitsPerSample: 16, samplesPerPixel: 1, pixels: new Float32Array([200, 250, 300, 350]) },
    ],
    planePositions: [
      { c: 0, z: 0, t: 0 },
      { c: 1, z: 0, t: 0 },
    ],
  });

  assert.equal(dataset.id, 'micro_cells');
  assert.equal(dataset.name, 'cells');
  assert.equal(dataset.source.originalFormat, 'OME-TIFF');
  assert.deepEqual(dataset.source.warnings, []);
  assert.deepEqual(dataset.axes.map(axis => [axis.name, axis.size, axis.unit, axis.scale, axis.known]), [
    ['x', 2, 'µm', 0.5, true],
    ['y', 2, 'µm', 0.25, true],
    ['z', 2, 'µm', 2, true],
    ['c', 2, '', 0, false],
    ['t', 1, 'index', 1, false],
  ]);
  assert.deepEqual(dataset.pixel, {
    type: 'uint16',
    samplesPerPixel: 1,
    endianness: 'little',
    min: 0,
    max: 350,
  });
  assert.deepEqual(dataset.channels.map(channel => channel.name), ['DAPI', 'GFP']);
  assert.deepEqual(dataset.planes.map(plane => [plane.c, plane.z, plane.t, plane.pageIndex]), [
    [0, 0, 0, 0],
    [1, 0, 0, 1],
  ]);
  assert.deepEqual(datasetSpacingMm(dataset), {
    rowMm: 0.00025,
    colMm: 0.0005,
    zMm: 0.002,
    zKnown: true,
    unit: 'µm',
  });
});

test('buildMicroscopyDataset keeps missing calibration explicit', () => {
  const dataset = buildMicroscopyDataset({
    fileName: 'uncalibrated.tif',
    metadata: { source: 'TIFF', sizeZ: 1, sizeC: 1, sizeT: 1 },
    pages: [
      { width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 1, pixels: new Float32Array([7]) },
    ],
  });

  assert.deepEqual(dataset.source.warnings, ['missing_xy_physical_size', 'missing_z_physical_size']);
  assert.deepEqual(datasetSpacingMm(dataset), {
    rowMm: 0,
    colMm: 0,
    zMm: 0,
    zKnown: false,
    unit: 'µm',
  });
  assert.equal(channelMetadata(dataset, 2).name, 'Channel 3');
});

test('buildMicroscopyDataset converts per-axis physical units independently', () => {
  const dataset = buildMicroscopyDataset({
    fileName: 'mixed-units.ome.zarr',
    metadata: {
      source: 'OME-Zarr',
      sizeX: 1,
      sizeY: 1,
      sizeZ: 1,
      physicalSizeX: 0.5,
      physicalSizeY: 250,
      physicalSizeZ: 0.000002,
      physicalUnits: { x: 'millimeter', y: 'micrometer', z: 'meter' },
    },
    pages: [
      { width: 1, height: 1, bitsPerSample: 16, samplesPerPixel: 1, pixels: new Float32Array([1]) },
    ],
  });

  assert.deepEqual(dataset.axes.slice(0, 3).map(axis => [axis.name, axis.unit, axis.scale, axis.known]), [
    ['x', 'mm', 0.5, true],
    ['y', 'µm', 250, true],
    ['z', 'm', 0.000002, true],
  ]);
  assert.deepEqual(datasetSpacingMm(dataset), {
    rowMm: 0.25,
    colMm: 0.5,
    zMm: 0.002,
    zKnown: true,
    unit: 'mm',
  });
});

test('buildMicroscopyDataset preserves OME-Zarr pyramid level and chunk metadata', () => {
  const dataset = buildMicroscopyDataset({
    fileName: 'cells.zarr',
    metadata: {
      source: 'OME-Zarr',
      sizeX: 8,
      sizeY: 6,
      sizeZ: 3,
      sizeC: 2,
      sizeT: 1,
      physicalSizeX: 0.5,
      physicalSizeY: 0.25,
      physicalSizeZ: 1,
      physicalUnit: 'µm',
      levelAxes: [
        { name: 'c' },
        { name: 'z' },
        { name: 'y' },
        { name: 'x' },
      ],
      levels: [
        { level: 0, path: '0', scale: [1, 1, 0.25, 0.5] },
        { level: 1, path: '1', scale: [1, 1, 0.5, 1] },
      ],
      levelArrayMetadataByPath: {
        0: { shape: [2, 3, 6, 8], chunks: [1, 1, 3, 4] },
        1: { shape: [2, 3, 3, 4], chunks: [1, 1, 3, 4] },
      },
    },
    pages: [
      { width: 8, height: 6, bitsPerSample: 16, samplesPerPixel: 1, pixels: new Float32Array(48) },
    ],
  });

  assert.deepEqual(dataset.levels, [{
    level: 0,
    path: '0',
    width: 8,
    height: 6,
    tileWidth: 4,
    tileHeight: 3,
    chunkShape: { t: 1, c: 1, z: 1, y: 3, x: 4 },
    downsample: 1,
  }, {
    level: 1,
    path: '1',
    width: 4,
    height: 3,
    tileWidth: 4,
    tileHeight: 3,
    chunkShape: { t: 1, c: 1, z: 1, y: 3, x: 4 },
    downsample: 2,
  }]);
});

test('buildMicroscopyDataset rejects unknown physical units as uncalibrated', () => {
  const dataset = buildMicroscopyDataset({
    fileName: 'bad-unit.ome.zarr',
    metadata: {
      source: 'OME-Zarr',
      physicalSizeX: 1,
      physicalSizeY: 1,
      physicalUnits: { x: 'furlong', y: 'micrometer' },
    },
    pages: [
      { width: 1, height: 1, bitsPerSample: 8, samplesPerPixel: 1, pixels: new Float32Array([1]) },
    ],
  });

  assert.deepEqual(dataset.axes.slice(0, 2).map(axis => [axis.name, axis.unit, axis.scale, axis.known]), [
    ['x', 'mm', 1, false],
    ['y', 'µm', 1, true],
  ]);
  assert.equal(dataset.source.warnings.includes('missing_xy_physical_size'), true);
  assert.equal(dataset.source.warnings.includes('unsupported_x_physical_unit'), true);
  assert.deepEqual(datasetSpacingMm(dataset), {
    rowMm: 0.001,
    colMm: 0,
    zMm: 0,
    zKnown: false,
    unit: 'µm',
  });
});
