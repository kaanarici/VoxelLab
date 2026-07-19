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
const {
  measurementEntriesForSlice,
  roiEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');
const { importRoiResultsBundle, roiResultRows, roiResultsBundle } = await import('../js/roi/roi-results.js');
const {
  matchingColocalizationResult,
  matchingLineProfileResult,
  replayAnalysisOp,
  runLineProfile,
  runParticleAnalysis,
  runPixelwiseColocalization,
} = await import('../js/microscopy/microscopy-analysis.js');
const { validateAnalysisOps } = await import('../js/microscopy/microscopy-workflow-recipe.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');

function setup() {
  storage.clear();
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  state.manifest = {
    series: [{
      slug: 'cells_t1', name: 'cells', imageDomain: 'microscopy',
      width: PARTICLE_PLANE.width, height: PARTICLE_PLANE.height,
      microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0, sizeC: 2, sizeT: 1 },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.measurements = {};
  state.angleMeasurements = {};
  state._localMicroscopyPlanes = { cells_t1: {
    '0|0': [{ pixels: plane.pixels, width: plane.width, height: plane.height }],
    '1|0': [{ pixels: Float32Array.from(plane.pixels, value => value * 2 + 1), width: plane.width, height: plane.height }],
  } };
  state._microscopyAnalysisLog = {};
  state._microscopyAnalysisResults = {};
  return state.manifest.series[0];
}

const DIMS = { sizeC: 1, sizeT: 1, sizeZ: 1 };

test('line profiles and colocalization replay without creating ROI rollback entries', () => {
  const series = setup();
  setMeasurementEntriesForSlice(state, series, 0, [{
    id: 9, x1: 1.5, y1: 1.5, x2: 5.5, y2: 1.5,
    mm: 4, unit: 'px', spacingKnown: false,
    microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0 },
  }]);
  const profile = runLineProfile(state, series, { channelIndex: 0, timeIndex: 0, sliceIdx: 0, sampling: 'nearest' });
  assert.equal(profile.ok, true);
  assert.equal(profile.objectIds.length, 0);
  assert.equal(profile.descriptor.measurementDomain, 'raw_16bit');
  const persistenceKey = seriesPersistenceKey(series, state.manifest);
  assert.equal(state._microscopyAnalysisResults[persistenceKey].lineProfile.descriptor.op, 'line-profile');
  assert.equal(matchingLineProfileResult(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, sampling: 'nearest',
  }), state._microscopyAnalysisResults[persistenceKey].lineProfile);
  assert.equal(matchingLineProfileResult(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, sampling: 'bilinear',
  }), null);
  assert.equal(replayAnalysisOp(state, series, profile.descriptor).ok, true);
  assert.equal(state._microscopyAnalysisResults[persistenceKey].lineProfile.descriptor.params.line.measurementId, 9);
  assert.ok(matchingLineProfileResult(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, sampling: 'nearest',
  }));
  const lineBundle = roiResultsBundle(roiResultRows(state, series), series);
  assert.equal(lineBundle.rows.length, 1);
  setMeasurementEntriesForSlice(state, series, 0, []);
  assert.deepEqual(importRoiResultsBundle(lineBundle, state), { ok: true, count: 1, reason: '' });
  const [restoredLine] = measurementEntriesForSlice(state, series, 0);
  assert.notEqual(restoredLine.id, 9);
  assert.equal(restoredLine.importedObjectId, 'measure:cells_t1|0:9');
  assert.equal(replayAnalysisOp(state, series, profile.descriptor).ok, true);
  assert.ok(matchingLineProfileResult(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, sampling: 'nearest',
  }));
  const coloc = runPixelwiseColocalization(state, series, {
    channelA: 0, channelB: 1, timeIndex: 0, sliceIdx: 0, thresholdA: 0, thresholdB: 0,
  });
  assert.equal(coloc.ok, true);
  assert.equal(coloc.objectIds.length, 0);
  assert.equal(coloc.descriptor.measurementDomain, 'raw_16bit');
  assert.ok(matchingColocalizationResult(state, series, {
    channelA: 0, channelB: 1, timeIndex: 0, sliceIdx: 0, thresholdA: 0, thresholdB: 0,
  }));
  assert.equal(matchingColocalizationResult(state, series, {
    channelA: 1, channelB: 0, timeIndex: 0, sliceIdx: 0, thresholdA: 0, thresholdB: 0,
  }), null);
  assert.equal(matchingColocalizationResult(state, series, {
    channelA: 0, channelB: 1, timeIndex: 0, sliceIdx: 0, thresholdA: 1, thresholdB: 0,
  }), null);
  assert.equal(replayAnalysisOp(state, series, coloc.descriptor).ok, true);
  assert.equal(roiEntriesForSlice('cells_t1', 0).length, 0);
  const replacement = { ...series, pixelSpacing: [2, 2] };
  assert.notEqual(seriesPersistenceKey(replacement, state.manifest), persistenceKey);
  assert.equal(matchingColocalizationResult(state, replacement, {
    channelA: 0, channelB: 1, timeIndex: 0, sliceIdx: 0, thresholdA: 0, thresholdB: 0,
  }), null);
  setMeasurementEntriesForSlice(state, series, 0, [{
    id: 9, x1: 1.5, y1: 1.5, x2: 6.5, y2: 1.5,
    microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0 },
  }]);
  assert.equal(matchingLineProfileResult(state, series, { channelIndex: 0, timeIndex: 0, sliceIdx: 0 }), null);
  setMeasurementEntriesForSlice(state, series, 0, [{
    id: 10, x1: 1.5, y1: 1.5, x2: 5.5, y2: 1.5,
    microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0 },
  }]);
  assert.ok(matchingLineProfileResult(state, series, { channelIndex: 0, timeIndex: 0, sliceIdx: 0 }));
});

