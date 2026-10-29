import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CALIBRATED_OME_TIFF } from './fixtures/microscopy/calibrated-ome-tiff.mjs';
import { installRoiResultsHost } from './helpers/node/roi-results-host.mjs';

const {
  state,
  storage,
  importBundleForActiveSeries: importRoiResultsBundle,
  seriesPersistenceKey,
} = await installRoiResultsHost();

const {
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');
const { clearROIMode, countROIs, initROI, onROIDown, toggleROI } = await import('../js/roi.js');
const {
  activateRoiResultRow,
  roiResultRows,
  roiResultsBundle,
  roiResultsCsv,
  roiResultsImportFailureText,
  setRoiResultLabel,
} = await import('../js/roi/roi-results.js');
const { isolatedHostWrites } = await import('../js/runtime/isolated-host.js');

test('roiResultsImportFailureText gives user-facing mismatch reasons', () => {
  assert.equal(roiResultsImportFailureText('no_importable_rois'), 'ROI bundle had no importable geometry');
  assert.equal(roiResultsImportFailureText('incompatible_bundle_rows'), 'ROI bundle rows are incompatible with this microscopy stack');
  assert.equal(roiResultsImportFailureText('bundle_axis_mismatch'), 'ROI bundle C/Z/T dimensions do not match this microscopy stack');
  assert.equal(roiResultsImportFailureText('bundle_calibration_mismatch'), 'ROI bundle calibration does not match this microscopy stack');
  assert.equal(roiResultsImportFailureText('legacy_identity_unconfirmed'), 'Legacy ROI bundles are quarantined because they lack a series identity');
  assert.equal(roiResultsImportFailureText('series_identity_mismatch'), 'ROI bundle belongs to a different study or series');
  assert.equal(roiResultsImportFailureText('unknown_reason'), 'ROI bundle did not match this series');
});

test('roiResultRows exposes calibrated microscopy ROI rows across slices', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_gfp_t1',
      name: 'cells · GFP',
      imageDomain: 'microscopy',
      pixelSpacing: CALIBRATED_OME_TIFF.pixelSpacingMm,
      microscopy: {
        channelIndex: 1,
        channelName: 'GFP',
        timeIndex: 0,
        physicalUnit: 'µm',
      },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 2;
  setRoiEntriesForSlice('cells_gfp_t1', 2, [{
    id: 7,
    "shape": 'ellipse',
    pts: [[1, 1], [9, 7]],
    stats: {
      pixels: 100,
      area_mm2: 100 * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1],
      mean: 42.25,
      std: 3.5,
      min: 10,
      max: 90,
    },
    createdAt: 1_700_000_000_000,
  }]);

  const rows = roiResultRows(state);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].slice, 3);
  assert.equal(rows[0].kind, 'ellipse');
  assert.equal(rows[0].label, 'ROI 7');
  assert.equal(rows[0].objectId, 'roi:cells_gfp_t1|2:7');
  assert.deepEqual(rows[0].points, [[1, 1], [9, 7]]);
  assert.equal(rows[0].channelName, 'GFP');
  assert.equal(rows[0].channelIndex, 2);
  assert.equal(rows[0].timeIndex, 1);
  assert.equal(rows[0].areaDisplay, '12.5 µm²');
  assert.equal(rows[0].areaUnit2, 100 * CALIBRATED_OME_TIFF.pixelAreaUm2);
  assert.equal(rows[0].xUnitValue, 2.5);
  assert.equal(rows[0].yUnitValue, 1);
  assert.equal(rows[0].xMm, 0.0025);
  assert.equal(rows[0].yMm, 0.001);
  assert.ok(rows[0].perimeterUnitValue > 0);
  assert.equal(rows[0].perimeterDisplay.endsWith('µm'), true);
  assert.ok(rows[0].circularity > 0);
  assert.ok(rows[0].circularity <= 1);
  assert.equal(rows[0].intDen, 528.125);
  assert.ok(Math.abs(rows[0].intDenMm2 - 0.000528125) < 1e-15);
  assert.equal(rows[0].rawIntDen, 4225);
  assert.equal(rows[0].valueSource, 'display_8bit');
});

