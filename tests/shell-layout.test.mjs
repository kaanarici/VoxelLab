import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { clampLeftRailWidthPx, parseShellLayout, patchShellLayout } from '../js/shell/shell-layout-toggles.js';

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

test('patchShellLayout keeps sibling chrome sizes when updating the scrubber', () => {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  try {
    patchShellLayout({ leftCollapsed: false, rightCollapsed: true, leftWidth: 250 });
    patchShellLayout({ scrubberWidth: 320 });
    assert.deepEqual(JSON.parse(store.get('mri-viewer/shellLayout/v1')), {
      leftCollapsed: false,
      rightCollapsed: true,
      leftWidth: 250,
      scrubberWidth: 320,
    });
    patchShellLayout({ scrubberWidth: null });
    assert.deepEqual(JSON.parse(store.get('mri-viewer/shellLayout/v1')), {
      leftCollapsed: false,
      rightCollapsed: true,
      leftWidth: 250,
    });
  } finally {
    globalThis.localStorage = previous;
  }
});

test('clampLeftRailWidthPx stays between the left min and right rail', () => {
  assert.equal(clampLeftRailWidthPx(208, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(312, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(400, 208, 312), 312);
  assert.equal(clampLeftRailWidthPx(100, 208, 312), 208);
  assert.equal(clampLeftRailWidthPx(250.6, 208, 312), 251);
  assert.equal(clampLeftRailWidthPx(Number.NaN, 208, 312), 208);
});

test('notify container stays at inline-end above the toolbar without a physical right override', () => {
  const css = readFileSync(new URL('../css/base.css', import.meta.url), 'utf8');
  const block = css.match(/#notify-container \{[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(block, 'expected #notify-container rule in css/base.css');
  assert.match(block, /inset-inline-end:/);
  assert.match(block, /--btn-toolbar/);
  assert.doesNotMatch(block, /right:\s*auto/);
  assert.match(css, /\.app:not\(\.right-collapsed\)\s*~\s*#notify-container/);
  assert.match(css, /body:has\(\.toolbox\.open\) #notify-container/);
  assert.match(css, /body:has\(\.custom-dropdown\.open\) #notify-container/);
  assert.match(css, /z-index:\s*calc\(var\(--z-header\)\s*-\s*1\)/);
  assert.match(css, /body:has\(\.canvas-wrap\.mpr\) #notify-container/);
  assert.match(css, /body:has\(\.canvas-wrap\.mpr3d\) #notify-container/);
  assert.doesNotMatch(css, /\.notify-item::before/);
});
