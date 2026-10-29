import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installRoiResultsHost } from './helpers/node/roi-results-host.mjs';

const { state, storage, importBundleForActiveSeries: importRoiResultsBundle } = await installRoiResultsHost();
const {
  roiResultsBundle,
  roiResultsBundleIncompatibleRowCount,
  roiResultsCsv,
  roiResultRows,
  setRoiResultLabel,
} = await import('../js/roi/roi-results.js');
const {
  angleEntriesForSlice,
  measurementEntriesForSlice,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');

test('importRoiResultsBundle restores ROI geometry into the matching active series', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_roundtrip',
      name: 'cells roundtrip',
      width: 16,
      height: 16,
      slices: 2,
      imageDomain: 'microscopy',
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_roundtrip', 1, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_roundtrip', name: 'cells roundtrip', width: 16, height: 16, slices: 2 },
    rows: [{
      roiObjectId: 'roi:cells_roundtrip|1:5',
      sliceIndex: 1,
      kind: 'polygon',
      label: 'Nucleus boundary',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      channel: 'GFP',
      channelIndex: 1,
      timeIndex: 2,
      pixels: 42,
      count: null,
      areaMm2: 0.000021,
      mean: 34.5,
      std: 1.5,
      min: 12,
      max: 90,
      createdAt: '2026-05-28T12:00:00.000Z',
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [entry] = roiEntriesForSlice('cells_roundtrip', 1);
  assert.equal(entry["shape"], 'polygon');
  assert.equal(entry.label, 'Nucleus boundary');
  assert.deepEqual(entry.pts, [[1, 1], [8, 1], [8, 7], [1, 7]]);
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });
  assert.equal(entry.stats.pixels, 42);
  assert.equal(entry.stats.count, null);
  assert.equal(entry.stats.area_mm2, null);
  assert.equal(entry.importedObjectId, 'roi:cells_roundtrip|1:5');

  const [row] = roiResultRows(state);
  assert.equal(row.objectId, 'roi:cells_roundtrip|1:5');
  assert.equal(row.id, 'roi:cells_roundtrip|1:1');
  assert.equal(row.localEntryId, 'roi:cells_roundtrip|1:1');
  assert.equal(row.areaMm2, null);
  assert.equal(roiResultsBundle([row], state.manifest.series[0]).rows[0].roiObjectId, 'roi:cells_roundtrip|1:5');

  const duplicate = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_roundtrip', name: 'cells roundtrip', width: 16, height: 16, slices: 2 },
    rows: [{ roiObjectId: 'roi:cells_roundtrip|1:5', sliceIndex: 1, kind: 'polygon', points: [[1, 1], [2, 2]] }],
  }, state);
  assert.deepEqual(duplicate, { ok: false, count: 0, reason: 'no_importable_rois' });
  assert.equal(roiEntriesForSlice('cells_roundtrip', 1).length, 1);
});

test('importRoiResultsBundle preserves explicit integrated density sidecar stats', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_density_roundtrip',
      name: 'cells density roundtrip',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0.00025, 0.0005],
      microscopy: { physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_density_roundtrip', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_density_roundtrip', name: 'cells density roundtrip', width: 16, height: 16, slices: 1 },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:cells_density_roundtrip|0:8',
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Sparse density',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      rawIntDen: 1234,
      intDen: 56.75,
      intDenMm2: 0.00005675,
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [row] = roiResultRows(state);
  assert.equal(row.rawIntDen, 1234);
  assert.equal(row.intDen, 56.75);
  assert.equal(row.intDenMm2, 0.00005675);

  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  assert.equal(bundle.rows[0].rawIntDen, 1234);
  assert.equal(bundle.rows[0].intDen, 56.75);
  assert.equal(bundle.rows[0].intDenMm2, 0.00005675);

  const [headers, cells] = roiResultsCsv([row], state.manifest.series[0]).trim().split('\n').map(line => line.split(','));
  assert.equal(cells[headers.indexOf('raw_int_den')], '1234');
  assert.equal(cells[headers.indexOf('int_den')], '56.75');
  assert.equal(cells[headers.indexOf('int_den_mm2')], '0.00005675');
});

