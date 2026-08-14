import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filteredRegionColors } from '../js/runtime/region-color-isolation.js';

test('keeps only visible labels and omits the rest', () => {
  const colors = { 1: [10, 10, 10], 2: [20, 20, 20], 3: [30, 30, 30] };
  const out = filteredRegionColors(colors, new Set([1, 3]));
  assert.deepEqual(Object.keys(out).sort(), ['1', '3']);
  assert.deepEqual(out[1], [10, 10, 10]);
  assert.equal(out[2], undefined);
});

test('does not mutate the input colors map', () => {
  const colors = { 1: [10, 10, 10], 2: [20, 20, 20] };
  filteredRegionColors(colors, new Set([1]));
  assert.deepEqual(Object.keys(colors).sort(), ['1', '2']);
});

test('empty visible set yields an empty map', () => {
  assert.deepEqual(filteredRegionColors({ 1: [1, 1, 1] }, new Set()), {});
});
