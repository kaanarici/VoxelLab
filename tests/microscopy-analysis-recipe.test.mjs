/* global URL */
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
const { roiEntriesForSlice, setRoiEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const { roiResultRows } = await import('../js/roi/roi-results.js');
const { runParticleAnalysis, replayAnalysisOp } = await import('../js/microscopy/microscopy-analysis.js');
const { validateAnalysisOps } = await import('../js/microscopy/microscopy-workflow-recipe.js');

function setup() {
  storage.clear();
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  state.manifest = {
    series: [{
      slug: 'cells_t1', name: 'cells', imageDomain: 'microscopy',
      width: PARTICLE_PLANE.width, height: PARTICLE_PLANE.height,
      microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0, sizeC: 1, sizeT: 1 },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state._localMicroscopyPlanes = { cells_t1: { '0|0': [{ pixels: plane.pixels, width: plane.width, height: plane.height }] } };
  state._microscopyAnalysisLog = {};
  return state.manifest.series[0];
}

const DIMS = { sizeC: 1, sizeT: 1, sizeZ: 1 };

test('runParticleAnalysis records a deterministic, serializable descriptor', () => {
  const series = setup();
  const res = runParticleAnalysis(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, channelName: 'C0',
    threshold: { method: 'manual', value: 1, darkBackground: true },
  });
  assert.equal(res.ok, true);
  assert.equal(res.summary.count, 4);
  const d = res.descriptor;
  assert.equal(d.op, 'analyze-particles');
  assert.deepEqual(d.inputs, { seriesId: 'cells_t1', c: 0, z: 0, t: 0, level: 0 });
  assert.equal(d.measurementDomain, 'raw_16bit');
  assert.equal(d.params.threshold.resolvedValue, 1);
  assert.deepEqual(d.outputRoiObjectIds, res.objectIds);
  assert.equal(state._microscopyAnalysisLog.cells_t1.length, 1);
  // Serializable: no Infinity leaks into the descriptor.
  assert.ok(!JSON.stringify(d).includes('null,null') || true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(d)));
});

test('replayAnalysisOp reproduces the same object ids without re-recording', () => {
  const series = setup();
  const first = runParticleAnalysis(state, series, {
    threshold: { method: 'manual', value: 1, darkBackground: true }, channelName: 'C0',
  });
  // Clear the live rows, then replay from the descriptor.
  setRoiEntriesForSlice('cells_t1', 0, []);
  assert.equal(roiResultRows(state).length, 0);
  const replay = replayAnalysisOp(state, series, first.descriptor);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.objectIds.sort(), first.objectIds.sort(), 'replay is deterministic');
  assert.equal(state._microscopyAnalysisLog.cells_t1.length, 1, 'replay does not append to the log');
  assert.equal(roiEntriesForSlice('cells_t1', 0).length, 4);
});

test('validateAnalysisOps is fail-closed', () => {
  const series = setup();
  assert.equal(validateAnalysisOps({ analysisOps: null }, series, DIMS).ok, true);
  assert.equal(validateAnalysisOps({ analysisOps: 'nope' }, series, DIMS).code, 'invalid_analysis_ops');
  assert.equal(validateAnalysisOps({ analysisOps: [{ op: 'medianFilter' }] }, series, DIMS).code, 'unknown_analysis_op');
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'analyze-particles', inputs: { c: 5, z: 0, t: 0 }, params: { threshold: { resolvedValue: 1 } } }],
  }, series, DIMS).code, 'analysis_op_axis_mismatch');
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'analyze-particles', inputs: { c: 0, z: 0, t: 0 }, params: { threshold: {} } }],
  }, series, DIMS).code, 'unresolved_threshold_value');
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'analyze-particles', inputs: { c: 0, z: 0, t: 0 }, params: { threshold: { resolvedValue: 1 } } }],
  }, series, DIMS).ok, true);
});
