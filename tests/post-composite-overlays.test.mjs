import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/core/state.js');
const { drawPostCompositeOverlays, setMicroscopyAnalysisOverlay } = await import('../js/overlay/post-composite-overlays.js');

test('drawing without overlays avoids snapshot work', () => {
  const previousRuntime = state.threeRuntime;
  state.threeRuntime = {
    get seriesIdx() {
      throw new Error('snapshot should not read runtime state without overlays');
    },
  };
  try {
    drawPostCompositeOverlays({ marker: [] });
  } finally {
    state.threeRuntime = previousRuntime;
  }
});

test('drawPostCompositeOverlays skips work when the microscopy overlay is unset', () => {
  setMicroscopyAnalysisOverlay(null);
  const ctx = { called: false, save() { this.called = true; } };
  drawPostCompositeOverlays(ctx);
  assert.equal(ctx.called, false);
});
