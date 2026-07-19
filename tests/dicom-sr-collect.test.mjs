import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(String(key), String(value)); },
  removeItem(key) { store.delete(String(key)); },
  clear() { store.clear(); },
};

const { collectMeasurements } = await import('../js/dicom/dicom-sr-collect.js');
const { setMeasurementEntriesForSlice, setRoiEntriesForSlice } = await import('../js/overlay/annotation-graph.js');

test('collectMeasurements keeps uncalibrated line lengths in pixel units', () => {
  store.clear();
  const host = {
    seriesIdx: 0,
    manifest: { series: [{ slug: 'uncalibrated', pixelSpacing: [0, 0] }] },
    measurements: {},
  };
  setMeasurementEntriesForSlice(host, host.manifest.series[0], 0, [
    { x1: 0, y1: 0, x2: 3, y2: 4, mm: 5, unit: 'px' },
  ]);

  const bundle = collectMeasurements(host);

  assert.equal(bundle.measurements[0].length_mm, undefined);
  assert.equal(bundle.measurements[0].length_px, 5);
});

test('collectMeasurements exports open PolyLine length and stable source identity', () => {
  store.clear();
  const host = {
    seriesIdx: 0,
    manifest: { series: [{ slug: 'cells', sourceSeriesUID: '1.2.3.4', pixelSpacing: [0.002, 0.001] }] },
    rois: {},
  };
  setRoiEntriesForSlice(host, host.manifest.series[0], 2, [{
    id: 4,
    shape: 'polyline',
    pts: [[0, 0], [4, 0], [4, 3]],
    stats: { length_px: 7, length_mm: 0.01 },
  }]);

  const bundle = collectMeasurements(host);

  assert.equal(bundle.sourceSeriesUID, '1.2.3.4');
  assert.deepEqual(bundle.measurements, [{
    kind: 'length',
    slice: 2,
    handles: [[0, 0], [4, 0], [4, 3]],
    length_mm: 0.01,
  }]);
});