test('importRoiResultsBundle restores multi-point count ROI geometry', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_count_roundtrip',
      name: 'cells count roundtrip',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_count_roundtrip', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_count_roundtrip', name: 'cells count roundtrip', width: 16, height: 16, slices: 1 },
    rows: [{
      roiObjectId: 'roi:cells_count_roundtrip|0:9',
      sliceIndex: 0,
      kind: 'point',
      label: 'Cell count',
      points: [[2, 3], [8, 9], [12, 4]],
      channel: 'GFP',
      channelIndex: 1,
      timeIndex: 2,
      count: 3,
      pixels: 3,
      mean: 44,
      std: 4,
      min: 31,
      max: 52,
      createdAt: '2026-05-28T12:00:00.000Z',
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [entry] = roiEntriesForSlice('cells_count_roundtrip', 0);
  assert.equal(entry["shape"], 'point');
  assert.equal(entry.label, 'Cell count');
  assert.deepEqual(entry.pts, [[2, 3], [8, 9], [12, 4]]);
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });
  assert.equal(entry.stats.count, 3);
  assert.equal(entry.stats.pixels, 3);
  assert.equal(entry.stats.min, 31);
  assert.equal(entry.importedObjectId, 'roi:cells_count_roundtrip|0:9');

  const [row] = roiResultRows(state);
  assert.equal(row.objectId, 'roi:cells_count_roundtrip|0:9');
  assert.equal(row.id, 'roi:cells_count_roundtrip|0:1');
  assert.equal(row.localEntryId, 'roi:cells_count_roundtrip|0:1');
  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  assert.equal(bundle.rows[0].roiObjectId, 'roi:cells_count_roundtrip|0:9');
  assert.deepEqual(bundle.rows[0].points, [[2, 3], [8, 9], [12, 4]]);

  assert.equal(setRoiResultLabel(row, 'Imported count', state), true);
  const [renamed] = roiResultRows(state);
  assert.equal(renamed.label, 'Imported count');
  assert.equal(renamed.objectId, 'roi:cells_count_roundtrip|0:9');
});

test('importRoiResultsBundle restores line measurement geometry into the matching active series', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_line_roundtrip',
      name: 'cells line roundtrip',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0.00025, 0.0005],
      _spacingKnown: true,
      microscopy: { physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setMeasurementEntriesForSlice(state, 'cells_line_roundtrip', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_line_roundtrip', name: 'cells line roundtrip', width: 16, height: 16, slices: 1 },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'measure:cells_line_roundtrip|0:4',
      sliceIndex: 0,
      kind: 'line',
      label: 'Axon length',
      points: [[2, 4], [10, 4]],
      channel: 'GFP',
      channelIndex: 1,
      timeIndex: 2,
      lengthMm: 0.004,
      lengthPx: null,
      createdAt: '2026-05-28T12:00:00.000Z',
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [entry] = measurementEntriesForSlice(state, 'cells_line_roundtrip', 0);
  assert.equal(entry.x1, 2);
  assert.equal(entry.label, 'Axon length');
  assert.equal(entry.y1, 4);
  assert.equal(entry.x2, 10);
  assert.equal(entry.y2, 4);
  assert.equal(entry.mm, 0.004);
  assert.equal(entry.unit, 'mm');
  assert.equal(entry.spacingKnown, true);
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });
  assert.equal(entry.importedObjectId, 'measure:cells_line_roundtrip|0:4');

  const [row] = roiResultRows(state);
  assert.equal(row.objectId, 'measure:cells_line_roundtrip|0:4');
  assert.equal(row.id, 'measure:cells_line_roundtrip|0:1');
  assert.equal(row.localEntryId, 'measure:cells_line_roundtrip|0:1');
  assert.equal(roiResultsBundle([row], state.manifest.series[0]).rows[0].roiObjectId, 'measure:cells_line_roundtrip|0:4');

  const duplicate = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_line_roundtrip', name: 'cells line roundtrip', width: 16, height: 16, slices: 1 },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{ roiObjectId: 'measure:cells_line_roundtrip|0:4', sliceIndex: 0, kind: 'line', points: [[1, 1], [2, 2]], lengthMm: 0.001 }],
  }, state);
  assert.deepEqual(duplicate, { ok: false, count: 0, reason: 'no_importable_rois' });
  assert.equal(measurementEntriesForSlice(state, 'cells_line_roundtrip', 0).length, 1);
});