test('open PolyLine results preserve length and geometry through bundle round-trip', () => {
  storage.clear();
  state.manifest = {
    patient: 'anonymous',
    series: [{
      slug: 'cells_polyline',
      name: 'cells PolyLine',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
      pixelSpacing: [0.002, 0.001],
      _spacingKnown: true,
      microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0, physicalUnit: 'mm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_polyline', 0, [{
    id: 3,
    "shape": 'polyline',
    label: 'Axon path',
    pts: [[2, 4], [6, 4], [6, 7]],
    stats: { length_px: 7, length_mm: 0.01 },
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
  }]);

  const [row] = roiResultRows(state);
  assert.equal(row.kind, 'polyline');
  assert.equal(row.lengthPx, 7);
  assert.equal(row.lengthMm, 0.01);
  assert.equal(row.areaMm2, null);
  assert.equal(row.perimeterMm, null);
  assert.equal(row.valueSource, 'linear_measurement');
  assert.equal(row.valueUnit, '');

  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  setRoiEntriesForSlice('cells_polyline', 0, []);
  assert.deepEqual(importRoiResultsBundle(bundle, state), { ok: true, count: 1, reason: '' });
  const [restored] = roiEntriesForSlice('cells_polyline', 0);
  assert.equal(restored["shape"], 'polyline');
  assert.deepEqual(restored.pts, [[2, 4], [6, 4], [6, 7]]);
  assert.equal(restored.stats.length_mm, 0.01);
  assert.equal(restored.stats.length_px, 7);
});

test('roiResultRows uses ROI channel/time provenance when microscopy stacks share one series', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_hyper',
      name: 'cells',
      imageDomain: 'microscopy',
      microscopy: {
        channelIndex: 0,
        channelName: 'DAPI',
        timeIndex: 0,
        physicalUnit: 'µm',
      },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cells_hyper', 0, [{
    id: 1,
    "shape": 'ellipse',
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2 },
    stats: { pixels: 8, area_mm2: 0.000008, mean: 55 },
  }]);

  const [row] = roiResultRows(state);

  assert.equal(row.channelIndex, 2);
  assert.equal(row.channelName, 'GFP');
  assert.equal(row.timeIndex, 3);
});

test('roiResultsCsv includes Fiji-style result columns and escapes values', () => {
  const series = {
    slug: 'quoted_series',
    imageDomain: 'microscopy',
    microscopy: { physicalUnit: 'µm' },
  };
  const csv = roiResultsCsv([{
    index: 9,
    objectId: 'roi:quoted_series|3:9',
    seriesName: '\t=cells, GFP',
    seriesSlug: 'quoted_series',
    slice: 4,
    sliceIdx: 3,
    kind: 'polygon',
    label: '=nucleus, GFP',
    channelName: 'DAPI "blue"',
    channelZeroIndex: 0,
    timeIndex: 2,
    timeZeroIndex: 1,
    areaUnit2: 12.5,
    areaMm2: 0.0000125,
    pixels: 50,
    mean: 20,
    std: 2,
    min: 1,
    max: 40,
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
    createdAt: 1_700_000_000_000,
  }], series);

  assert.match(csv, /^roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2\n/);
  assert.match(csv, /9,roi:quoted_series\|3:9,"'\t=cells, GFP",quoted_series,4,3,polygon,"'=nucleus, GFP",,,,,,,,"DAPI ""blue""",0,2,1,12.5,0.0000125,50,20,2,1,40,8-bit,display_8bit,2023-11-14T22:13:20.000Z,,,,,,,µm,,Unknown · XY spacing missing,1000,,,,,,,,,250,0.00025\n$/);
});

