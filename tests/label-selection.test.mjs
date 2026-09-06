import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allLabelsFromMeta,
  effectiveHiddenLabels,
  effectiveVisibleLabels,
  isSelectionActive,
} from '../js/atlas/label-selection.js';

const META = {
  regions: { 0: { name: 'bg' }, 1: { name: 'A' }, 2: { name: 'B' }, 3: { name: 'C' }, 254: {}, 255: {} },
};

test('allLabelsFromMeta reads region keys and drops 0/254/255', () => {
  const all = allLabelsFromMeta(META);
  assert.deepEqual([...all].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...allLabelsFromMeta(null)], []);
});

test('isSelectionActive requires a locked label', () => {
  assert.equal(isSelectionActive(), false);
  assert.equal(isSelectionActive({ locked: new Set() }), false);
  assert.equal(isSelectionActive({ locked: new Set([1]) }), true);
});

test('no selection: visible = all minus user-hidden; hidden = raw user-hidden', () => {
  const all = allLabelsFromMeta(META);
  const hidden = new Set([2]);
  const visible = effectiveVisibleLabels({ hidden, locked: new Set(), allLabels: all });
  assert.deepEqual([...visible].sort((a, b) => a - b), [1, 3]);

  const eff = effectiveHiddenLabels({ hidden, locked: new Set(), allLabels: all });
  assert.deepEqual([...eff], [2]);
});

test('locked selection shows only locked labels and hides the rest', () => {
  const all = allLabelsFromMeta(META);
  const selection = { hidden: new Set(), locked: new Set([1, 3]), allLabels: all };
  assert.deepEqual([...effectiveVisibleLabels(selection)].sort((a, b) => a - b), [1, 3]);
  assert.deepEqual([...effectiveHiddenLabels(selection)], [2]);
});

test('user-hidden still subtracts from locked labels', () => {
  const all = allLabelsFromMeta(META);
  const visible = effectiveVisibleLabels({ hidden: new Set([1]), locked: new Set([1, 2, 3]), allLabels: all });
  assert.deepEqual([...visible].sort((a, b) => a - b), [2, 3]);
});