test('importRoiResultsBundle restores angle measurement geometry into the matching active series', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_angle_roundtrip',
      name: 'cells angle roundtrip',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setAngleEntriesForSlice(state, 'cells_angle_roundtrip', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_angle_roundtrip', name: 'cells angle roundtrip', width: 16, height: 16, slices: 1 },
    rows: [{
      roiObjectId: 'angle:cells_angle_roundtrip|0:4',
      sliceIndex: 0,
      kind: 'angle',
      label: 'Branch angle',
      points: [[6, 4], [2, 4], [6, 8]],
      channel: 'GFP',
      channelIndex: 1,
      timeIndex: 2,
      angleDeg: 26.565051177,
      createdAt: '2026-05-28T12:00:00.000Z',
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [entry] = angleEntriesForSlice(state, 'cells_angle_roundtrip', 0);
  assert.equal(entry.label, 'Branch angle');
  assert.equal(entry.deg, 26.565051177);
  assert.deepEqual([entry.p1, entry.vertex, entry.p3], [
    { x: 6, y: 4 },
    { x: 2, y: 4 },
    { x: 6, y: 8 },
  ]);
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });
  assert.equal(entry.importedObjectId, 'angle:cells_angle_roundtrip|0:4');

  const [row] = roiResultRows(state);
  assert.equal(row.objectId, 'angle:cells_angle_roundtrip|0:4');
  assert.equal(roiResultsBundle([row], state.manifest.series[0]).rows[0].roiObjectId, 'angle:cells_angle_roundtrip|0:4');

  const duplicate = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_angle_roundtrip', name: 'cells angle roundtrip', width: 16, height: 16, slices: 1 },
    rows: [{ roiObjectId: 'angle:cells_angle_roundtrip|0:4', sliceIndex: 0, kind: 'angle', points: [[1, 1], [2, 2], [3, 1]], angleDeg: 45 }],
  }, state);
  assert.deepEqual(duplicate, { ok: false, count: 0, reason: 'no_importable_rois' });
  assert.equal(angleEntriesForSlice(state, 'cells_angle_roundtrip', 0).length, 1);
});

test('importRoiResultsBundle preserves epoch timestamps across imported row kinds', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'epoch_roundtrip',
      name: 'epoch roundtrip',
      width: 16,
      height: 16,
      slices: 1,
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('epoch_roundtrip', 0, []);
  setMeasurementEntriesForSlice(state, 'epoch_roundtrip', 0, []);
  setAngleEntriesForSlice(state, 'epoch_roundtrip', 0, []);

  const createdAt = '1970-01-01T00:00:00.000Z';
  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'epoch_roundtrip', name: 'epoch roundtrip', width: 16, height: 16, slices: 1 },
    rows: [
      {
        roiObjectId: 'roi:epoch_roundtrip|0:1',
        sliceIndex: 0,
        kind: 'polygon',
        label: 'epoch roi',
        points: [[1, 1], [4, 1], [4, 4]],
        createdAt,
      },
      {
        roiObjectId: 'measure:epoch_roundtrip|0:2',
        sliceIndex: 0,
        kind: 'line',
        label: 'epoch line',
        points: [[1, 2], [5, 2]],
        lengthPx: 4,
        createdAt,
      },
      {
        roiObjectId: 'angle:epoch_roundtrip|0:3',
        sliceIndex: 0,
        kind: 'angle',
        label: 'epoch angle',
        points: [[1, 1], [2, 2], [3, 1]],
        angleDeg: 45,
        createdAt,
      },
    ],
  }, state);

  assert.deepEqual(result, { ok: true, count: 3, reason: '' });
  assert.equal(roiEntriesForSlice('epoch_roundtrip', 0)[0].createdAt, 0);
  assert.equal(measurementEntriesForSlice(state, 'epoch_roundtrip', 0)[0].createdAt, 0);
  assert.equal(angleEntriesForSlice(state, 'epoch_roundtrip', 0)[0].createdAt, 0);
});

test('importRoiResultsBundle rejects sidecars for a different active series', () => {
  storage.clear();
  state.manifest = {
    series: [{ slug: 'active_cells', name: 'active cells', width: 16, height: 16, slices: 1 }],
  };
  state.seriesIdx = 0;

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'other_cells', name: 'other cells', width: 32, height: 16, slices: 1 },
    rows: [{ sliceIndex: 0, kind: 'ellipse', points: [[1, 1], [4, 4]] }],
  }, state);

  assert.deepEqual(result, { ok: false, count: 0, reason: 'series_mismatch' });
});