test('setRoiResultLabel updates ROI and line labels used by exports', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'editable_labels',
      name: 'editable labels',
      imageDomain: 'microscopy',
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 0, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('editable_labels', 0, [{
    id: 1,
    "shape": 'ellipse',
    pts: [[1, 1], [5, 5]],
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 0 },
    stats: { pixels: 8, mean: 44 },
  }]);
  setMeasurementEntriesForSlice(state, 'editable_labels', 0, [{
    id: 2,
    x1: 2,
    y1: 3,
    x2: 8,
    y2: 3,
    mm: 0.003,
    unit: 'mm',
    spacingKnown: true,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 0 },
  }]);

  let rows = roiResultRows(state);
  assert.equal(setRoiResultLabel(rows.find(row => row.kind === 'ellipse'), 'Nucleus A', state), true);
  assert.equal(setRoiResultLabel(rows.find(row => row.kind === 'line'), 'Axon width', state), true);

  rows = roiResultRows(state);
  assert.deepEqual(rows.map(row => [row.kind, row.label]), [
    ['line', 'Axon width'],
    ['ellipse', 'Nucleus A'],
  ]);
  assert.match(roiResultsCsv(rows, state.manifest.series[0]), /line,Axon width,/);
  assert.match(roiResultsCsv(rows, state.manifest.series[0]), /ellipse,Nucleus A,/);
  assert.equal(roiResultsBundle(rows, state.manifest.series[0]).rows.find(row => row.kind === 'ellipse').label, 'Nucleus A');
});

test('roiResultsCsv keeps non-microscopy area headers unique', () => {
  const csv = roiResultsCsv([{
    index: 3,
    objectId: 'roi:t1|0:3',
    seriesName: 'T1',
    seriesSlug: 't1',
    slice: 1,
    kind: 'ellipse',
    areaUnit2: 3,
    areaMm2: 3,
    pixels: 12,
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
  }], { slug: 't1' });

  assert.match(csv, /^roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_display_mm,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_display_mm2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_display_mm,perimeter_mm,perimeter_px,circularity,x_display_mm,y_display_mm,x_mm,y_mm,int_den,int_den_mm2\n/);
  assert.doesNotMatch(csv, /'$/);
});

test('roiResultRows exports calibrated line measurements with C/T provenance and length fields', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cell_lengths',
      name: 'cell lengths',
      imageDomain: 'microscopy',
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setMeasurementEntriesForSlice(state, 'cell_lengths', 0, [{
    id: 6,
    x1: 2,
    y1: 4,
    x2: 10,
    y2: 4,
    mm: 0.004,
    unit: 'mm',
    spacingKnown: true,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2 },
    createdAt: 1_700_000_000_000,
  }]);

  const [row] = roiResultRows(state);

  assert.equal(row.kind, 'line');
  assert.equal(row.label, 'Line 6');
  assert.equal(row.objectId, 'measure:cell_lengths|0:6');
  assert.deepEqual(row.points, [[2, 4], [10, 4]]);
  assert.equal(row.xPx, 6);
  assert.equal(row.yPx, 4);
  assert.equal(row.lengthMm, 0.004);
  assert.equal(row.lengthPx, null);
  assert.equal(row.lengthUnit, 'µm');
  assert.equal(row.lengthUnitValue, 4);
  assert.equal(row.lengthDisplay, '4.00 µm');
  assert.equal(row.channelName, 'GFP');
  assert.equal(row.channelIndex, 2);
  assert.equal(row.timeIndex, 3);
  assert.equal(row.valueSource, 'linear_measurement');

  const csv = roiResultsCsv([row], state.manifest.series[0]);
  assert.match(csv, /6,measure:cell_lengths\|0:6,cell lengths,cell_lengths,1,0,line,Line 6,6,4,,4,0.004,,,GFP,1,3,2,,,,,,,,,linear_measurement,2023-11-14T22:13:20.000Z,,,,,,,µm,,Unknown · XY spacing missing,,,,,,,,,,,\n$/);

  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  assert.equal(bundle.rows[0].label, 'Line 6');
  assert.deepEqual(bundle.rows[0].points, [[2, 4], [10, 4]]);
  assert.equal(bundle.rows[0].lengthDisplay, '4.00 µm');
  assert.equal(bundle.rows[0].lengthUnit, 'µm');
  assert.equal(bundle.rows[0].lengthUnitValue, 4);
  assert.equal(bundle.rows[0].lengthMm, 0.004);
  assert.equal(bundle.rows[0].lengthPx, null);
});

