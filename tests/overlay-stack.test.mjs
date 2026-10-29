import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedOverlayStack, forbidImageAllocation } from './helpers/node/overlay-stacks.mjs';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

installViewerGlobals({ desktop: true });

const { state } = await import('../js/core/state.js');
const { DEFAULT_PREFETCH_LIMIT } = await import('../js/core/constants.js');
const { ensureOverlayStack, initOverlayStack } = await import('../js/overlay/overlay-stack.js');

test('ensureOverlayStack restores local region metadata when reusing a cached label stack', async () => {
  const regionMeta = { regions: { 7: { name: 'Thalamus' } }, colors: { 7: [1, 2, 3] } };
  const cached = cachedOverlayStack('cached_regions_regions', 3);

  state.manifest = {
    series: [{ slug: 'cached_regions', slices: 3, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.mode = 'noop';
  state.regionImgs = cached;
  state.overlays.regionMeta = null;
  state.overlays.labels = true;
  state._localRegionMetaBySlug = { cached_regions: regionMeta };

  await ensureOverlayStack('regions');

  assert.equal(state.regionImgs._dir, cached._dir);
  assert.equal(state.overlays.regionMeta?.regions?.['7']?.name, 'Thalamus');
  assert.equal(state.overlays.regionMeta?.legend?.['7'], 'Thalamus');
});

test('ensureOverlayStack caps local overlay background prefetch', async () => {
  let prefetchOpts = null;
  const cached = cachedOverlayStack('local_labels_regions', 100, {
    onPrefetch: ({ opts }) => { prefetchOpts = opts; },
  });

  state.manifest = {
    series: [{ slug: 'local_labels', slices: 100, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 50;
  state.regionImgs = cached;
  state.overlays.regionMeta = {};
  state.overlays.labels = true;

  await ensureOverlayStack('regions');

  assert.equal(prefetchOpts?.limit, DEFAULT_PREFETCH_LIMIT);
});

test('ensureOverlayStack refuses fusion instead of inventing a sidecar dir', async (t) => {
  forbidImageAllocation(t, 'ensureOverlayStack must not invent a fusion sidecar stack');

  const existing = new Array(2);
  existing._dir = 'fusion_peer';
  existing.ensureIndex = () => Promise.resolve(true);

  state.manifest = {
    series: [
      { slug: 'fusion_src', slices: 2, width: 2, height: 2 },
      { slug: 'fusion_peer', slices: 2, width: 2, height: 2 },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.overlays.fusionSlug = 'fusion_peer';
  state.fusionImgs = existing;

  const ok = await ensureOverlayStack('fusion');

  assert.equal(ok, false);
  assert.equal(state.fusionImgs._dir, 'fusion_peer');
  assert.notEqual(state.fusionImgs._dir, 'fusion_src_fusion');
});

test('ensureOverlayStack fires the injected redraw when a cached stack is ready', async () => {
  let ready = 0;
  initOverlayStack({ onReady: () => { ready += 1; } });

  state.manifest = {
    series: [{ slug: 'redraw_regions', slices: 3, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.mode = '2d';
  state.regionImgs = cachedOverlayStack('redraw_regions_regions', 3);
  state.overlays.regionMeta = {};
  state.overlays.labels = true;

  await ensureOverlayStack('regions');

  assert.equal(ready >= 1, true);
});
