import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.document = { getElementById: () => null };
globalThis.self = globalThis;
globalThis.voxellabDesktop = true;

const { state } = await import('../js/core/state.js');
const { DEFAULT_PREFETCH_LIMIT } = await import('../js/core/constants.js');
const { RUNTIME_OVERLAY_TYPE_BY_KIND, dumpOverlayContract, overlayOutputLabel } = await import('../js/core/viewer-session-shape.js');
const { ensureOverlayStack, initOverlayStack } = await import('../js/overlay/overlay-stack.js');

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
  state.overlays.regionMeta = {};
  state.overlays.labels = true;

  await ensureOverlayStack('regions');

  assert.equal(prefetchOpts?.limit, DEFAULT_PREFETCH_LIMIT);
});

test('ensureOverlayStack refuses fusion instead of inventing a sidecar dir', async (t) => {
  const previousImage = globalThis.Image;
  t.after(() => {
    globalThis.Image = previousImage;
  });
  globalThis.Image = class {
    constructor() {
      throw new Error('ensureOverlayStack must not invent a fusion sidecar stack');
    }
  };

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

test('overlay stack cache keys are derived from persist-kind loader dirs', async () => {
  const { overlayImgsKey, overlayVoxelsKey, OVERLAY_CACHE_BY_TYPE } = await import('../js/runtime/overlay-cache-keys.js');
  assert.equal(overlayImgsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.tissue), 'segImgs');
  assert.equal(overlayImgsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.labels), 'regionImgs');
  assert.equal(overlayImgsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.heatmap), 'symImgs');
  assert.equal(overlayImgsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.fusion), 'fusionImgs');
  assert.equal(overlayImgsKey('tissue'), null);
  assert.equal(overlayVoxelsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.tissue), 'segVoxels');
  assert.equal(overlayVoxelsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.labels), 'regionVoxels');
  assert.equal(overlayVoxelsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.heatmap), 'symVoxels');
  assert.equal(overlayVoxelsKey(RUNTIME_OVERLAY_TYPE_BY_KIND.fusion), 'fusionVoxels');
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.kind, 'tissue');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.kind, 'labels');
  assert.equal(OVERLAY_CACHE_BY_TYPE.sym.kind, 'heatmap');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.kind, 'fusion');
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.bytes, 'segBytes');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.bytes, 'regionBytes');
  assert.equal(OVERLAY_CACHE_BY_TYPE.sym.bytes, 'symBytes');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.bytes, 'fusionBytes');
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.availableFlag, 'hasSeg');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.availableFlag, 'hasRegions');
  assert.equal(OVERLAY_CACHE_BY_TYPE.sym.availableFlag, 'hasSym');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.availableFlag, null);
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.packageAsset.kind, 'tissue-overlay');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.packageAsset.kind, 'anatomy-labels');
  assert.equal(OVERLAY_CACHE_BY_TYPE.sym.packageAsset.kind, 'symmetry-heatmap');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.packageAsset, null);
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.refuseInOverlayStack, true);
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.emptyImgs, false);
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.peerSlugField, 'fusionSlug');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.sample, 'linear');
  assert.equal(OVERLAY_CACHE_BY_TYPE.fusion.requiresCompleteSliceImage, true);
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.needsRegionMeta, true);
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.usesLocalRegionVolume, true);
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.sliceBytes, 'voxels');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.sample, 'nearest');
  assert.equal(OVERLAY_CACHE_BY_TYPE.regions.publicUrlBaseField, 'regionUrlBase');
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.sample, 'nearest');
  assert.equal(OVERLAY_CACHE_BY_TYPE.seg.refuseInOverlayStack, false);
  assert.equal(OVERLAY_CACHE_BY_TYPE.sym.sample, 'linear');
});

test('overlay contract dump lists refuse and sample flags without GPU texture slots', () => {
  const dump = dumpOverlayContract();
  const fusion = dump.overlays.find((row) => row.loaderDir === 'fusion');
  const regions = dump.overlays.find((row) => row.loaderDir === 'regions');
  assert.equal(fusion.refuseInOverlayStack, true);
  assert.equal(fusion.peerSlugField, 'fusionSlug');
  assert.equal(regions.needsRegionMeta, true);
  assert.equal(regions.publicUrlBaseField, 'regionUrlBase');
  assert.equal(overlayOutputLabel('tissue', 'short'), 'tissue');
  assert.equal(overlayOutputLabel('labels'), 'anatomy labels');
  assert.equal(JSON.stringify(dump).includes('texture'), false);
  assert.equal(JSON.stringify(dump).includes('sampler'), false);
});

test('ensureOverlayStack does not import sync, metadata, or volume-3d', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/overlay/overlay-stack.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*sync\.js['"]/.test(source), false);
  assert.equal(/from ['"].*metadata\.js['"]/.test(source), false);
  assert.equal(/from ['"].*volume-3d\.js['"]/.test(source), false);
});

test('ensureOverlayStack fires the injected redraw when a cached stack is ready', async () => {
  let ready = 0;
  initOverlayStack({ onReady: () => { ready += 1; } });

  const cached = new Array(3);
  cached._dir = 'redraw_regions_regions';
  cached.ensureIndex = () => Promise.resolve(true);
  cached.ensureWindow = () => {};
  cached.prefetchRemaining = () => Promise.resolve();

  state.manifest = {
    series: [{ slug: 'redraw_regions', slices: 3, width: 2, height: 2, hasRegions: true }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.mode = '2d';
  state.regionImgs = cached;
  state.overlays.regionMeta = {};
  state.overlays.labels = true;

  await ensureOverlayStack('regions');

  assert.equal(ready >= 1, true);
});
