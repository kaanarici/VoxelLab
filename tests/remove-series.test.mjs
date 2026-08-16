import assert from 'node:assert/strict';
import { test } from 'node:test';

const { state } = await import('../js/core/state.js');
const { removeSeriesFromViewer } = await import('../js/series/remove-series.js');

function series(slug, extra = {}) {
  return {
    slug,
    name: slug,
    width: 2,
    height: 2,
    slices: 2,
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    orientation: [1, 0, 0, 0, 1, 0],
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    ...extra,
  };
}

test('removeSeriesFromViewer clears selected runtime data and forgets its desktop import', async () => {
  const originalManifest = state.manifest;
  const originalSeriesIdx = state.seriesIdx;
  const originalVolumeCache = state._seriesVolumeCacheEntries;
  const originalRawOrder = state._localRawVolumeOrder;
  const originalSelectRequestId = state.selectRequestId;
  const originalFusionSlug = state.fusionSlug;
  const originalFusionImgs = state.fusionImgs;
  const originalFusionVoxels = state.fusionVoxels;
  const originalDesktop = globalThis.voxellabDesktop;
  const removed = series('remove-me', {
    _desktopImportId: 'import-0123456789abcdef01234567',
    sourceProjectionSetId: 'projection-remove-me',
  });
  const retained = series('keep-me');
  const forgotten = [];
  const updates = [];
  const refreshes = [];
  try {
    state.manifest = {
      series: [removed, retained],
      projectionSets: [{ id: 'projection-remove-me' }],
    };
    state.seriesIdx = 1;
    state._localStacks[removed.slug] = [{ complete: true }];
    state._localRawVolumes[removed.slug] = new Float32Array(8);
    state._localRawVolumeOrder = [removed.slug];
    state._seriesVolumeCacheEntries = [{ slug: removed.slug }, { slug: retained.slug }];
    state.fusionSlug = removed.slug;
    state.fusionImgs = [{ complete: true }];
    state.fusionVoxels = new Uint8Array(8);
    globalThis.voxellabDesktop = {
      async removeImportedSeries(ids) {
        forgotten.push(ids);
        return true;
      },
    };

    const result = await removeSeriesFromViewer(removed.slug, {
      onUpdate: async index => updates.push(index),
      refreshActiveView: async index => refreshes.push(index),
      removeFromProjects: async () => {},
    });

    assert.deepEqual(result, { removed: 1, remaining: 1 });
    assert.deepEqual(state.manifest.series.map(item => item.slug), [retained.slug]);
    assert.deepEqual(state.manifest.projectionSets, []);
    assert.equal(state.seriesIdx, 0);
    assert.equal(state._localStacks[removed.slug], undefined);
    assert.equal(state._localRawVolumes[removed.slug], undefined);
    assert.deepEqual(state._localRawVolumeOrder, []);
    assert.deepEqual(state._seriesVolumeCacheEntries.map(item => item.slug), [retained.slug]);
    assert.equal(state.fusionSlug, null);
    assert.equal(state.fusionImgs, null);
    assert.equal(state.fusionVoxels, null);
    assert.deepEqual(forgotten, [['import-0123456789abcdef01234567']]);
    assert.deepEqual(refreshes, [0]);
    assert.deepEqual(updates, [0]);
  } finally {
    state.manifest = originalManifest;
    state.seriesIdx = originalSeriesIdx;
    state._seriesVolumeCacheEntries = originalVolumeCache;
    state._localRawVolumeOrder = originalRawOrder;
    state.selectRequestId = originalSelectRequestId;
    state.fusionSlug = originalFusionSlug;
    state.fusionImgs = originalFusionImgs;
    state.fusionVoxels = originalFusionVoxels;
    delete state._localStacks[removed.slug];
    delete state._localRawVolumes[removed.slug];
    globalThis.voxellabDesktop = originalDesktop;
  }
});

test('removeSeriesFromViewer completes removal when folder cleanup is unavailable', async () => {
  const originalManifest = state.manifest;
  const originalSeriesIdx = state.seriesIdx;
  const originalSelectRequestId = state.selectRequestId;
  const originalDesktop = globalThis.voxellabDesktop;
  const originalWarn = console.warn;
  const removed = series('remove-me', { _desktopImportId: 'import-aaaaaaaaaaaaaaaaaaaaaaaa' });
  const retained = series('keep-me');
  const refreshed = [];
  const warnings = [];
  try {
    state.manifest = { series: [retained, removed] };
    state.seriesIdx = 0;
    globalThis.voxellabDesktop = { removeImportedSeries: async () => true };
    console.warn = (...args) => warnings.push(args);

    const result = await removeSeriesFromViewer(removed.slug, {
      onUpdate: async () => {},
      refreshActiveView: async index => refreshed.push(index),
      removeFromProjects: async () => { throw new Error('IndexedDB unavailable'); },
    });

    assert.deepEqual(result, { removed: 1, remaining: 1, organizationCleanupFailed: true });
    assert.deepEqual(state.manifest.series.map(item => item.slug), [retained.slug]);
    assert.deepEqual(refreshed, [0]);
    assert.match(String(warnings[0]?.[0]), /Series removal cleanup failed/);
  } finally {
    state.manifest = originalManifest;
    state.seriesIdx = originalSeriesIdx;
    state.selectRequestId = originalSelectRequestId;
    globalThis.voxellabDesktop = originalDesktop;
    console.warn = originalWarn;
  }
});

test('removeSeriesFromViewer leaves viewer state unchanged when desktop persistence fails', async () => {
  const originalManifest = state.manifest;
  const originalSeriesIdx = state.seriesIdx;
  const originalDesktop = globalThis.voxellabDesktop;
  const removed = series('remove-me', { _desktopImportId: 'import-bbbbbbbbbbbbbbbbbbbbbbbb' });
  const retained = series('keep-me');
  let projectCleanupCalls = 0;
  try {
    state.manifest = { series: [retained, removed] };
    state.seriesIdx = 0;
    globalThis.voxellabDesktop = {
      async removeImportedSeries(ids) {
        assert.deepEqual(ids, ['import-bbbbbbbbbbbbbbbbbbbbbbbb']);
        throw new Error('saved import store unavailable');
      },
    };

    await assert.rejects(
      removeSeriesFromViewer(removed.slug, {
        removeFromProjects: async () => { projectCleanupCalls += 1; },
      }),
      /saved import store unavailable/,
    );

    assert.deepEqual(state.manifest.series.map(item => item.slug), [retained.slug, removed.slug]);
    assert.equal(projectCleanupCalls, 0);
  } finally {
    state.manifest = originalManifest;
    state.seriesIdx = originalSeriesIdx;
    globalThis.voxellabDesktop = originalDesktop;
  }
});
