import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failingStorage, memoryStorage, withGlobal } from './helpers/node/viewer-globals.mjs';
import {
  clampLeftRailWidthPx,
  loadShellLayout,
  parseShellLayout,
  patchShellLayout,
} from '../js/shell/shell-layout-toggles.js';

const SHELL_LAYOUT_KEY = 'mri-viewer/shellLayout/v1';

function withStorage(t, storage = memoryStorage()) {
  t.after(withGlobal('localStorage', storage));
  return storage;
}

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
  assert.deepEqual(
    parseShellLayout('{"leftCollapsed":false,"rightCollapsed":false,"scrubberWidth":320}'),
    { leftCollapsed: false, rightCollapsed: false, scrubberWidth: 320 },
  );
  assert.deepEqual(
    parseShellLayout('{"leftCollapsed":false,"rightCollapsed":false,"scrubberWidth":"320"}'),
    { leftCollapsed: false, rightCollapsed: false },
  );
});

test('patchShellLayout keeps sibling chrome sizes when updating the scrubber', (t) => {
  const storage = withStorage(t);

  patchShellLayout({ leftCollapsed: false, rightCollapsed: true, leftWidth: 250 });
  patchShellLayout({ scrubberWidth: 320 });
  assert.deepEqual(JSON.parse(storage.getItem(SHELL_LAYOUT_KEY)), {
    leftCollapsed: false,
    rightCollapsed: true,
    leftWidth: 250,
    scrubberWidth: 320,
  });

  patchShellLayout({ scrubberWidth: null });
  assert.deepEqual(JSON.parse(storage.getItem(SHELL_LAYOUT_KEY)), {
    leftCollapsed: false,
    rightCollapsed: true,
    leftWidth: 250,
  });
});

test('patchShellLayout ignores non-boolean collapse flags and non-finite widths', (t) => {
  const storage = withStorage(t);

  patchShellLayout({ leftCollapsed: true, rightCollapsed: true, leftWidth: 240 });
  const next = patchShellLayout({ leftCollapsed: 'yes', rightCollapsed: 1, leftWidth: Number.NaN });

  assert.deepEqual(next, { leftCollapsed: true, rightCollapsed: true });
  assert.deepEqual(JSON.parse(storage.getItem(SHELL_LAYOUT_KEY)), {
    leftCollapsed: true,
    rightCollapsed: true,
  });
});

test('shell layout survives unreadable and unwritable browser storage', (t) => {
  withStorage(t, failingStorage());

  assert.equal(loadShellLayout(), null);
  assert.deepEqual(
    patchShellLayout({ leftCollapsed: true, leftWidth: 260 }),
    { leftCollapsed: true, rightCollapsed: false, leftWidth: 260 },
  );
});

test('loadShellLayout rejects a stored record that lost its collapse flags', (t) => {
  const storage = withStorage(t);
  storage.setItem(SHELL_LAYOUT_KEY, JSON.stringify({ leftWidth: 250 }));

  assert.equal(loadShellLayout(), null);
  assert.deepEqual(
    patchShellLayout({ scrubberWidth: 300 }),
    { leftCollapsed: false, rightCollapsed: false, scrubberWidth: 300 },
  );
});

test('clampLeftRailWidthPx stays between the left min and right rail', () => {
  assert.equal(clampLeftRailWidthPx(208, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(312, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(400, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(100, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(250.6, 208, 312), 251);
  assert.equal(clampLeftRailWidthPx(Number.NaN, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(300, 280, 240), 280);
});
