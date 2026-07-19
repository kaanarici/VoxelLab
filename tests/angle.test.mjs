/* global URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

function makeNode() {
  return {
    classList: { toggle() {}, contains: () => false },
  };
}

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
    return makeNode();
  },
};

const { onAngleClick } = await import('../js/roi/angle.js');
const { state } = await import('../js/core/state.js');
const { angleEntriesForSlice } = await import('../js/overlay/annotation-graph.js');

test('onAngleClick stores physical-space angle for non-square pixels', () => {
  state.manifest = {
    series: [{
      slug: 'rect_angle',
      imageDomain: 'microscopy',
      pixelSpacing: [2, 3],
      microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 2 },
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.angleMode = true;
  state.anglePending = null;
  state.angleMeasurements = {};

  const target = { classList: { contains: () => false } };
  onAngleClick({ clientX: 20, clientY: 20, target });
  onAngleClick({ clientX: 10, clientY: 20, target });
  onAngleClick({ clientX: 20, clientY: 30, target });

  const [saved] = angleEntriesForSlice(state, state.manifest.series[0], 0);
  assert.ok(saved);
  assert.ok(Math.abs(saved.deg - 33.690067525979785) < 1e-6);
  assert.deepEqual(saved.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 2 });
});
