import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const {
  angleEntriesForSlice,
  measurementEntriesForSlice,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');
const { initROI } = await import('../js/roi.js');
const { importRoiResultsBundle, roiResultsImportStatusText } = await import('../js/roi/roi-results.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');

initROI({ state });

test('importRoiResultsBundle imports compatible microscopy rows while rejecting out-of-scope rows', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_partial_import',
      name: 'cells partial import',
      width: 16,
      height: 16,
      slices: 2,
      imageDomain: 'microscopy',
      microscopyDataset: {
        axes: [
          { name: 'z', size: 2 },
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
  setRoiEntriesForSlice('cells_partial_import', 0, []);
  setRoiEntriesForSlice('cells_partial_import', 1, []);
  setMeasurementEntriesForSlice(state, 'cells_partial_import', 0, []);
  setMeasurementEntriesForSlice(state, 'cells_partial_import', 1, []);
  setAngleEntriesForSlice(state, 'cells_partial_import', 0, []);
  setAngleEntriesForSlice(state, 'cells_partial_import', 1, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: {
      slug: 'cells_partial_import', width: 16, height: 16, slices: 2,
      persistenceKey: seriesPersistenceKey(state.manifest.series[0], state.manifest),
    },
    source: { imageDomain: 'microscopy', dataset: { axes: [{ name: 'z', size: 2 }, { name: 'c', size: 2 }, { name: 't', size: 2 }] } },
    rows: [{
      roiObjectId: 'roi:cells_partial_import|1:4',
      sliceIndex: 1,
      kind: 'polygon',
      label: 'Accepted C2 T2',
      points: [[1, 1], [6, 1], [6, 6], [1, 6]],
      channel: 'GFP',
      time: 2,
      pixels: 25,
    }, {
      roiObjectId: 'roi:cells_partial_import|4:9',
      sliceIndex: 4,
      kind: 'point',
      points: [[9, 9]],
      channelIndex: 1,
      timeIndex: 1,
    }, {
      roiObjectId: 'measure:cells_partial_import|0:7',
      sliceIndex: 0,
      kind: 'line',
      points: [[2, 2], [8, 2]],
      channelIndex: 4,
      timeIndex: 0,
      lengthMm: 0.003,
    }, {
      roiObjectId: 'roi:cells_partial_import|1:10',
      sliceIndex: 1,
      kind: 'polygon',
      label: 'Out of frame polygon',
      points: [[1, 1], [99, 1], [1, 4]],
      channelIndex: 1,
      timeIndex: 1,
    }, {
      roiObjectId: 'measure:cells_partial_import|1:11',
      sliceIndex: 1,
      kind: 'line',
      label: 'Out of frame line',
      points: [[2, 2], [-1, 2]],
      channelIndex: 1,
      timeIndex: 1,
      lengthMm: 0.003,
    }, {
      roiObjectId: 'angle:cells_partial_import|1:12',
      sliceIndex: 1,
      kind: 'angle',
      label: 'Out of frame angle',
      points: [[2, 2], [4, 4], [4, 40]],
      channelIndex: 1,
      timeIndex: 1,
      angleDeg: 45,
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: 'partial_incompatible_rows' });
  assert.equal(roiResultsImportStatusText(result), 'Imported 1 result row; skipped incompatible rows');
  assert.equal(roiEntriesForSlice('cells_partial_import', 0).length, 0);
  assert.equal(measurementEntriesForSlice(state, 'cells_partial_import', 0).length, 0);
  assert.equal(measurementEntriesForSlice(state, 'cells_partial_import', 1).length, 0);
  assert.equal(angleEntriesForSlice(state, 'cells_partial_import', 1).length, 0);
  const [entry] = roiEntriesForSlice('cells_partial_import', 1);
  assert.equal(entry.label, 'Accepted C2 T2');
  assert.deepEqual(entry.pts, [[1, 1], [6, 1], [6, 6], [1, 6]]);
  assert.deepEqual(entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 1 });
  assert.equal(entry.importedObjectId, 'roi:cells_partial_import|1:4');
  assert.equal(entry.stats.pixels, 25);
});

test('importRoiResultsBundle accepts edge-coordinate points and rejects beyond-edge rows', () => {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_edge_import',
      name: 'cells edge import',
      width: 16,
      height: 16,
      slices: 1,
      imageDomain: 'microscopy',
    }],
  };
  state.seriesIdx = 0;
  setRoiEntriesForSlice('cells_edge_import', 0, []);

  const result = importRoiResultsBundle({
    schema: 'voxellab.roiResults.v1',
    series: {
      slug: 'cells_edge_import', width: 16, height: 16, slices: 1,
      persistenceKey: seriesPersistenceKey(state.manifest.series[0], state.manifest),
    },
    source: { imageDomain: 'microscopy' },
    rows: [{
      roiObjectId: 'roi:cells_edge_import|0:1',
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Edge polygon',
      points: [[0, 0], [16, 0], [16, 16], [0, 16]],
      pixels: 256,
    }, {
      roiObjectId: 'roi:cells_edge_import|0:2',
      sliceIndex: 0,
      kind: 'point',
      label: 'Beyond edge point',
      points: [[16.001, 8]],
      pixels: 1,
    }],
  }, state);

  assert.deepEqual(result, { ok: true, count: 1, reason: 'partial_incompatible_rows' });
  assert.equal(roiResultsImportStatusText(result), 'Imported 1 result row; skipped incompatible rows');
  const entries = roiEntriesForSlice('cells_edge_import', 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'Edge polygon');
  assert.deepEqual(entries[0].pts, [[0, 0], [16, 0], [16, 16], [0, 16]]);
  assert.equal(entries[0].importedObjectId, 'roi:cells_edge_import|0:1');
});