test('roiResultRows exports angle measurements with C/T provenance and angle fields', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cell_angles',
      name: 'cell angles',
      imageDomain: 'microscopy',
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setAngleEntriesForSlice(state, 'cell_angles', 0, [{
    id: 7,
    p1: { x: 6, y: 4 },
    vertex: { x: 2, y: 4 },
    p3: { x: 6, y: 8 },
    deg: 26.565051177,
    label: 'Branch angle',
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2 },
    createdAt: 1_700_000_000_000,
  }]);

  const [row] = roiResultRows(state);

  assert.equal(row.kind, 'angle');
  assert.equal(row.label, 'Branch angle');
  assert.equal(row.objectId, 'angle:cell_angles|0:7');
  assert.deepEqual(row.points, [[6, 4], [2, 4], [6, 8]]);
  assert.equal(row.angleDeg, 26.565051177);
  assert.equal(row.channelName, 'GFP');
  assert.equal(row.channelIndex, 2);
  assert.equal(row.timeIndex, 3);
  assert.equal(row.valueSource, 'angular_measurement');

  const csv = roiResultsCsv([row], state.manifest.series[0]);
  assert.match(csv, /7,angle:cell_angles\|0:7,cell angles,cell_angles,1,0,angle,Branch angle,4.666666666666667,5.333333333333333,,,,,26.565051177,GFP,1,3,2,,,,,,,,,angular_measurement,2023-11-14T22:13:20.000Z,,,,,,,µm,,Unknown · XY spacing missing,,,,,,,,,,,\n$/);

  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  assert.equal(bundle.rows[0].roiObjectId, 'angle:cell_angles|0:7');
  assert.equal(bundle.rows[0].angleDeg, 26.565051177);
  assert.deepEqual(bundle.rows[0].points, [[6, 4], [2, 4], [6, 8]]);
});

test('roiResultRows exports C/T-scoped point count ROIs with pixel coordinates', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cell_counts',
      name: 'cell counts',
      imageDomain: 'microscopy',
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 3, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice('cell_counts', 0, [{
    id: 4,
    "shape": 'point',
    pts: [[6, 9]],
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 3 },
    stats: { pixels: 1, count: 1, mean: 77, std: 0, min: 77, max: 77 },
    createdAt: 1_700_000_000_000,
  }]);

  const [row] = roiResultRows(state);
  assert.equal(countROIs(), 1);
  assert.equal(row.kind, 'point');
  assert.equal(row.label, 'ROI 4');
  assert.equal(row.count, 1);
  assert.equal(row.pixels, 1);
  assert.equal(row.xPx, 6);
  assert.equal(row.yPx, 9);
  assert.equal(row.channelName, 'GFP');
  assert.equal(row.timeIndex, 4);

  const csv = roiResultsCsv([row], state.manifest.series[0]);
  assert.match(csv, /4,roi:cell_counts\|0:4,cell counts,cell_counts,1,0,point,ROI 4,6,9,1,,,,,GFP,1,4,3,,,1,77,0,77,77,8-bit,display_8bit,2023-11-14T22:13:20.000Z,,,,,,,µm,,Unknown · XY spacing missing,77,,,,,,,,,,\n$/);

  const bundle = roiResultsBundle([row], state.manifest.series[0]);
  assert.deepEqual(bundle.rows[0].points, [[6, 9]]);
  assert.equal(bundle.rows[0].label, 'ROI 4');
  assert.equal(bundle.rows[0].count, 1);
  assert.equal(bundle.rows[0].xPx, 6);
  assert.equal(bundle.rows[0].yPx, 9);
});

test('point ROI mode accumulates repeated clicks into one C/T-scoped count row', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'click_counts',
      name: 'click counts',
      width: 10,
      height: 10,
      imageDomain: 'microscopy',
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  clearROIMode();
  const rgba = new Uint8Array(10 * 10 * 4);
  for (let i = 0; i < 100; i += 1) rgba[i * 4] = i;
  initROI({ state, getRawSliceData: () => rgba, onROIChange() {} });

  toggleROI('point');
  onROIDown(2, 3);
  onROIDown(7, 8);

  const entries = roiEntriesForSlice('click_counts', 0);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].pts, [[2, 3], [7, 8]]);
  assert.equal(entries[0].stats.count, 2);
  assert.equal(entries[0].stats.pixels, 2);
  assert.equal(entries[0].stats.min, 32);
  assert.equal(entries[0].stats.max, 87);
  assert.deepEqual(entries[0].microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });

  const [row] = roiResultRows(state);
  assert.equal(row.kind, 'point');
  assert.equal(row.count, 2);
  assert.equal(row.pixels, 2);
  assert.deepEqual(row.points, [[2, 3], [7, 8]]);
  assert.equal(row.xPx, 4.5);
  assert.equal(row.yPx, 5.5);
  assert.equal(roiResultsBundle([row], state.manifest.series[0]).rows[0].points.length, 2);
});

