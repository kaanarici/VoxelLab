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
const {
  angleEntriesForSlice,
  annotatedSlicesForSeries,
  clearDrawingEntriesForSlice,
  drawingCountsForSlice,
  drawingEntriesForSeries,
  measurementEntriesForSlice,
  noteEntriesForSlice,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setNoteEntriesForSlice,
  setRoiEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');

test('annotation graph aggregates all drawing kinds for one series', () => {
  storage.clear();
  state.manifest = { patient: 'patient-a', studyUID: 'study-a', series: [{ slug: 'graph_case' }] };
  state.seriesIdx = 0;
  state.measurements = {};
  state.angleMeasurements = {};
  setMeasurementEntriesForSlice(state, state.manifest.series[0], 1, [{ x1: 1, y1: 2, x2: 3, y2: 4, mm: 10 }]);
  setAngleEntriesForSlice(state, state.manifest.series[0], 1, [{ deg: 42, p1: { x: 1, y: 1 }, vertex: { x: 2, y: 2 }, p3: { x: 3, y: 3 } }]);
  setRoiEntriesForSlice('graph_case', 1, [{ id: 9, shape: 'ellipse', pts: [[1, 1], [4, 4]], stats: { area_mm2: 12 } }]);
  setNoteEntriesForSlice('graph_case', 2, [{ id: 3, x: 7, y: 8, text: 'note' }]);

  const entries = drawingEntriesForSeries(state, state.manifest.series[0]);

  assert.deepEqual(entries.map((entry) => entry.kind), ['line', 'angle', 'ellipse', 'note']);
  assert.deepEqual([...annotatedSlicesForSeries(state, state.manifest.series[0])], [2]);
});

test('annotation graph reads storage-backed rulers and angles even with empty host buckets', () => {
  storage.clear();
  state.measurements = {};
  state.angleMeasurements = {};
  setMeasurementEntriesForSlice(state, 'persist_case', 1, [{ id: 4, x1: 1, y1: 2, x2: 4, y2: 6, mm: 5 }]);
  setAngleEntriesForSlice(state, 'persist_case', 2, [{ id: 8, deg: 90, p1: { x: 1, y: 0 }, vertex: { x: 0, y: 0 }, p3: { x: 0, y: 1 } }]);
  state.measurements = {};
  state.angleMeasurements = {};

  assert.equal(measurementEntriesForSlice(state, 'persist_case', 1)[0].id, 4);
  assert.equal(angleEntriesForSlice(state, 'persist_case', 2)[0].id, 8);
  assert.deepEqual(
    drawingEntriesForSeries(state, 'persist_case').map((entry) => entry.kind),
    ['line', 'angle'],
  );
});

test('annotation graph clears one slice across every drawing bucket', () => {
  storage.clear();
  state.manifest = { patient: 'patient-a', studyUID: 'study-a', series: [{ slug: 'clear_case' }] };
  state.seriesIdx = 0;
  state.measurements = {};
  state.angleMeasurements = {};
  setMeasurementEntriesForSlice(state, state.manifest.series[0], 4, [{ mm: 11 }]);
  setAngleEntriesForSlice(state, state.manifest.series[0], 4, [{ deg: 33 }]);
  setRoiEntriesForSlice('clear_case', 4, [{ id: 1, shape: 'polygon', pts: [[0, 0], [1, 0], [0, 1]], stats: {} }]);
  setNoteEntriesForSlice('clear_case', 4, [{ id: 2, x: 1, y: 2, text: 'note' }]);

  assert.deepEqual(drawingCountsForSlice(state, state.manifest.series[0], 4), {
    measurements: 1,
    angles: 1,
    rois: 1,
    notes: 1,
    total: 4,
  });

  clearDrawingEntriesForSlice(state, state.manifest.series[0], 4);

  assert.deepEqual(drawingCountsForSlice(state, state.manifest.series[0], 4), {
    measurements: 0,
    angles: 0,
    rois: 0,
    notes: 0,
    total: 0,
  });
});

test('annotation graph scopes v2 drawings by study identity when slugs repeat', () => {
  storage.clear();
  const first = { slug: 't1', width: 128, height: 128, slices: 40, seriesUID: 'series-a' };
  const second = { slug: 't1', width: 128, height: 128, slices: 40, seriesUID: 'series-b' };
  const firstHost = { manifest: { patient: 'patient-a', studyUID: 'study-a', series: [first] }, seriesIdx: 0, measurements: {}, angleMeasurements: {} };
  const secondHost = { manifest: { patient: 'patient-b', studyUID: 'study-b', series: [second] }, seriesIdx: 0, measurements: {}, angleMeasurements: {} };

  setNoteEntriesForSlice(firstHost, first, 3, [{ id: 1, x: 2, y: 4, text: 'first study' }]);
  setRoiEntriesForSlice(firstHost, first, 3, [{ id: 2, shape: 'point', pts: [[2, 4]] }]);

  assert.equal(noteEntriesForSlice(secondHost, second, 3).length, 0);
  assert.equal(roiEntriesForSlice(secondHost, second, 3).length, 0);
  assert.equal(drawingEntriesForSeries(secondHost, second).length, 0);
});

test('annotation graph quarantines v1 slug buckets instead of attributing them', () => {
  storage.clear();
  const series = { slug: 't1', seriesUID: 'series-a' };
  const host = { manifest: { patient: 'patient-a', studyUID: 'study-a', series: [series] }, seriesIdx: 0, measurements: {}, angleMeasurements: {} };
  storage.set('mri-viewer/annotations/v1', JSON.stringify({ 't1|3': [{ id: 1, text: 'legacy' }] }));
  storage.set('mri-viewer/rois/v1', JSON.stringify({ 't1|3': [{ id: 1, shape: 'point', pts: [[1, 1]] }] }));

  assert.equal(noteEntriesForSlice(host, series, 3).length, 0);
  assert.equal(roiEntriesForSlice(host, series, 3).length, 0);
});