test('importRoiResultsBundle rejects microscopy bundles with incompatible C/Z/T axes', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_axes_live',
      name: 'cells axes live',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      microscopyDataset: {
        axes: [
          { name: 'z', size: 1 },
          { name: 'c', size: 2 },
          { name: 't', size: 1 },
        ],
      },
    }],
  };
  state.seriesIdx = 0;

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_axes_live', width: 16, height: 16, slices: 1 },
    source: {
      imageDomain: 'microscopy',
      dataset: {
        axes: [
          { name: 'z', size: 1 },
          { name: 'c', size: 3 },
          { name: 't', size: 1 },
        ],
      },
    },
    rows: [{ sliceIndex: 0, kind: 'ellipse', points: [[1, 1], [4, 4]] }],
  }, state);

  assert.deepEqual(result, { ok: false, count: 0, reason: 'bundle_axis_mismatch' });
});

test('importRoiResultsBundle rejects calibrated microscopy bundles when active XY calibration is missing', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_uncalibrated_live',
      name: 'cells uncalibrated live',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0, 0],
      _spacingKnown: false,
    }],
  };
  state.seriesIdx = 0;
  setRoiEntriesForSlice('cells_uncalibrated_live', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_uncalibrated_live', name: 'cells uncalibrated live', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy' },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:cells_uncalibrated_live|0:5',
      sliceIndex: 0,
      kind: 'polygon',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      areaMm2: 0.000021,
    }],
  }, state);

  assert.deepEqual(result, { ok: false, count: 0, reason: 'bundle_calibration_mismatch' });
  assert.equal(roiEntriesForSlice('cells_uncalibrated_live', 0).length, 0);
});

test('importRoiResultsBundle rejects calibrated microscopy bundles when active XY calibration differs', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_mismatched_calibration',
      name: 'cells mismatched calibration',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0.001, 0.001],
      _spacingKnown: true,
    }],
  };
  state.seriesIdx = 0;
  setRoiEntriesForSlice('cells_mismatched_calibration', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_mismatched_calibration', name: 'cells mismatched calibration', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy' },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:cells_mismatched_calibration|0:5',
      sliceIndex: 0,
      kind: 'polygon',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      areaMm2: 0.000021,
    }],
  }, state);

  assert.deepEqual(result, { ok: false, count: 0, reason: 'bundle_calibration_mismatch' });
  assert.equal(roiEntriesForSlice('cells_mismatched_calibration', 0).length, 0);
});

test('importRoiResultsBundle accepts calibrated microscopy bundles when active XY calibration matches', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_matching_calibration',
      name: 'cells matching calibration',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0.00025, 0.0005],
      _spacingKnown: true,
      microscopy: { physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  setRoiEntriesForSlice('cells_matching_calibration', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_matching_calibration', name: 'cells matching calibration', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy' },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:cells_matching_calibration|0:5',
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Matched calibration',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      areaMm2: 0.000021,
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: '' });
  const [entry] = roiEntriesForSlice('cells_matching_calibration', 0);
  assert.equal(entry.label, 'Matched calibration');
  assert.equal(entry.stats.area_mm2, 0.000021);
});

