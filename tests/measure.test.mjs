import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

function makeNode() {
  return {
    attrs: {},
    children: [],
    classList: { remove() {} },
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); },
    addEventListener() {},
    remove() {},
  };
}

const overlaySvg = {
  ...makeNode(),
  innerHTML: '',
  querySelectorAll() { return []; },
};
const view = {
  width: 100,
  height: 100,
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  },
};

globalThis.document = {
  getElementById(id) {
    if (id === 'view') return view;
    if (id === 'overlay-svg') return overlaySvg;
    return makeNode();
  },
  createElementNS() { return makeNode(); },
};

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
};

const { initROI } = await import('../js/roi.js');
const { onMeasureClick } = await import('../js/roi/measure.js');
const { state } = await import('../js/core/state.js');
const { measurementEntriesForSlice } = await import('../js/overlay/annotation-graph.js');

initROI({
  state,
  getRawSliceData: () => null,
  onROIChange() {},
});

test('onMeasureClick uses column spacing for horizontal distance', () => {
  state.manifest = {
    series: [{ slug: 'rect_px', width: 100, pixelSpacing: [2, 3] }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.measureMode = true;
  state.measurePending = null;
  state.measurements = {};
  state.angleMeasurements = {};
  state.anglePending = null;

  const target = { classList: { contains: () => false } };
  onMeasureClick({ clientX: 10, clientY: 20, target });
  onMeasureClick({ clientX: 20, clientY: 20, target });

  const list = measurementEntriesForSlice(state, state.manifest.series[0], 0);
  assert.equal(list.length, 1);
  assert.equal(list[0].mm, 30);
  assert.equal(list[0].unit, 'mm');
  assert.equal(list[0].spacingKnown, true);
});

test('onMeasureClick stores uncalibrated distances as pixels, not millimeters', () => {
  state.manifest = {
    series: [{ slug: 'uncalibrated', width: 100, pixelSpacing: [0, 0] }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.measureMode = true;
  state.measurePending = null;
  state.measurements = {};
  state.angleMeasurements = {};
  state.anglePending = null;

  const target = { classList: { contains: () => false } };
  onMeasureClick({ clientX: 10, clientY: 20, target });
  onMeasureClick({ clientX: 20, clientY: 20, target });

  const list = measurementEntriesForSlice(state, state.manifest.series[0], 0);
  assert.equal(list.length, 1);
  assert.equal(list[0].mm, 10);
  assert.equal(list[0].unit, 'px');
  assert.equal(list[0].spacingKnown, false);
});
