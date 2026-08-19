import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.document = { getElementById: () => null };
globalThis.self = globalThis;
globalThis.voxellabDesktop = true;

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { toggleSeriesOverlay } = await import('../js/overlay/overlay-toggle.js');

function cachedStack(dir, slices) {
  const cached = new Array(slices);
  cached._dir = dir;
  cached.ensureIndex = () => Promise.resolve(true);
  cached.ensureWindow = () => {};
  cached.prefetchRemaining = () => Promise.resolve();
  return cached;
}

function setOverlaySeries() {
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
      modality: 'MR',
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.overlays.tissue = false;
  state.overlays.labels = true;
  state.overlays.heatmap = false;
  state.overlays.regionMeta = {};
  state.segImgs = cachedStack('toggle_persist_seg', 2);
  state.regionImgs = cachedStack('toggle_persist_regions', 2);
  state.symImgs = cachedStack('toggle_persist_sym', 2);
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

test('toggleSeriesOverlay does not own a 3D voxel refresh', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/overlay/overlay-toggle.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*volume-3d\.js['"]/.test(source), false);
  assert.equal(/ensureVoxels/.test(source), false);
  assert.equal(/updateLabelTexture/.test(source), false);
});

test('toggleSeriesOverlay does not import sync or compare', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/overlay/overlay-toggle.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*sync\.js['"]/.test(source), false);
  assert.equal(/from ['"].*compare\.js['"]/.test(source), false);
  assert.equal(/syncOverlays/.test(source), false);
  assert.equal(/loadComparePeers/.test(source), false);
});
