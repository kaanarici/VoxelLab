import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitFor } from './helpers/node/wait.mjs';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

const spinner = { hidden: true };
installViewerGlobals({
  document: { getElementById: id => (id === 'viewer-spinner' ? spinner : null) },
});

const { state } = await import('../js/core/state.js');
const { beginViewerRuntimeSession } = await import('../js/runtime/viewer-session.js');
const { syncThreeSurfaceState } = await import('../js/runtime/three-surface-state.js');
const { __pendingSpinnerKeysForTests, __resetSpinnerForTests } = await import('../js/spinner.js');

function resetSpinner(t) {
  __resetSpinnerForTests();
  spinner.hidden = true;
  t.after(() => __resetSpinnerForTests());
}

test('syncThreeSurfaceState leaves no pending spinner work once the 3D surface is visible', (t) => {
  resetSpinner(t);
  state.manifest = {
    series: [{ slug: 'three_wait', width: 2, height: 2, slices: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '3d';
  state.overlays.labels = true;
  state.voxels = new Uint8Array(8);
  state.regionVoxels = null;
  state.overlays.regionMeta = null;
  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 1 });

  const status = syncThreeSurfaceState();

  assert.equal(status.pending, false);
  assert.deepEqual(__pendingSpinnerKeysForTests(), [], 'a ready surface must schedule no spinner reveal');
  assert.equal(spinner.hidden, true);
});

test('syncThreeSurfaceState reveals the spinner until a 3D mesh exists', async (t) => {
  resetSpinner(t);
  state.manifest = {
    series: [{ slug: 'three_boot', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '3d';
  state.voxels = new Uint8Array(8);
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 2 });

  const status = syncThreeSurfaceState();

  assert.equal(status.pending, true);
  assert.deepEqual(__pendingSpinnerKeysForTests(), ['three-surface']);
  await waitFor(() => spinner.hidden === false, { message: 'the viewer spinner to appear' });
});

test('syncThreeSurfaceState clears pending spinner work when the surface becomes ready', async (t) => {
  resetSpinner(t);
  state.manifest = {
    series: [{ slug: 'three_settle', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '3d';
  state.voxels = new Uint8Array(8);
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 3 });
  syncThreeSurfaceState();
  await waitFor(() => spinner.hidden === false, { message: 'the viewer spinner to appear' });

  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  assert.equal(syncThreeSurfaceState().pending, false);
  assert.deepEqual(__pendingSpinnerKeysForTests(), []);
  await waitFor(() => spinner.hidden === true, { message: 'the viewer spinner to hide' });
});
