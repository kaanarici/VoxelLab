import assert from 'node:assert/strict';
import { test } from 'node:test';

const { state } = await import('../js/core/state.js');
const { zoomToFit } = await import('../js/shell/viewport.js');

function classList() {
  const set = new Set();
  return {
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    toggle(name, force) {
      if (force === undefined) {
        if (set.has(name)) set.delete(name);
        else set.add(name);
        return set.has(name);
      }
      if (force) set.add(name);
      else set.delete(name);
      return !!force;
    },
    contains(name) { return set.has(name); },
  };
}

test('zoomToFit uses physical in-plane spacing instead of raw pixel aspect', () => {
  const canvas = { width: 100, height: 100 };
  const stage = {
    getBoundingClientRect: () => ({ width: 300, height: 300 }),
  };
  const xformStyle = {
    values: {},
    setProperty(name, value) { this.values[name] = value; },
  };
  const badge = { textContent: '', classList: classList() };
  globalThis.document = {
    getElementById(id) {
      if (id === 'view') return canvas;
      if (id === 'view-stage') return stage;
      if (id === 'view-xform') return { style: xformStyle };
      if (id === 'zoom-badge') return badge;
      return null;
    },
  };

  state.manifest = {
    series: [{ width: 100, height: 100, pixelSpacing: [4, 1] }],
  };
  state.seriesIdx = 0;
  state.zoom = 1;
  state.tx = 0;
  state.ty = 0;

  zoomToFit();

  assert.equal(state.zoom, 0.55);
  assert.equal(xformStyle.values['--zoom'], '0.55');
});

test('zoomToFit can enlarge small calibrated images to fill the viewport', () => {
  const canvas = { width: 50, height: 50 };
  const stage = {
    getBoundingClientRect: () => ({ width: 300, height: 300 }),
  };
  const xformStyle = {
    values: {},
    setProperty(name, value) { this.values[name] = value; },
  };
  const badge = { textContent: '', classList: classList() };
  globalThis.document = {
    getElementById(id) {
      if (id === 'view') return canvas;
      if (id === 'view-stage') return stage;
      if (id === 'view-xform') return { style: xformStyle };
      if (id === 'zoom-badge') return badge;
      return null;
    },
  };

  state.manifest = {
    series: [{ width: 50, height: 50, pixelSpacing: [1, 1] }],
  };
  state.seriesIdx = 0;
  state.zoom = 1;
  state.tx = 0;
  state.ty = 0;

  zoomToFit();

  assert.equal(state.zoom, 4.4);
  assert.equal(xformStyle.values['--zoom'], '4.4');
});

test('zoomToFit sizes the CSS box from series geometry before scaling a 512 placeholder canvas', () => {
  const canvas = { width: 512, height: 512, style: {} };
  const stage = {
    getBoundingClientRect: () => ({ width: 300, height: 300 }),
  };
  const xformStyle = {
    values: {},
    setProperty(name, value) { this.values[name] = value; },
  };
  const badge = { textContent: '', classList: classList() };
  globalThis.document = {
    getElementById(id) {
      if (id === 'view') return canvas;
      if (id === 'view-stage') return stage;
      if (id === 'view-xform') return { style: xformStyle };
      if (id === 'zoom-badge') return badge;
      return null;
    },
  };

  state.manifest = {
    series: [{ width: 16, height: 16, pixelSpacing: [0.00025, 0.0005] }],
  };
  state.seriesIdx = 0;
  state.zoom = 1;
  state.tx = 0;
  state.ty = 0;

  zoomToFit();

  assert.equal(canvas.style.width, '32px');
  assert.equal(canvas.style.height, '16px');
  assert.equal(state.zoom, 6.875);
  assert.equal(xformStyle.values['--zoom'], '6.875');
});
