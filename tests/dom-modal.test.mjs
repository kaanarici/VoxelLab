import assert from 'node:assert/strict';
import { test } from 'node:test';

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
  };
}

function button(id) {
  return {
    id,
    disabled: false,
    getClientRects: () => [1],
    focus() {
      globalThis.document.activeElement = this;
    },
  };
}

function modal(id, focusables = [button(`${id}-button`)]) {
  const listeners = new Map();
  return {
    id,
    classList: classList(),
    focusables,
    contains(node) {
      return node === this || focusables.includes(node);
    },
    querySelectorAll() {
      return focusables;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatchKey(event) {
      listeners.get('keydown')?.(event);
    },
  };
}

test('closeTopModal closes the most recently focused modal first', async (t) => {
  const previousDocument = globalThis.document;
  const opener = button('opener');
  const first = modal('first-modal');
  const second = modal('second-modal');
  const elements = new Map([
    [first.id, first],
    [second.id, second],
  ]);

  globalThis.document = {
    activeElement: opener,
    getElementById: id => elements.get(id) || null,
    querySelector() {
      return [first, second].find(el => el.classList.contains('visible')) || null;
    },
  };
  t.after(() => { globalThis.document = previousDocument; });

  const { closeTopModal, openModal } = await import('../js/dom.js');
  openModal('first-modal');
  openModal('second-modal');

  assert.equal(closeTopModal(), true);
  assert.equal(first.classList.contains('visible'), true);
  assert.equal(second.classList.contains('visible'), false);
  assert.equal(globalThis.document.activeElement, first.focusables[0]);

  assert.equal(closeTopModal(), true);
  assert.equal(first.classList.contains('visible'), false);
  assert.equal(globalThis.document.activeElement, opener);
});

test('modal Tab handling stays inside the active trap', async (t) => {
  const previousDocument = globalThis.document;
  const firstButton = button('first');
  const lastButton = button('last');
  const dialog = modal('tab-modal', [firstButton, lastButton]);

  globalThis.document = {
    activeElement: firstButton,
    getElementById: id => (id === dialog.id ? dialog : null),
    querySelector: () => null,
  };
  t.after(() => { globalThis.document = previousDocument; });

  const { closeModal, openModal } = await import('../js/dom.js');
  openModal('tab-modal');

  const forward = { key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
  globalThis.document.activeElement = lastButton;
  dialog.dispatchKey(forward);
  assert.equal(forward.prevented, true);
  assert.equal(globalThis.document.activeElement, firstButton);

  const backward = { key: 'Tab', shiftKey: true, prevented: false, preventDefault() { this.prevented = true; } };
  dialog.dispatchKey(backward);
  assert.equal(backward.prevented, true);
  assert.equal(globalThis.document.activeElement, lastButton);

  closeModal('tab-modal');
});
