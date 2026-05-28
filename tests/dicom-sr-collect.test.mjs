import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(String(key), String(value)); },
  removeItem(key) { store.delete(String(key)); },
  clear() { store.clear(); },
};

const { collectMeasurements } = await import('../js/dicom-sr-collect.js');

test('collectMeasurements keeps uncalibrated line lengths in pixel units', () => {
  store.clear();
  const host = {
    seriesIdx: 0,
    manifest: { series: [{ slug: 'uncalibrated', pixelSpacing: [0, 0] }] },
    measurements: {
      'uncalibrated|0': [{ x1: 0, y1: 0, x2: 3, y2: 4, mm: 5, unit: 'px' }],
    },
  };

  const bundle = collectMeasurements(host);

  assert.equal(bundle.measurements[0].length_mm, undefined);
  assert.equal(bundle.measurements[0].length_px, 5);
});