test('roiResultsBundle preserves calibration and microscopy provenance', () => {
  const series = {
    slug: 'cells_bundle',
    name: 'cells bundle',
    width: 16,
    height: 16,
    slices: 3,
    imageDomain: 'microscopy',
    sequence: 'OME-TIFF',
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.0015,
    microscopy: {
      physicalUnit: 'µm',
      sourceFiles: ['cells.ome.tiff'],
      sequenceWarnings: ['example_warning'],
    },
    microscopyDataset: {
      source: {
        originalFormat: 'OME-TIFF',
        warnings: ['missing_xy_physical_size', 'unsupported_x_physical_unit'],
      },
      axes: [
        { name: 'x', type: 'space', size: 16, unit: 'µm', scale: 0.5, known: true },
        { name: 'y', type: 'space', size: 16, unit: 'µm', scale: 0.25, known: true },
        { name: 'z', type: 'space', size: 3, unit: 'µm', scale: 1.5, known: true },
        { name: 'c', type: 'channel', size: 2 },
        { name: 't', type: 'time', size: 2, unit: 'index', scale: 1, known: false },
      ],
      channels: [
        { index: 0, name: 'DAPI', color: '#0000FF', displayColor: '', displayColorSource: '', lut: 'blue', emissionWavelength: 460, emissionWavelengthUnit: 'nm', displayRange: [0, 255], displayRangeSource: 'pixel-stats' },
        { index: 1, name: 'GFP', color: '#00FF00', displayColor: '#AA00CC', displayColorSource: 'user', lut: 'green', emissionWavelength: 510, emissionWavelengthUnit: 'nm', displayRange: [10, 200], displayRangeSource: 'metadata' },
      ],
      pixel: { type: 'uint8', samplesPerPixel: 1, endianness: 'little', min: 0, max: 255 },
      levels: [{ level: 0, width: 16, height: 16, tileWidth: 16, tileHeight: 16, "chunkShape": { t: 1, c: 1, z: 1, y: 16, x: 16 }, downsample: 1 }],
      planes: [
        { c: 0, z: 0, t: 0, level: 0, pageIndex: 0, width: 16, height: 16 },
        { c: 1, z: 2, t: 1, level: 0, pageIndex: 11, width: 16, height: 16 },
      ],
    },
  };
  const bundle = roiResultsBundle([{
    index: 1,
    objectId: 'roi:cells_bundle|0:1',
    slice: 1,
    sliceIdx: 0,
    kind: 'ellipse',
    label: 'Nucleus 1',
    points: [[2, 3], [8, 11]],
    channelName: 'GFP',
    channelZeroIndex: 1,
    timeIndex: 2,
    timeZeroIndex: 1,
    areaDisplay: '12.5 µm²',
    areaUnit: 'µm²',
    areaUnit2: 12.5,
    areaMm2: 0.0000125,
    pixels: 50,
    mean: 20,
    rawIntDen: 1000,
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
    createdAt: 1_700_000_000_000,
  }], series);

  assert.equal(bundle.schema, 'voxellab.roiResults.v1');
  assert.deepEqual(bundle.series, {
    slug: 'cells_bundle',
    name: 'cells bundle',
    persistenceKey: seriesPersistenceKey(series, state.manifest),
    width: 16,
    height: 16,
    slices: 3,
  });
  assert.deepEqual(bundle.calibration, {
    xyKnown: true,
    rowMm: 0.00025,
    colMm: 0.0005,
    zKnown: true,
    zMm: 0.0015,
    displayUnit: 'µm',
    source: 'metadata',
    trust: 'Trusted metadata',
  });
  assert.deepEqual(bundle.source, {
    imageDomain: 'microscopy',
    format: 'OME-TIFF',
    sourceFiles: ['cells.ome.tiff'],
    dataset: {
      axes: [
        { name: 'x', type: 'space', size: 16, unit: 'µm', scale: 0.5, known: true },
        { name: 'y', type: 'space', size: 16, unit: 'µm', scale: 0.25, known: true },
        { name: 'z', type: 'space', size: 3, unit: 'µm', scale: 1.5, known: true },
        { name: 'c', type: 'channel', size: 2, unit: '', scale: 0, known: false },
        { name: 't', type: 'time', size: 2, unit: 'index', scale: 1, known: false },
      ],
      channels: [
        { index: 0, name: 'DAPI', color: '#0000FF', displayColor: '', displayColorSource: '', lut: 'blue', emissionWavelength: 460, emissionWavelengthUnit: 'nm', displayRange: [0, 255], displayRangeSource: 'pixel-stats' },
        { index: 1, name: 'GFP', color: '#00FF00', displayColor: '#AA00CC', displayColorSource: 'user', lut: 'green', emissionWavelength: 510, emissionWavelengthUnit: 'nm', displayRange: [10, 200], displayRangeSource: 'metadata' },
      ],
      pixel: { type: 'uint8', samplesPerPixel: 1, endianness: 'little', min: 0, max: 255 },
      levels: [{ level: 0, path: '', width: 16, height: 16, tileWidth: 16, tileHeight: 16, "chunkShape": { t: 1, c: 1, z: 1, y: 16, x: 16 }, downsample: 1 }],
      planes: [
        { c: 0, z: 0, t: 0, level: 0, pageIndex: 0, width: 16, height: 16 },
        { c: 1, z: 2, t: 1, level: 0, pageIndex: 11, width: 16, height: 16 },
      ],
    },
    warnings: ['missing_xy_physical_size', 'unsupported_x_physical_unit', 'example_warning'],
  });
  assert.equal(bundle.rows[0].roiObjectId, 'roi:cells_bundle|0:1');
  assert.deepEqual(bundle.source.warnings, ['missing_xy_physical_size', 'unsupported_x_physical_unit', 'example_warning']);
  assert.equal(bundle.rows[0].label, 'Nucleus 1');
  assert.deepEqual(bundle.rows[0].points, [[2, 3], [8, 11]]);
  assert.equal(bundle.rows[0].channel, 'GFP');
  assert.equal(bundle.rows[0].channelIndex, 1);
  assert.equal(bundle.rows[0].time, 2);
  assert.equal(bundle.rows[0].timeIndex, 1);
  assert.equal(bundle.rows[0].areaDisplay, '12.5 µm²');
  assert.equal(bundle.rows[0].rawIntDen, 1000);

  const csv = roiResultsCsv([{
    index: 1,
    objectId: 'roi:cells_bundle|0:1',
    seriesName: 'cells bundle',
    seriesSlug: 'cells_bundle',
    slice: 1,
    sliceIdx: 0,
    kind: 'ellipse',
    label: 'Nucleus 1',
    valueUnit: '8-bit',
    valueSource: 'display_8bit',
  }], series);
  const [header, line] = csv.trim().split('\n').map(row => row.split(','));
  assert.deepEqual(header.slice(-20), ['source_format', 'source_files', 'source_warnings', 'xy_spacing_row_mm', 'xy_spacing_col_mm', 'z_spacing_mm', 'calibration_unit', 'calibration_source', 'spacing_trust', 'raw_int_den', 'perimeter_um', 'perimeter_mm', 'perimeter_px', 'circularity', 'x_um', 'y_um', 'x_mm', 'y_mm', 'int_den', 'int_den_mm2']);
  assert.deepEqual(line.slice(-20), ['OME-TIFF', 'cells.ome.tiff', 'XY spacing missing;Unsupported X unit;Example warning', '0.00025', '0.0005', '0.0015', 'µm', 'metadata', 'Trusted metadata', '', '', '', '', '', '', '', '', '', '', '']);
});

