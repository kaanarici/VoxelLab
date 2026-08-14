import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countVoxelsForLabel,
  formatVolumeMl,
  inspectForLabel,
  volumeTip,
} from '../js/atlas/label-inspect.js';

// 2x2x2 volume; spacing chosen so one voxel = (2 * 1 * 3) / 1000 = 0.006 mL.
// pixelSpacing = [row=1, col=2]; firstIPP/lastIPP give sliceSpacing = 3.
const SERIES = {
  width: 2,
  height: 2,
  slices: 2,
  pixelSpacing: [1, 2],
  orientation: [1, 0, 0, 0, 1, 0],
  firstIPP: [0, 0, 0],
  lastIPP: [0, 0, 3],
};
const META = { regions: { 5: { name: 'Spleen', mL: 999 } }, legend: { 5: 'Spleen' } };
// Three voxels labelled 5.
const VOXELS = new Uint8Array([5, 0, 5, 0, 5, 0, 0, 0]);

test('countVoxelsForLabel counts only matching bytes', () => {
  assert.equal(countVoxelsForLabel(VOXELS, 5), 3);
  assert.equal(countVoxelsForLabel(VOXELS, 0), 5);
  assert.equal(countVoxelsForLabel(null, 5), 0);
});

test('mlApprox = count * col * row * slice / 1000 (recomputed, not echoed)', () => {
  const rec = inspectForLabel(SERIES, 5, META, VOXELS);
  assert.equal(rec.name, 'Spleen');
  assert.equal(rec.voxelCount, 3);
  assert.equal(rec.calibrated, true);
  // 3 * (2 * 1 * 3 / 1000) = 0.018, NOT the rounded sidecar 999.
  assert.ok(Math.abs(rec.mlApprox - 0.018) < 1e-9);
});

test('uncalibrated spacing yields no mL and a flag', () => {
  const series = { ...SERIES, pixelSpacing: [0, 0] };
  const rec = inspectForLabel(series, 5, META, VOXELS);
  assert.equal(rec.calibrated, false);
  assert.equal(rec.mlApprox, null);
  assert.equal(rec.voxelCount, 3);
});

test('formatVolumeMl uses proportional precision', () => {
  assert.equal(formatVolumeMl(213.4), '213');
  assert.equal(formatVolumeMl(42.37), '42.4');
  assert.equal(formatVolumeMl(0.018), '0.02');
});

test('volumeTip: calibrated shows the cheap sidecar mL (not a per-frame recount)', () => {
  assert.equal(volumeTip(SERIES, META, 5), '~999 mL');
});

test('volumeTip: uncalibrated degrades to voxel count', () => {
  const series = { ...SERIES, pixelSpacing: [0, 0] };
  const meta = { regions: { 7: { name: 'X', mL: 5, voxels: 1234 } } };
  assert.equal(volumeTip(series, meta, 7), `${(1234).toLocaleString()} voxels`);
});

test('volumeTip: empty string when the region is unknown', () => {
  assert.equal(volumeTip(SERIES, META, 999), '');
});
