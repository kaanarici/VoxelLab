import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedOverlayStack } from './helpers/node/overlay-stacks.mjs';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

const { storage } = installViewerGlobals({ desktop: true });

const { state } = await import('../js/core/state.js');
const { toggleSeriesOverlay } = await import('../js/overlay/overlay-toggle.js');
const { getPreferredOverlays } = await import('../js/overlay/overlay-preferences.js');
const { seriesViewMemoryKey } = await import('../js/core/state/series-view-memory.js');

function setOverlaySeries({ modality = 'MR' } = {}) {
  storage.clear();
  state.manifest = {
    series: [{
      slug: 'toggle_persist',
      slices: 2,
      width: 2,
      height: 2,
      hasSeg: true,
      hasRegions: true,
      hasSym: true,
      modality,
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.overlays.tissue = false;
  state.overlays.labels = true;
  state.overlays.heatmap = false;
  state.overlays.regionMeta = {};
  state.segImgs = cachedOverlayStack('toggle_persist_seg', 2);
  state.regionImgs = cachedOverlayStack('toggle_persist_regions', 2);
  state.symImgs = cachedOverlayStack('toggle_persist_sym', 2);
  return state.manifest.series[0];
}

test('toggleSeriesOverlay speaks persist kinds and maps loader dirs internally', () => {
  setOverlaySeries();

  assert.equal(toggleSeriesOverlay('seg', ['labels']), null);
  assert.equal(state.overlays.tissue, false);
  assert.equal(state.overlays.labels, true);

  const overlays = toggleSeriesOverlay('tissue', ['labels']);
  assert.equal(overlays.tissue.enabled, true);
  assert.equal(overlays.labels.enabled, false);
  assert.equal(state.overlays.tissue, true);
  assert.equal(state.overlays.labels, false);

  const heatmap = toggleSeriesOverlay('heatmap');
  assert.equal(heatmap.heatmap.enabled, true);
  assert.equal(state.overlays.heatmap, true);
});

test('toggleSeriesOverlay refuses overlays the active series does not offer', () => {
  const series = setOverlaySeries();
  series.hasSym = false;
  state.symImgs = null;
  state.overlays.heatmap = false;

  assert.equal(toggleSeriesOverlay('heatmap'), null);
  assert.equal(state.overlays.heatmap, false);
  assert.equal(toggleSeriesOverlay('not-an-overlay'), null);
});

test('toggleSeriesOverlay records and forgets the per-modality overlay preference', () => {
  setOverlaySeries({ modality: 'CT' });
  state.overlays.labels = false;

  toggleSeriesOverlay('labels');
  assert.deepEqual(getPreferredOverlays('CT'), ['labels']);

  toggleSeriesOverlay('labels');
  assert.equal(state.overlays.labels, false);
  assert.deepEqual(getPreferredOverlays('CT'), []);
});

test('toggleSeriesOverlay remembers the overlay set in the per-series view memory', () => {
  const series = setOverlaySeries();
  state.overlays.tissue = false;
  state.overlays.labels = false;

  toggleSeriesOverlay('tissue');

  const remembered = state.seriesViewMemory?.[seriesViewMemoryKey(series)];
  assert.ok(remembered, 'expected toggling to write series view memory');
  assert.equal(remembered.overlays.tissue, true);
  assert.equal(remembered.overlays.labels, false);
});
