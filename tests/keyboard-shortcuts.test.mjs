import assert from 'node:assert/strict';
import { test } from 'node:test';

async function shortcutModule(t) {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  t.after(() => { globalThis.localStorage = previousStorage; });
  return import(`../js/keyboard-shortcuts.js?t=${Date.now()}-${Math.random()}`);
}

test('shortcut editor rejects keys owned by navigation and dialog controls', async (t) => {
  const shortcuts = await shortcutModule(t);
  shortcuts.registerShortcutCommand({ id: 'shot', label: 'Screenshot', shortcut: 'S' });

  for (const reserved of ['Escape', 'Enter', 'Space', 'ArrowUp', 'Meta+Home']) {
    const result = shortcuts.setShortcut('shot', reserved);
    assert.equal(result.ok, false);
    assert.equal(result.reserved, reserved.split('+').at(-1));
  }
  assert.equal(shortcuts.getShortcut('shot'), 'S');
});

test('reset cannot silently recreate a duplicate default binding', async (t) => {
  const shortcuts = await shortcutModule(t);
  shortcuts.registerShortcutCommands([
    { id: 'shot', label: 'Screenshot', shortcut: 'S' },
    { id: 'mpr', label: 'MPR', shortcut: 'M' },
  ]);
  shortcuts.clearShortcut('shot');
  assert.equal(shortcuts.setShortcut('mpr', 'S').ok, true);

  const result = shortcuts.resetShortcut('shot');
  assert.equal(result.ok, false);
  assert.equal(result.conflict?.id, 'mpr');
  assert.equal(shortcuts.getShortcut('shot'), '');
  assert.equal(shortcuts.getShortcut('mpr'), 'S');
});
