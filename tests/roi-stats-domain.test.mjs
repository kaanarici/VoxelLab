/* global URL */
// Regression pin + D1b proof for the ROI measurement domain at the export layer.
// Non-microscopy / unmarked rows stay 8-bit display domain (pinned); rows carrying a
// raw_16bit valueSource export as raw intensity with derived integrated-density columns.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { setRoiEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const { roiResultRows } = await import('../js/roi/roi-results.js');

function microscopySeries() {
  state.manifest = {
    series: [{
      slug: 'cells_t1',
      name: 'cells',
      imageDomain: 'microscopy',
      pixelSpacing: [0.001, 0.001],
      microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
}

test('regression: ROI rows without an explicit domain stay 8-bit display intensity', () => {
  storage.clear();
  microscopySeries();
  setRoiEntriesForSlice('cells_t1', 0, [{
    id: 1,
    shape: 'ellipse',
    pts: [[1, 1], [9, 7]],
    stats: { pixels: 100, area_mm2: 100 * 0.001 * 0.001, mean: 42, std: 3, min: 10, max: 90 },
    createdAt: 1_700_000_000_000,
  }]);
  const [row] = roiResultRows(state);
  assert.equal(row.valueSource, 'display_8bit');
  assert.equal(row.valueUnit, '8-bit');
  assert.equal(row.mean, 42);
  assert.equal(row.rawIntDen, 42 * 100);
});

test('D1b: rows carrying raw_16bit export raw intensity with derived IntDen', () => {
  storage.clear();
  microscopySeries();
  setRoiEntriesForSlice('cells_t1', 0, [{
    id: 2,
    shape: 'ellipse',
    pts: [[1, 1], [9, 7]],
    // Constant raw plane region — mean far above the 8-bit ceiling proves the raw domain.
    stats: {
      pixels: 100,
      area_mm2: 100 * 0.001 * 0.001,
      mean: 40000, std: 0, min: 40000, max: 40000,
      valueSource: 'raw_16bit', valueUnit: 'raw',
    },
    createdAt: 1_700_000_000_000,
  }]);
  const [row] = roiResultRows(state);
  assert.equal(row.valueSource, 'raw_16bit');
  assert.equal(row.valueUnit, 'raw');
  assert.equal(row.mean, 40000);
  assert.equal(row.min, 40000);
  assert.equal(row.max, 40000);
  assert.equal(row.rawIntDen, 40000 * 100, 'raw integrated density derives from mean × pixels');
  assert.ok(Number.isFinite(row.intDen) && row.intDen > 0, 'calibrated IntDen populated for raw rows');
});

test('32-bit scalar microscopy rows retain the generic raw scalar contract', () => {
  storage.clear();
  microscopySeries();
  setRoiEntriesForSlice('cells_t1', 0, [{
    id: 3,
    shape: 'ellipse',
    pts: [[1, 1], [9, 7]],
    stats: {
      pixels: 2,
      area_mm2: 2 * 0.001 * 0.001,
      mean: 4_000_000_000.5, std: 0.5, min: 4_000_000_000, max: 4_000_000_001,
      valueSource: 'raw_scalar', valueUnit: 'raw',
    },
    createdAt: 1_700_000_000_000,
  }]);
  const [row] = roiResultRows(state);
  assert.equal(row.valueSource, 'raw_scalar');
  assert.equal(row.rawIntDen, 8_000_000_001);
  assert.ok(Number.isFinite(row.intDen) && row.intDen > 0);
});
