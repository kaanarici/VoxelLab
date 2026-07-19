import assert from 'node:assert/strict';
import { test } from 'node:test';

const { pixelwiseColocalization, sampleLineProfile } = await import('../js/microscopy/microscopy-quantification.js');

test('line profile samples finite signed raw values with calibrated distance', () => {
  const plane = {
    width: 3,
    height: 2,
    pixels: new Float32Array([-2, 4, 8, 0, 0, 0]),
  };
  const result = sampleLineProfile(plane, { x1: 0.5, y1: 0.5, x2: 2.5, y2: 0.5 }, {
    sampling: 'nearest', rowMm: 0.25, colMm: 0.5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.distanceUnit, 'mm');
  assert.equal(result.totalDistance, 1);
  assert.deepEqual(result.samples.map(sample => sample.value), [-2, 4, 8]);
});

test('line profile makes bilinear interpolation explicit and fails closed on invalid samples', () => {
  const plane = {
    width: 4,
    height: 3,
    pixels: new Float32Array([
      0, 0, 0, 0,
      0, 10, 20, 0,
      0, 0, 0, 0,
    ]),
  };
  const result = sampleLineProfile(plane, { x1: 1.75, y1: 1.5, x2: 2.75, y2: 1.5 }, { sampling: 'bilinear' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.samples.map(sample => sample.value), [12.5, 15]);
  assert.equal(sampleLineProfile(plane, { x1: -1, y1: 0, x2: 1, y2: 1 }).reason, 'line_out_of_bounds');
  plane.pixels[5] = Number.NaN;
  assert.equal(sampleLineProfile(plane, { x1: 1.75, y1: 1.5, x2: 2.75, y2: 1.5 }).reason, 'nonfinite_raw_value');
});

test('pixelwise colocalization reports Pearson and strict thresholded Manders', () => {
  const a = { width: 4, height: 1, pixels: new Float32Array([1, 2, 3, 4]) };
  const b = { width: 4, height: 1, pixels: new Float32Array([4, 0, 4, 0]) };
  const result = pixelwiseColocalization(a, b, { thresholdA: 1, thresholdB: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.pixels, 4);
  assert.equal(result.tM1, 1 / 3);
  assert.equal(result.tM2, 0.5);
  assert.ok(Number.isFinite(result.pearson));
});

test('pixelwise Pearson remains stable for high-offset inverse uint32 signals', () => {
  const a = { width: 4, height: 1, pixels: new Uint32Array([4294967000, 4294967001, 4294967002, 4294967003]) };
  const b = { width: 4, height: 1, pixels: new Uint32Array([4294967003, 4294967002, 4294967001, 4294967000]) };
  const result = pixelwiseColocalization(a, b, { thresholdA: 0, thresholdB: 0 });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.pearson + 1) < 1e-12, `expected -1, got ${result.pearson}`);
});

test('pixelwise Pearson remains stable for high-offset inverse float signals', () => {
  const a = { width: 4, height: 1, pixels: new Float64Array([1e12, 1e12 + 1, 1e12 + 2, 1e12 + 3]) };
  const b = { width: 4, height: 1, pixels: new Float64Array([1e12 + 3, 1e12 + 2, 1e12 + 1, 1e12]) };
  const result = pixelwiseColocalization(a, b, { thresholdA: 0, thresholdB: 0 });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.pearson + 1) < 1e-12, `expected -1, got ${result.pearson}`);
});

test('pixelwise colocalization fails closed for invalid Manders inputs', () => {
  const variable = { width: 2, height: 1, pixels: new Float32Array([1, 2]) };
  assert.equal(pixelwiseColocalization(variable, { width: 2, height: 1, pixels: new Float32Array([3, 3]) }, { thresholdA: 0, thresholdB: 0 }).reason, 'constant_intensity');
  assert.equal(pixelwiseColocalization(variable, { width: 2, height: 1, pixels: new Float32Array([3, -1]) }, { thresholdA: 0, thresholdB: 0 }).reason, 'negative_raw_value');
  assert.equal(pixelwiseColocalization(variable, { width: 2, height: 1, pixels: new Float32Array([3, 4]) }, { thresholdA: -1, thresholdB: 0 }).reason, 'invalid_threshold');
});