test('line profile ignores positive placeholder spacing when calibration is untrusted', () => {
  const series = setup();
  series.pixelSpacing = [0.25, 0.5];
  series._spacingKnown = false;
  setMeasurementEntriesForSlice(state, series, 0, [{
    id: 2, x1: 1.5, y1: 1.5, x2: 5.5, y2: 1.5,
    microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0 },
  }]);
  const profile = runLineProfile(state, series, { channelIndex: 0, timeIndex: 0, sliceIdx: 0 });
  assert.equal(profile.ok, true);
  assert.equal(profile.distanceUnit, 'px');
  assert.equal(profile.totalDistance, 4);
  assert.equal(profile.descriptor.calibration.xyKnown, false);
});

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
  const persistenceKey = seriesPersistenceKey(series, state.manifest);
  assert.equal(state._microscopyAnalysisLog[persistenceKey].length, 1);
  assert.equal(state._microscopyAnalysisLog.cells_t1, undefined);
  // Serializable: non-finite values would make this round-trip invalid.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(d)));
});

test('raw 32-bit microscopy analysis retains scalar values and labels its domain honestly', () => {
  const series = setup();
  const pixels = new Uint32Array([4_000_000_000, 4_000_000_001]);
  series.width = 2;
  series.height = 1;
  series.microscopyDataset = { pixel: { type: 'uint32' } };
  state._localMicroscopyPlanes[series.slug]['0|0'] = [{ pixels, width: 2, height: 1 }];
  state._localMicroscopyPlanes[series.slug]['1|0'] = [{
    pixels: new Uint32Array([4_000_000_001, 4_000_000_000]), width: 2, height: 1,
  }];
  setMeasurementEntriesForSlice(state, series, 0, [{
    id: 11, x1: 0.5, y1: 0.5, x2: 1.5, y2: 0.5,
    microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0 },
  }]);

  const profile = runLineProfile(state, series, { channelIndex: 0, timeIndex: 0, sliceIdx: 0 });
  assert.equal(profile.ok, true);
  assert.deepEqual(profile.samples.map(sample => sample.value), [4_000_000_000, 4_000_000_001]);
  assert.equal(profile.descriptor.measurementDomain, 'raw_scalar');

  const coloc = runPixelwiseColocalization(state, series, {
    channelA: 0, channelB: 1, timeIndex: 0, sliceIdx: 0, thresholdA: 0, thresholdB: 0,
  });
  assert.equal(coloc.ok, true);
  assert.equal(coloc.descriptor.measurementDomain, 'raw_scalar');

  const particles = runParticleAnalysis(state, series, {
    channelIndex: 0, timeIndex: 0, sliceIdx: 0, channelName: 'C0',
    threshold: { method: 'manual', value: 0, darkBackground: true },
  });
  assert.equal(particles.ok, true);
  assert.equal(particles.descriptor.measurementDomain, 'raw_scalar');
  assert.equal(roiResultRows(state, series).find(row => row.kind === 'polygon')?.valueSource, 'raw_scalar');
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
  const persistenceKey = seriesPersistenceKey(series, state.manifest);
  assert.equal(state._microscopyAnalysisLog[persistenceKey].length, 1, 'replay does not append to the log');
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
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'line-profile', inputs: { c: 0, z: 0, t: 0 }, params: { sampling: 'bilinear', line: { x1: 1, y1: 1, x2: 5, y2: 1 } } }],
  }, series, DIMS).ok, true);
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'line-profile', inputs: { c: 0, z: 0, t: 0 }, params: { sampling: 'cubic', line: { x1: 1, y1: 1, x2: 5, y2: 1 } } }],
  }, series, DIMS).code, 'invalid_analysis_profile');
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'pixelwise-colocalization', inputs: { cA: 0, cB: 1, z: 0, t: 0 }, params: { thresholdA: 1, thresholdB: 2, roiMask: null } }],
  }, series, { ...DIMS, sizeC: 2 }).ok, true);
  assert.equal(validateAnalysisOps({
    analysisOps: [{ op: 'pixelwise-colocalization', inputs: { cA: 0, cB: 0, z: 0, t: 0 }, params: { thresholdA: 1, thresholdB: 2 } }],
  }, series, { ...DIMS, sizeC: 2 }).code, 'analysis_op_axis_mismatch');
});
