import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampLeftRailWidthPx, parseShellLayout } from '../js/shell/shell-layout-toggles.js';

test('parseShellLayout keeps collapse flags and an optional left width', () => {
  assert.equal(parseShellLayout(null), null);
  assert.equal(parseShellLayout('{'), null);
  assert.equal(parseShellLayout('{"leftCollapsed":true}'), null);
  assert.deepEqual(
    parseShellLayout('{"leftCollapsed":false,"rightCollapsed":true}'),
    { leftCollapsed: false, rightCollapsed: true },
  );
  assert.deepEqual(
    parseShellLayout('{"leftCollapsed":true,"rightCollapsed":false,"leftWidth":250}'),
    { leftCollapsed: true, rightCollapsed: false, leftWidth: 250 },
  );
  assert.deepEqual(
    parseShellLayout('{"leftCollapsed":false,"rightCollapsed":false,"leftWidth":"250"}'),
    { leftCollapsed: false, rightCollapsed: false },
  );
});

test('clampLeftRailWidthPx stays between the left min and right rail', () => {
  assert.equal(clampLeftRailWidthPx(208, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(312, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(400, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(100, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(250.6, 208, 312), 251);
  assert.equal(clampLeftRailWidthPx(Number.NaN, 208, 312), 208);
});
