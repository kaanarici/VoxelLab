import assert from 'node:assert/strict';
import { test } from 'node:test';

const { activateSeriesViewMode } = await import('../js/series-view-activation.js');

function stubViewer() {
  const calls = [];
  return {
    calls,
    setMode: (mode) => calls.push(['setMode', mode]),
    syncMprSliceIndex: (series) => calls.push(['syncMprSliceIndex', series.slug]),
    ensureThree: () => calls.push(['ensureThree']),
    syncThreeSurfaceState: (series) => calls.push(['syncThreeSurfaceState', series.slug]),
    updateClipReadouts: () => calls.push(['updateClipReadouts']),
  };
}

test('activateSeriesViewMode routes restored MPR through MPR slice synchronization', () => {
  const viewer = stubViewer();

  const result = activateSeriesViewMode({ mode: 'mpr' }, { slug: 'mpr_restore' }, viewer);

  assert.deepEqual(result, { mode: 'mpr', mprActive: true, threeActive: false });
  assert.deepEqual(viewer.calls, [
    ['setMode', 'mpr'],
    ['syncMprSliceIndex', 'mpr_restore'],
  ]);
});

test('activateSeriesViewMode routes restored 3D through Three bootstrap and readiness sync', () => {
  const viewer = stubViewer();

  const result = activateSeriesViewMode({ mode: '3d' }, { slug: 'three_restore' }, viewer);

  assert.deepEqual(result, { mode: '3d', mprActive: false, threeActive: true });
  assert.deepEqual(viewer.calls, [
    ['setMode', '3d'],
    ['ensureThree'],
    ['syncThreeSurfaceState', 'three_restore'],
    ['updateClipReadouts'],
  ]);
});

test('activateSeriesViewMode initializes both MPR and Three for restored MPR+3D', () => {
  const viewer = stubViewer();

  const result = activateSeriesViewMode({ mode: 'mpr3d' }, { slug: 'combo_restore' }, viewer);

  assert.deepEqual(result, { mode: 'mpr3d', mprActive: true, threeActive: true });
  assert.deepEqual(viewer.calls, [
    ['setMode', 'mpr3d'],
    ['syncMprSliceIndex', 'combo_restore'],
    ['ensureThree'],
    ['syncThreeSurfaceState', 'combo_restore'],
    ['updateClipReadouts'],
  ]);
});