test('roiResults exports preserve manual calibration provenance', () => {
  const series = {
    slug: 'manual_cells',
    name: 'manual cells',
    imageDomain: 'microscopy',
    sequence: 'TIFF sequence',
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.002,
    sliceThickness: 0.002,
    _spacingKnown: true,
    _sliceSpacingKnown: true,
    microscopy: {
      calibrationSource: 'manual',
      physicalUnit: 'µm',
      sourceFiles: ['manual_z001.tif', 'manual_z002.tif'],
    },
    microscopyDataset: {
      source: { originalFormat: 'TIFF sequence', warnings: [] },
      axes: [
        { name: 'x', scale: 0.5, unit: 'µm', known: true },
        { name: 'y', scale: 0.25, unit: 'µm', known: true },
        { name: 'z', scale: 2, unit: 'µm', known: true },
      ],
    },
  };

  const row = {
    index: 1,
    objectId: 'roi:manual_cells|0:1',
    seriesName: 'manual cells',
    seriesSlug: 'manual_cells',
    slice: 1,
    sliceIdx: 0,
    kind: 'ellipse',
    label: 'Manual ROI',
  };
  const bundle = roiResultsBundle([row], series);
  const [headers, cells] = roiResultsCsv([row], series).trim().split('\n').map(line => line.split(','));

  assert.equal(bundle.calibration.source, 'manual');
  assert.equal(bundle.calibration.trust, 'Manual calibration');
  assert.equal(cells[headers.indexOf('calibration_source')], 'manual');
  assert.equal(cells[headers.indexOf('spacing_trust')], 'Manual calibration');
});

