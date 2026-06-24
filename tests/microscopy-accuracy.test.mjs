// Golden accuracy references for the analysis engine.
// EXACT (closed-form, ImageJ-definition) measurements are verified directly here: area =
// pixel count, centroid = unweighted pixel-coordinate mean, raw intensity = raw pixel mean.
// PERIMETER/CIRCULARITY use ImageJ's traced-perimeter algorithm (PolygonRoi.getTracedPerimeter):
// perimeter = Σ|dx|·pw + Σ|dy|·ph − nCorners·((pw+ph)/2)·(2−√2); circularity = 4π·area/perim²
// capped at 1.0. Values below are the deterministic output of that algorithm for known shapes;
// numeric parity against a live ImageJ instance is a Tier-2 (PyImageJ) cross-validation task.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { analyzeParticles } = await import('../js/microscopy/microscopy-particles.js');

function rectMask(W, H, x0, y0, w, h, value = 1000) {
  const mask = new Uint8Array(W * H);
  const pixels = new Float32Array(W * H);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      mask[y * W + x] = 1;
      pixels[y * W + x] = value;
    }
  }
  return { mask, plane: { pixels, width: W, height: H } };
}

const CORR = 4 * (2 - Math.SQRT2); // corner correction for a 4-corner (rectangular) outline

test('3x3 square: exact area/centroid + ImageJ traced perimeter and capped circularity', () => {
  const { mask, plane } = rectMask(5, 5, 1, 1, 3, 3);
  const { objects } = analyzeParticles(mask, plane);
  assert.equal(objects.length, 1);
  const o = objects[0];
  assert.equal(o.area, 9);
  assert.deepEqual(o.centroid, { x: 2, y: 2 });
  // Σ|dx|+Σ|dy| = 2·3 + 2·3 = 12; perimeter = 12 − 4(2−√2) ≈ 9.656854.
  assert.ok(Math.abs(o.perimeterPx - (12 - CORR)) < 1e-6, `perimeter ${o.perimeterPx}`);
  // 4π·9/9.656854² ≈ 1.21 → capped to 1.0.
  assert.equal(o.circularity, 1);
  assert.equal(o.polygon.length, 4, 'square outline is a 4-corner polygon');
});

test('10x2 rectangle: exact area/centroid + sub-1 circularity from traced perimeter', () => {
  const { mask, plane } = rectMask(14, 6, 1, 1, 10, 2, 4000);
  const { objects } = analyzeParticles(mask, plane);
  const o = objects[0];
  assert.equal(o.area, 20);
  assert.deepEqual(o.centroid, { x: 5.5, y: 1.5 });
  // Σ|dx|+Σ|dy| = 2·10 + 2·2 = 24; perimeter = 24 − 4(2−√2) ≈ 21.656854.
  assert.ok(Math.abs(o.perimeterPx - (24 - CORR)) < 1e-6, `perimeter ${o.perimeterPx}`);
  // 4π·20/21.656854² ≈ 0.5358.
  assert.ok(Math.abs(o.circularity - (4 * Math.PI * 20) / ((24 - CORR) ** 2)) < 1e-9);
  assert.ok(o.circularity > 0.5 && o.circularity < 0.6, `circularity ${o.circularity}`);
  assert.equal(o.polygon.length, 4);
});

test('L-shape: non-convex outline traces six corners with exact area', () => {
  // 3x3 block minus the top-right pixel → 8 px, an L (hexagonal outline).
  const W = 5, H = 5;
  const mask = new Uint8Array(W * H);
  const pixels = new Float32Array(W * H);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) { mask[y * W + x] = 1; pixels[y * W + x] = 500; }
  mask[1 * W + 3] = 0; pixels[1 * W + 3] = 0; // remove top-right
  const { objects } = analyzeParticles(mask, { pixels, width: W, height: H });
  const o = objects[0];
  assert.equal(o.area, 8);
  assert.equal(o.polygon.length, 6, 'L outline is a 6-corner polygon');
});

test('raw intensity is exact: constant region mean/min/max equal the painted value', () => {
  const { mask, plane } = rectMask(8, 8, 2, 2, 4, 4, 54321);
  const obj = analyzeParticles(mask, plane).objects.find((p) => p.area === 16);
  assert.equal(obj.mean, 54321);
  assert.equal(obj.min, 54321);
  assert.equal(obj.max, 54321);
  assert.equal(obj.intDen, 54321 * 16);
});

test('calibrated traced perimeter scales by pixel size', () => {
  const { mask, plane } = rectMask(5, 5, 1, 1, 3, 3);
  const { objects } = analyzeParticles(mask, plane, {}, { rowMm: 0.002, colMm: 0.002, known: true });
  const o = objects[0];
  // Σ|dx|·0.002 + Σ|dy|·0.002 − 4·0.002·(2−√2) = 0.002·(12 − 4(2−√2)).
  assert.ok(Math.abs(o.perimeterMm - 0.002 * (12 - CORR)) < 1e-9, `perimeterMm ${o.perimeterMm}`);
  assert.ok(Math.abs(o.areaMm2 - 9 * 0.002 * 0.002) < 1e-12);
});

test('anisotropic pixels use ImageJ exact corner correction (pw+ph)−√(pw²+ph²)', () => {
  // pw≠ph: the (pw+ph)/2·(2−√2) approximation would be wrong here; ImageJ subtracts
  // (pw+ph)−hypot(pw,ph) per corner. 3x3 square → Σ|dx|=6, Σ|dy|=6, 4 corners.
  const pw = 0.001, ph = 0.003; // colMm (x), rowMm (y)
  const { mask, plane } = rectMask(5, 5, 1, 1, 3, 3);
  const { objects } = analyzeParticles(mask, plane, {}, { rowMm: ph, colMm: pw, known: true });
  const expected = 6 * pw + 6 * ph - 4 * ((pw + ph) - Math.hypot(pw, ph));
  assert.ok(Math.abs(objects[0].perimeterMm - expected) < 1e-12, `perimeterMm ${objects[0].perimeterMm} vs ${expected}`);
});
