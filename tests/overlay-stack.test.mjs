import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.document = { getElementById: () => null };
globalThis.self = globalThis;
globalThis.voxellabDesktop = true;

const { state } = await import('../js/core/state.js');
const { DEFAULT_PREFETCH_LIMIT } = await import('../js/core/constants.js');
const { ensureOverlayStack } = await import('../js/overlay/overlay-stack.js');

test('ensureOverlayStack restores local region metadata when reusing a cached label stack', async () => {
  const regionMeta = { regions: { 7: { name: 'Thalamus' } }, colors: { 7: [1, 2, 3] } };
  const cached = new Array(3);
  cached._dir = 'cached_regions_regions';
  cached.ensureIndex = () => Promise.resolve(true);
  cached.ensureWindow = () => {};
  cached.prefetchRemaining = () => Promise.resolve();

  state.manifest = {
    series: [{ slug: 'cached_regions', slices: 3, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.mode = 'noop';
  state.regionImgs = cached;
  state.regionMeta = null;
  state.useRegions = true;
  state._localRegionMetaBySlug = { cached_regions: regionMeta };

  await ensureOverlayStack('regions');

  assert.equal(state.regionImgs._dir, cached._dir);
  assert.equal(state.regionMeta?.regions?.['7']?.name, 'Thalamus');
  assert.equal(state.regionMeta?.legend?.['7'], 'Thalamus');
});

test('ensureOverlayStack caps local overlay background prefetch', async () => {
  let prefetchOpts = null;
  const cached = new Array(100);
  cached._dir = 'local_labels_regions';
  cached.ensureIndex = () => Promise.resolve(true);
  cached.ensureWindow = () => {};
  cached.prefetchRemaining = (_center, _radius, opts) => {
    prefetchOpts = opts;
    return Promise.resolve();
  };

  state.manifest = {
    series: [{ slug: 'local_labels', slices: 100, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 50;
  state.regionImgs = cached;
  state.regionMeta = {};
  state.useRegions = true;

  await ensureOverlayStack('regions');

  assert.equal(prefetchOpts?.limit, DEFAULT_PREFETCH_LIMIT);
});
