import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_OVERLAY_TYPE_BY_KIND,
  dumpOverlayContract,
  overlayOutputLabel,
} from '../js/core/viewer-session-shape.js';
import {
  OVERLAY_CACHE_BY_KIND,
  OVERLAY_CACHE_BY_TYPE,
  overlayBytesFromCaches,
  overlayBytesPresent,
  overlayImgsKey,
  overlayVoxelsKey,
} from '../js/runtime/overlay-cache-keys.js';

const CONTRACT_ROWS = new Map(dumpOverlayContract().overlays.map(row => [row.loaderDir, row]));

test('every overlay cache entry stays derived from the shared overlay contract', () => {
  assert.deepEqual([...Object.keys(OVERLAY_CACHE_BY_TYPE)].sort(), [...CONTRACT_ROWS.keys()].sort());
  for (const [loaderDir, cache] of Object.entries(OVERLAY_CACHE_BY_TYPE)) {
    const row = CONTRACT_ROWS.get(loaderDir);
    assert.equal(cache.type, loaderDir);
    assert.equal(cache.kind, row.persistKind);
    for (const field of ['imgs', 'voxels', 'bytes', 'availableFlag', 'refuseInOverlayStack', 'needsRegionMeta', 'usesLocalRegionVolume', 'sliceBytes', 'requiresCompleteSliceImage', 'emptyImgs', 'sample', 'peerSlugField', 'publicUrlBaseField', 'publicMetaUrlField']) {
      assert.deepEqual(cache[field], row[field], `${loaderDir}.${field} drifted from the overlay contract`);
    }
  }
});

test('overlay cache lookups speak loader dirs, not persist kinds', () => {
  for (const [kind, loaderDir] of Object.entries(RUNTIME_OVERLAY_TYPE_BY_KIND)) {
    const cache = OVERLAY_CACHE_BY_TYPE[loaderDir];
    assert.equal(overlayImgsKey(loaderDir), cache.imgs);
    assert.equal(overlayVoxelsKey(loaderDir), cache.voxels);
    assert.equal(OVERLAY_CACHE_BY_KIND[kind], cache);
    if (kind === loaderDir) continue;
    assert.equal(overlayImgsKey(kind), null, `${kind} is a persist kind and must not resolve as a loader dir`);
    assert.equal(overlayVoxelsKey(kind), null);
  }
  assert.equal(overlayImgsKey('not-an-overlay'), null);
});

test('only packaged overlay kinds carry a package asset descriptor', () => {
  const packaged = Object.values(OVERLAY_CACHE_BY_TYPE)
    .filter(cache => cache.packageAsset)
    .map(cache => [cache.kind, cache.packageAsset.kind]);
  assert.deepEqual(packaged.sort(), [
    ['heatmap', 'symmetry-heatmap'],
    ['labels', 'anatomy-labels'],
    ['tissue', 'tissue-overlay'],
  ]);
  assert.equal(OVERLAY_CACHE_BY_KIND.fusion.packageAsset, null);
  for (const cache of Object.values(OVERLAY_CACHE_BY_TYPE)) {
    if (!cache.packageAsset) continue;
    assert.ok(cache.packageAsset.label, `${cache.kind} package asset needs a user-facing label`);
  }
});

test('overlay byte collection walks the cache table instead of a fixed kind ladder', () => {
  const readBytes = cache => (cache.kind === 'labels' ? new Uint8Array([1]) : null);
  const collected = overlayBytesFromCaches(readBytes);

  assert.deepEqual(
    [...Object.keys(collected)].sort(),
    Object.values(OVERLAY_CACHE_BY_KIND).map(cache => cache.bytes).sort(),
  );
  assert.equal(overlayBytesPresent(collected), true);
  assert.equal(overlayBytesPresent(overlayBytesFromCaches(() => null)), false);
  assert.equal(overlayBytesPresent({}), false);
});

test('overlay contract dump exposes loader behaviour without GPU texture slots', () => {
  const dump = dumpOverlayContract();
  const fusion = dump.overlays.find(row => row.loaderDir === 'fusion');
  const regions = dump.overlays.find(row => row.loaderDir === 'regions');

  assert.equal(fusion.refuseInOverlayStack, true);
  assert.equal(fusion.peerSlugField, 'fusionSlug');
  assert.equal(regions.needsRegionMeta, true);
  assert.equal(regions.publicUrlBaseField, 'regionUrlBase');
  assert.equal(overlayOutputLabel('tissue', 'short'), 'tissue');
  assert.equal(overlayOutputLabel('labels'), 'anatomy labels');
  assert.equal(JSON.stringify(dump).includes('texture'), false);
  assert.equal(JSON.stringify(dump).includes('sampler'), false);
});
