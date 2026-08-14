import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectPyramidLevel } from '../js/microscopy/zarr/zarr-level-select.js';
import { omeZarrResourceBudget } from '../js/microscopy/zarr/zarr-resource-budget.js';

test('selectPyramidLevel selects the coarsest level that fits the plane budget', () => {
  const selection = selectPyramidLevel([
    { level: 0, path: '0', width: 4000, height: 3000, downsample: 1 },
    { level: 1, path: '1', width: 2000, height: 1500, downsample: 2 },
    { level: 2, path: '2', width: 1000, height: 750, downsample: 4 },
  ]);

  assert.equal(selection.path, '2');
  assert.match(selection.reason, /within 4000000 pixel budget/);
});

test('selectPyramidLevel fails closed when every level exceeds the plane budget', () => {
  const selection = selectPyramidLevel([
    { level: 0, path: '0', width: 3000, height: 3000 },
    { level: 1, path: '1', width: 2500, height: 2500 },
  ], { maxPlanePixels: 4_000_000 });

  assert.equal(selection.level, null);
  assert.equal(selection.path, '');
  assert.match(selection.reason, /No pyramid level fits 4000000 pixel budget/);
});

test('omeZarrResourceBudget bounds aggregate eager plane allocations and chunk fan-out', () => {
  const aggregate = omeZarrResourceBudget({ width: 1024, height: 1024, sizeZ: 17 });
  assert.equal(aggregate.ok, false);
  assert.match(aggregate.reason, /aggregate plane pixels/);

  const chunks = omeZarrResourceBudget({ width: 1024, height: 1024, chunkWidth: 1, chunkHeight: 1 });
  assert.equal(chunks.ok, false);
  assert.match(chunks.reason, /chunks per plane/);
});

test('OME-Zarr resource budgets cannot be widened by an importer option', () => {
  const budget = omeZarrResourceBudget({
    width: 4_000_001,
    height: 1,
    maxPlanePixels: 8_000_000,
  });

  assert.equal(budget.ok, false);
  assert.match(budget.reason, /4000000 pixel budget/);
});

test('OME-Zarr resource budgets include padded bytes in full declared chunk shapes', () => {
  const budget = omeZarrResourceBudget({
    width: 1,
    height: 1,
    chunkWidth: 1,
    chunkHeight: 1,
    axes: [{ name: 'y' }, { name: 'x' }],
    shape: [1, 1],
    chunks: [1, 33_554_433],
    bytesPerElement: 1,
  });

  assert.equal(budget.ok, false);
  assert.match(budget.reason, /33554433 decoded bytes per chunk exceeds the 33554432 byte budget/);
});