test('importRoiResultsBundle strips unproven calibrated metrics from uncalibrated microscopy sidecars', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_untrusted_metrics',
      name: 'cells untrusted metrics',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0, 0],
      _spacingKnown: false,
    }],
  };
  state.seriesIdx = 0;
  setRoiEntriesForSlice('cells_untrusted_metrics', 0, []);
  setMeasurementEntriesForSlice(state, 'cells_untrusted_metrics', 0, []);

  const bundle = {
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_untrusted_metrics', name: 'cells untrusted metrics', width: 16, height: 16, slices: 1 },
    calibration: { xyKnown: false, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:cells_untrusted_metrics|0:5',
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Imported geometry only',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      pixels: 42,
      mean: 34.5,
      rawIntDen: 1449,
      intDen: 999,
      intDenMm2: 0.000999,
      areaMm2: 0.000021,
      perimeterMm: 0.025,
    }, {
      roiObjectId: 'measure:cells_untrusted_metrics|0:4',
      sliceIndex: 0,
      kind: 'line',
      label: 'Untrusted calibrated length',
      points: [[2, 4], [10, 4]],
      lengthMm: 0.004,
    }],
  };

  assert.equal(roiResultsBundleIncompatibleRowCount(bundle, state.manifest.series[0]), 1);
  const result = importRoiResultsBundle(bundle, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: 'partial_incompatible_rows' });
  assert.equal(measurementEntriesForSlice(state, 'cells_untrusted_metrics', 0).length, 0);
  const [entry] = roiEntriesForSlice('cells_untrusted_metrics', 0);
  assert.equal(entry.label, 'Imported geometry only');
  assert.equal(entry.stats.area_mm2, null);
  assert.equal(entry.stats.perimeter_mm, null);
  assert.equal(entry.stats.int_den, null);
  assert.equal(entry.stats.int_den_mm2, null);
  assert.equal(entry.stats.raw_int_den, 1449);

  const [row] = roiResultRows(state);
  assert.equal(row.areaMm2, null);
  assert.equal(row.intDen, null);
  assert.equal(row.intDenMm2, null);
  assert.equal(row.rawIntDen, 1449);
  assert.equal(roiResultsCsv([row], state.manifest.series[0]).split('\n')[1].includes('0.000021'), false);
});

test('importRoiResultsBundle maps display-style Z/C/T provenance into microscopy rows', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_display_fields',
      name: 'cells display fields',
      width: 16,
      height: 16,
      slices: 3,
      imageDomain: 'microscopy',
      microscopyDataset: {
        axes: [
          { name: 'z', size: 3 },
          { name: 'c', size: 2 },
          { name: 't', size: 2 },
        ],
        channels: [
          { index: 0, name: 'DAPI' },
          { index: 1, name: 'GFP' },
        ],
      },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_display_fields', 1, []);
  setRoiEntriesForSlice('cells_display_fields', 2, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_display_fields', width: 16, height: 16, slices: 3 },
    source: { imageDomain: 'microscopy', dataset: { axes: [{ name: 'z', size: 3 }, { name: 'c', size: 2 }, { name: 't', size: 2 }] } },
    rows: [{
      roiObjectId: 'roi:cells_display_fields|1:8',
      slice: 2,
      kind: 'polygon',
      label: 'Display-only provenance',
      points: [[1, 1], [5, 1], [5, 5], [1, 5]],
      channel: 'GFP',
      time: 2,
      pixels: 16,
    }, {
      roiObjectId: 'roi:cells_display_fields|2:9',
      slice: 3,
      kind: 'point',
      label: 'Display-number channel',
      points: [[8, 9]],
      channel: 2,
      time: 1,
      count: 1,
      pixels: 1,
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 2, reason: '' });
  const [entry] = roiEntriesForSlice('cells_display_fields', 1);
  assert.equal(entry.label, 'Display-only provenance');
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 1 });
  assert.equal(entry.importedObjectId, 'roi:cells_display_fields|1:8');
  const [numericChannelEntry] = roiEntriesForSlice('cells_display_fields', 2);
  assert.equal(numericChannelEntry.label, 'Display-number channel');
  assert.deepEqual(numericChannelEntry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 0 });

  const rows = roiResultRows(state);
  assert.deepEqual(rows.map(row => [row.slice, row.kind, row.channelName, row.channelIndex, row.timeIndex]), [
    [2, 'polygon', 'GFP', 2, 2],
    [3, 'point', 'GFP', 2, 1],
  ]);
});

test('importRoiResultsBundle refuses microscopy rows with out-of-range channel/time provenance', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_incompatible_rows',
      name: 'cells incompatible rows',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      microscopyDataset: {
        axes: [
          { name: 'z', size: 1 },
          { name: 'c', size: 2 },
          { name: 't', size: 2 },
        ],
      },
    }],
  };
  state.seriesIdx = 0;

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'cells_incompatible_rows', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy', dataset: { axes: [{ name: 'c', size: 2 }, { name: 't', size: 2 }] } },
    rows: [{
      roiObjectId: 'roi:cells_incompatible_rows|0:3',
      sliceIndex: 0,
      kind: 'polygon',
      points: [[1, 1], [5, 1], [5, 5], [1, 5]],
      channelIndex: 4,
      timeIndex: 0,
    }],
  }, state);

  assert.deepEqual(result, { ok: false, count: 0, reason: 'incompatible_bundle_rows' });
});
