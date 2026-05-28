import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeOmeZarrMetadata } = await import('../js/microscopy-zarr-metadata.js');

test('normalizeOmeZarrMetadata normalizes valid multiscales metadata with discovered pixel type', () => {
  const normalized = normalizeOmeZarrMetadata({
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          name: 'cells',
          axes: [
            { name: 't', type: 'time', unit: 'millisecond' },
            { name: 'c', type: 'channel' },
            { name: 'z', type: 'space', unit: 'micrometer' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale: [1, 1, 0.5, 0.25, 0.25] }],
          }, {
            path: '1',
            coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 0.5, 0.5] }],
          }],
          coordinateTransformations: [{ type: 'scale', scale: [0.1, 1, 1, 1, 1] }],
        }],
        omero: {
          channels: [{
            label: 'DAPI',
            color: '0000FF',
            family: 'linear',
            window: { min: 0, max: 4095, start: 0, end: 4095 },
          }, {
            label: 'GFP',
            color: '#00FF00',
            family: 'linear',
            window: { min: 5, max: 1024, start: 10, end: 900 },
          }],
        },
      },
    },
  }, {
    arrayMetadataByPath: {
      0: {
        data_type: 'uint16',
        shape: [3, 2, 4, 64, 128],
        dimension_names: ['t', 'c', 'z', 'y', 'x'],
      },
    },
  });

  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.axes.map((axis) => [axis.name, axis.type, axis.size, axis.scale, axis.known]), [
    ['t', 'time', 3, 0.1, true],
    ['c', 'channel', 2, 1, true],
    ['z', 'space', 4, 0.5, true],
    ['y', 'space', 64, 0.25, true],
    ['x', 'space', 128, 0.25, true],
  ]);
  assert.equal(normalized.pixel.type, 'uint16');
  assert.deepEqual(normalized.channels.map((channel) => [channel.name, channel.color, channel.dataRange, channel.displayRange]), [
    ['DAPI', '#0000FF', [0, 4095], [0, 4095]],
    ['GFP', '#00FF00', [5, 1024], [10, 900]],
  ]);
  assert.equal(normalized.levels[0].path, '0');
  assert.equal(normalized.levels[1].path, '1');
  assert.equal(normalized.warnings.includes('omero_transitional_metadata'), true);
});

test('normalizeOmeZarrMetadata accepts NGFF 0.4 version on the multiscales entry', () => {
  const normalized = normalizeOmeZarrMetadata({
    multiscales: [{
      version: '0.4',
      axes: [
        { name: 'c', type: 'channel' },
        { name: 'z', type: 'space', unit: 'micrometer' },
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'x', type: 'space', unit: 'micrometer' },
      ],
      datasets: [{
        path: '0',
        coordinateTransformations: [{ type: 'scale', scale: [1, 0.5, 0.25, 0.25] }],
      }],
    }],
  }, {
    arrayMetadataByPath: {
      0: { dtype: '<u2', shape: [2, 3, 4, 5] },
    },
  });

  assert.equal(normalized.multiscales.version, '0.4');
  assert.equal(normalized.warnings.includes('ome_version_missing'), false);
  assert.deepEqual(normalized.axes.map((axis) => [axis.name, axis.size, axis.scale]), [
    ['c', 2, 1],
    ['z', 3, 0.5],
    ['y', 4, 0.25],
    ['x', 5, 0.25],
  ]);
});

test('normalizeOmeZarrMetadata keeps incomplete OMERO windows visible but marks them invalid', () => {
  const normalized = normalizeOmeZarrMetadata({
    ome: {
      version: '0.5',
      multiscales: [{
        axes: [
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'scale', scale: [0.5, 0.5] }],
        }],
      }],
      omero: {
        channels: [{
          label: 'incomplete',
          color: 'FFFFFF',
          family: 'linear',
          window: { min: 0, max: 255 },
        }],
      },
    },
  });

  assert.equal(normalized.errors.includes('omero_channel_0_window_startend_invalid'), true);
  assert.deepEqual(normalized.channels[0].dataRange, [0, 255]);
  assert.deepEqual(normalized.channels[0].displayRange, [0, 255]);
});

test('normalizeOmeZarrMetadata flags invalid axes and dataset transforms', () => {
  const normalized = normalizeOmeZarrMetadata({
    ome: {
      version: '0.5',
      multiscales: [{
        axes: [
          { name: 'x', type: 'space' },
          { name: 'x', type: 'space' },
        ],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'translation', translation: [0, 0] }],
        }],
      }],
    },
  });

  assert.equal(normalized.errors.includes('axes_duplicate_name_x'), true);
  assert.equal(normalized.errors.includes('dataset_0_translation_before_scale'), true);
  assert.equal(normalized.errors.includes('dataset_0_scale_count_invalid'), true);
});

test('normalizeOmeZarrMetadata validates OMERO channel requirements and unresolved pixel type', () => {
  const normalized = normalizeOmeZarrMetadata({
    ome: {
      multiscales: [{
        axes: ['y', 'x'],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'scale', scale: [1, 1] }],
        }],
      }],
      omero: {
        channels: [{
          label: 'DNA',
          color: 'ZZZZZZ',
        }],
      },
    },
  });

  assert.equal(normalized.errors.includes('omero_channel_0_color_invalid'), true);
  assert.equal(normalized.errors.includes('omero_channel_0_window_missing'), true);
  assert.equal(normalized.warnings.includes('ome_version_missing'), true);
  assert.equal(normalized.warnings.includes('pixel_type_unresolved'), true);
});
