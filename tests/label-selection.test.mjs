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

test('isSelectionActive: locked or preview makes it active', () => {
  assert.equal(isSelectionActive({ locked: new Set(), preview: null }), false);
  assert.equal(isSelectionActive({ locked: new Set([1]), preview: null }), true);
  assert.equal(isSelectionActive({ locked: new Set(), preview: 2 }), true);
});

test('no selection: visible = all minus user-hidden; hidden = raw user-hidden', () => {
  const all = allLabelsFromMeta(META);
  const hidden = new Set([2]);
  const visible = effectiveVisibleLabels({ hidden, locked: new Set(), preview: null, allLabels: all });
  assert.deepEqual([...visible].sort((a, b) => a - b), [1, 3]);
  // Fallthrough returns the literal user-hidden set, not a complement.
  const eff = effectiveHiddenLabels({ hidden, locked: new Set(), preview: null, allLabels: all });
  assert.deepEqual([...eff], [2]);
});

test('preview-only previews exactly the one hovered label', () => {
  const all = allLabelsFromMeta(META);
  const visible = effectiveVisibleLabels({ hidden: new Set(), locked: new Set(), preview: 2, allLabels: all });
  assert.deepEqual([...visible], [2]);
  const hidden = effectiveHiddenLabels({ hidden: new Set(), locked: new Set(), preview: 2, allLabels: all });
  assert.deepEqual([...hidden].sort((a, b) => a - b), [1, 3]);
});

test('locked-only shows locked; locked + preview is the union', () => {
  const all = allLabelsFromMeta(META);
  const lockedOnly = effectiveVisibleLabels({ hidden: new Set(), locked: new Set([1]), preview: null, allLabels: all });
  assert.deepEqual([...lockedOnly], [1]);
  const union = effectiveVisibleLabels({ hidden: new Set(), locked: new Set([1]), preview: 3, allLabels: all });
  assert.deepEqual([...union].sort((a, b) => a - b), [1, 3]);
});

test('user-hidden still subtracts from locked/preview', () => {
  const all = allLabelsFromMeta(META);
  const visible = effectiveVisibleLabels({ hidden: new Set([1]), locked: new Set([1, 2]), preview: 3, allLabels: all });
  assert.deepEqual([...visible].sort((a, b) => a - b), [2, 3]);
});