test('roiResults treats sequence-only TIFF sequence calibration as manual provenance', () => {
  const bundle = roiResultsBundle([], {
    slug: 'sequence_only',
    imageDomain: 'microscopy',
    sequence: 'TIFF sequence',
    pixelSpacing: [0.00025, 0.0005],
    _spacingKnown: true,
    microscopy: { physicalUnit: 'µm' },
  });

  assert.equal(bundle.calibration.source, 'manual');
  assert.equal(bundle.calibration.trust, 'Manual calibration');
});

test('roiResultRows uses stable slice-local ROI ids for visible labels', () => {
  storage.clear();
  state.manifest = {
    series: [{ slug: 'multi_slice', name: 'multi', pixelSpacing: [1, 1] }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 5;
  setRoiEntriesForSlice('multi_slice', 0, [{ id: 1, "shape": 'ellipse', stats: { pixels: 1 } }]);
  setRoiEntriesForSlice('multi_slice', 5, [{ id: 1, "shape": 'polygon', stats: { pixels: 2 } }]);

  const rows = roiResultRows(state);

  assert.deepEqual(rows.map(row => [row.slice, row.index]), [[1, 1], [6, 1]]);
});

test('activateRoiResultRow writes isolated slice index only through isolatedHostWrites', async () => {
  const host = {
    imgs: ['a', 'b', 'c'],
    sliceIdx: 0,
    seriesIdx: 0,
    manifest: { series: [{ slug: 'iso_roi_slice' }] },
  };

  assert.equal(await activateRoiResultRow({ sliceIdx: 2 }, host), false);
  assert.equal(host.sliceIdx, 0);

  assert.equal(await activateRoiResultRow({ sliceIdx: 2 }, host, { writes: isolatedHostWrites() }), true);
  assert.equal(host.sliceIdx, 2);
});

test('activateRoiResultRow does not rebuild a microscopy stack already on that plane', async () => {
  const series = {
    slug: 'iso_roi_plane',
    imageDomain: 'microscopy',
    microscopy: { channelIndex: 0, timeIndex: 0, volumeEligible: false },
  };
  const host = {
    imgs: ['plane'],
    sliceIdx: 0,
    seriesIdx: 0,
    manifest: { series: [series] },
    _localMicroscopyStacks: { iso_roi_plane: { '0|0': ['plane'] } },
  };
  let patched = 0;
  const writes = isolatedHostWrites();
  const patchSeries = writes.patchSeries;
  writes.patchSeries = (...args) => {
    patched += 1;
    return patchSeries(...args);
  };

  assert.equal(await activateRoiResultRow({
    sliceIdx: 0,
    channelZeroIndex: 0,
    timeZeroIndex: 0,
  }, host, { writes }), true);
  assert.equal(patched, 0);
  assert.equal(host.sliceIdx, 0);
});
