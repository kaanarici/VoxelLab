/* global URL */
// Cross-consistency invariant: threshold → Analyze Particles → ROI rows → descriptor must
// agree end to end. Proves (a) measurements are raw-domain (mean equals the painted pixel
// value, impossible in the 8-bit display domain), (b) row circularity recomputed from the
// stored polygon matches the particle's own contour circularity (full-contour, not bbox),
// and (c) the operation descriptor's output ids exactly match the live table rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeRectParticlePlane, PARTICLE_PLANE } from './fixtures/microscopy/particle-ground-truth.mjs';

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
const { applyParticleResults, runParticleAnalysis } = await import('../js/microscopy/microscopy-analysis.js');
const { analyzeParticles } = await import('../js/microscopy/microscopy-particles.js');
const { computeThreshold, applyThreshold } = await import('../js/microscopy/microscopy-threshold.js');

const DATASET = { axes: [
  { name: 'x', scale: 1, unit: 'µm', known: true },
  { name: 'y', scale: 1, unit: 'µm', known: true },
  { name: 'z', scale: 0, unit: 'µm', known: false },
] };

function setupSeries() {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_t1', name: 'cells', imageDomain: 'microscopy',
      width: PARTICLE_PLANE.width, height: PARTICLE_PLANE.height,
      microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0, sizeC: 1, sizeT: 1 },
      microscopyDataset: DATASET,
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  return state.manifest.series[0];
}

const VALUE_BY_AREA = { 16: 40000, 12: 20000, 9: 30000, 1: 10000 };

test('threshold → particles → rows → descriptor are mutually consistent', () => {
  const series = setupSeries();
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  // Manual cut at 1 includes every painted region (otsu's count is fixture-dependent; this
  // test isolates cross-stage consistency, not the chosen threshold).
  const thr = computeThreshold(plane, { method: 'manual', value: 1, darkBackground: true });
  const mask = applyThreshold(plane, thr);
  const { objects, summary } = analyzeParticles(mask, plane, {}, { rowMm: 0.001, colMm: 0.001, known: true });
  assert.equal(summary.count, 4);

  applyParticleResults(state, series, {
    sliceIdx: 0, channelIndex: 0, channelName: 'C0', timeIndex: 0, objects, createdAt: 1_700_000_000_000,
  });
  const rows = roiResultRows(state);
  assert.equal(rows.length, summary.count, 'every object becomes exactly one row');

  for (const row of rows) {
    const object = objects.find((o) => o.area === row.pixels);
    assert.ok(object, 'row matches an object by area');
    assert.equal(row.valueSource, 'raw_16bit');
    assert.equal(row.mean, VALUE_BY_AREA[row.pixels], 'raw mean equals the painted value (not 8-bit)');
    assert.equal(row.min, VALUE_BY_AREA[row.pixels]);
    assert.equal(row.max, VALUE_BY_AREA[row.pixels]);
    assert.equal(row.rawIntDen, row.mean * row.pixels, 'rawIntDen = mean × pixels');
    // Row circularity is recomputed from the stored polygon; it must match the object's own
    // contour-derived circularity → the stored polygon is the full boundary, not the bbox.
    assert.ok(Math.abs(row.circularity - object.circularity) < 1e-9, 'circularity is contour-consistent');
  }
});

test('the operation descriptor output ids equal the live table rows', () => {
  const series = setupSeries();
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  setRoiEntriesForSlice('cells_t1', 0, []);
  state._localMicroscopyPlanes = { cells_t1: { '0|0': [{ pixels: plane.pixels, width: plane.width, height: plane.height }] } };
  state._microscopyAnalysisLog = {};

  const res = runParticleAnalysis(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, channelName: 'C0',
    threshold: { method: 'manual', value: 1, darkBackground: true },
  });
  assert.equal(res.ok, true);
  const rowIds = new Set(roiResultRows(state).map((r) => r.objectId));
  const descriptorIds = new Set(res.descriptor.outputRoiObjectIds);
  assert.deepEqual([...descriptorIds].sort(), [...rowIds].sort(), 'descriptor ↔ table linkage holds');
  assert.equal(res.summary.count, rowIds.size);
});
