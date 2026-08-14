import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.self = {};
globalThis.voxellabDesktop = true;

const { loadFusion } = await import('../js/fusion-loader.js');
const { state } = await import('../js/core/state.js');

test('loadFusion reuses the active peer stack and voxel cache', async (t) => {
  const previousImage = globalThis.Image;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    constructor() {
      throw new Error('same fusion peer should not allocate a new image stack');
    }
  };

  const existing = [
    { complete: true, naturalWidth: 1 },
    { complete: false, naturalWidth: 0 },
    { complete: true, naturalWidth: 1 },
  ];
  existing._dir = 'fusion_peer';
  const voxels = new Uint8Array([1, 2, 3]);
  state.manifest = {
    series: [
      { slug: 'source', group: 'for-fusion', slices: 3 },
      { slug: 'fusion_peer', group: 'for-fusion', slices: 3 },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.mode = '2d';
  state.fusionSlug = 'fusion_peer';
  state.fusionImgs = existing;
  state.fusionVoxels = voxels;
  const existingFusionImgs = state.fusionImgs;

  await loadFusion('fusion_peer');

  assert.equal(state.fusionSlug, 'fusion_peer');
  assert.equal(state.fusionImgs, existingFusionImgs);
  assert.equal(state.fusionVoxels, voxels);
});
