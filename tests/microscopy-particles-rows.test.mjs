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
const { roiResultRows } = await import('../js/roi/roi-results.js');
const { applyParticleResults } = await import('../js/microscopy/microscopy-analysis.js');
const { analyzeParticles } = await import('../js/microscopy/microscopy-particles.js');
const { applyThreshold } = await import('../js/microscopy/microscopy-threshold.js');

function setup(spacing) {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'cells_t1',
      name: 'cells',
      imageDomain: 'microscopy',
      width: PARTICLE_PLANE.width,
      height: PARTICLE_PLANE.height,
      pixelSpacing: spacing,
      microscopy: { channelIndex: 0, channelName: 'C0', timeIndex: 0, physicalUnit: 'µm' },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  const mask = applyThreshold(plane, { lo: 1, hi: Infinity });
  return { plane, mask, series: state.manifest.series[0] };
}

test('particle objects become raw-domain polygon ROI rows', () => {
  const { plane, mask, series } = setup([0.001, 0.001]);
  const { objects } = analyzeParticles(mask, plane, {}, { rowMm: 0.001, colMm: 0.001, known: true });
  const ids = applyParticleResults(state, series, {
    sliceIdx: 0, channelIndex: 0, channelName: 'C0', timeIndex: 0, objects, createdAt: 1_700_000_000_000,
  });
  assert.equal(ids.length, 4);

  const rows = roiResultRows(state);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.kind, 'polygon');
    assert.equal(row.valueSource, 'raw_16bit');
    assert.equal(row.valueUnit, 'raw');
    assert.ok(String(row.objectId).startsWith('particles:'), 'stable particle object id');
  }
  const big = rows.find((r) => r.pixels === 16);
  assert.equal(big.mean, 40000, 'raw mean equals the painted value');
  assert.equal(big.rawIntDen, 40000 * 16);
  assert.ok(Math.abs(big.areaMm2 - 16 * 0.001 * 0.001) < 1e-12, 'calibrated area');
  assert.ok(Number.isFinite(big.intDen) && big.intDen > 0, 'calibrated IntDen derived for raw rows');
  assert.ok(Number.isFinite(big.circularity) && big.circularity > 0 && big.circularity <= 1);
});
