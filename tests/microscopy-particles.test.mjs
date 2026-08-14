import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeRectParticlePlane, PARTICLE_PLANE, PARTICLE_GROUND_TRUTH } from './fixtures/microscopy/particle-ground-truth.mjs';

const { analyzeParticles } = await import('../js/microscopy/microscopy-particles.js');
const { applyThreshold } = await import('../js/microscopy/microscopy-threshold.js');

function planeAndMask() {
  const plane = makeRectParticlePlane(PARTICLE_PLANE);
  const mask = applyThreshold(plane, { lo: 1, hi: Infinity }); // any nonzero pixel
  return { plane, mask };
}

test('analyzeParticles counts every disjoint region with exact areas', () => {
  const { plane, mask } = planeAndMask();
  const { objects, summary } = analyzeParticles(mask, plane);
  assert.equal(summary.count, PARTICLE_GROUND_TRUTH.count);
  assert.deepEqual(objects.map((o) => o.area).sort((a, b) => a - b), PARTICLE_GROUND_TRUTH.sortedAreas);
});

test('analyzeParticles measures raw intensity, centroid, and bbox per object', () => {
  const { plane, mask } = planeAndMask();
  const { objects } = analyzeParticles(mask, plane);
  const big = objects.find((o) => o.area === 16);
  const { value, centroid, bbox } = PARTICLE_GROUND_TRUTH.big;
  assert.equal(big.mean, value, 'raw mean equals the painted value (raw domain, not 8-bit)');
  assert.equal(big.min, value);
  assert.equal(big.max, value);
  assert.equal(big.intDen, value * 16);
  assert.deepEqual(big.centroid, centroid);
  assert.deepEqual(big.bbox, bbox);
  assert.ok(big.polygon.length >= 3, 'object polygon is a valid contour');
});

test('analyzeParticles size filter drops the singleton', () => {
  const { plane, mask } = planeAndMask();
  const { summary } = analyzeParticles(mask, plane, { sizeRange: [4, Infinity] });
  assert.equal(summary.count, 3);
});

test('analyzeParticles excludeEdges drops border-touching objects', () => {
  const { plane, mask } = planeAndMask();
  const onlyInterior = analyzeParticles(mask, plane, { excludeEdges: true });
  assert.equal(onlyInterior.count ?? onlyInterior.summary.count, 3, 'the (0,0) edge rect is dropped');
  const both = analyzeParticles(mask, plane, { excludeEdges: true, sizeRange: [4, Infinity] });
  assert.equal(both.summary.count, 2);
});

test('analyzeParticles reports calibrated area when spacing is known, null otherwise', () => {
  const { plane, mask } = planeAndMask();
  const calibrated = analyzeParticles(mask, plane, {}, { rowMm: 0.001, colMm: 0.001, known: true });
  const big = calibrated.objects.find((o) => o.area === 16);
  assert.ok(Math.abs(big.areaMm2 - 16 * 0.001 * 0.001) < 1e-12);
  const uncalibrated = analyzeParticles(mask, plane, {}, { known: false });
  assert.equal(uncalibrated.objects.find((o) => o.area === 16).areaMm2, null, 'uncalibrated areas fail closed to null');
});
