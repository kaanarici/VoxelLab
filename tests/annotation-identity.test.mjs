import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { roiResultsBundle, validateRoiResultsBundleForSeries } = await import('../js/roi/roi-results.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');
const {
  NOTE_STORAGE_KEY,
  setNoteEntriesForSlice,
} = await import('../js/overlay/annotation-graph.js');

test('ROI bundles require the exact v2 series identity, not a matching slug', () => {
  const first = { slug: 't1', width: 128, height: 128, slices: 40, seriesUID: 'series-a' };
  const second = { slug: 't1', width: 128, height: 128, slices: 40, seriesUID: 'series-b' };
  const firstManifest = { patient: 'patient-a', studyUID: 'study-a', series: [first] };
  const secondManifest = { patient: 'patient-b', studyUID: 'study-b', series: [second] };

  state.manifest = firstManifest;
  state.seriesIdx = 0;
  const bundle = roiResultsBundle([], first);

  assert.equal(validateRoiResultsBundleForSeries(bundle, first, firstManifest).ok, true);
  assert.deepEqual(validateRoiResultsBundleForSeries(bundle, second, secondManifest), {
    ok: false,
    reason: 'series_identity_mismatch',
  });
  assert.deepEqual(validateRoiResultsBundleForSeries({ ...bundle, series: { slug: 't1' } }, second, secondManifest), {
    ok: false,
    reason: 'legacy_identity_unconfirmed',
  });
});

test('series persistence keys are fixed-size and do not expose source identity text', () => {
  storage.clear();
  const series = {
    slug: 'private_scan',
    width: 64,
    height: 64,
    slices: 3,
    sourceUrl: 'https://example.test/private.zarr?token=do-not-persist',
    microscopy: { sourceFiles: ['participant-secret-name.ome.tiff'] },
  };
  const key = seriesPersistenceKey(series, {
    patient: 'participant-secret-name',
    studyUID: '1.2.840.private-study',
  });

  assert.match(key, /^v2:[0-9a-f]{32}$/);
  assert.equal(key.includes('participant-secret-name'), false);
  assert.equal(key.includes('do-not-persist'), false);
  assert.notEqual(key, seriesPersistenceKey({ ...series, seriesUID: 'different-series' }, {
    patient: 'participant-secret-name',
    studyUID: '1.2.840.private-study',
  }));

  state.manifest = {
    patient: 'participant-secret-name',
    studyUID: '1.2.840.private-study',
    series: [series],
  };
  state.seriesIdx = 0;
  setNoteEntriesForSlice(state, series, 0, [{ id: 1, x: 1, y: 2, text: 'reviewed' }]);
  const persisted = storage.get(NOTE_STORAGE_KEY);
  const bundleIdentity = roiResultsBundle([], series).series.persistenceKey;
  for (const privateText of [
    'participant-secret-name',
    '1.2.840.private-study',
    'do-not-persist',
  ]) {
    assert.equal(persisted.includes(privateText), false);
    assert.equal(bundleIdentity.includes(privateText), false);
  }
});

test('microscopy persistence identity is stable across derived endpoint and active stack updates', () => {
  const series = {
    slug: 'micro_session_1',
    imageDomain: 'microscopy',
    width: 96,
    height: 64,
    slices: 3,
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.002,
    orientation: [1, 0, 0, 0, 1, 0],
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 0],
    microscopy: {
      sizeZ: 3,
      sourceFiles: ['cells_z001.tif', 'cells_z002.tif', 'cells_z003.tif'],
    },
    microscopyDataset: {
      axes: [{ name: 'z', size: 3 }],
      source: {
        originalFormat: 'TIFF sequence',
        files: ['cells_z001.tif', 'cells_z002.tif', 'cells_z003.tif'],
        signatures: [{ name: 'cells_z001.tif', byteLength: 64, sampleFingerprint: 'sample-v1:64:abc' }],
      },
    },
  };
  const manifest = { patient: 'anonymous', studyDate: '2026-07-19' };
  const before = seriesPersistenceKey(series, manifest);
  const after = seriesPersistenceKey({
    ...series,
    slices: 2,
    firstIPP: [0, 0, 123],
    lastIPP: [0, 0, 0.004],
  }, manifest);

  assert.equal(after, before);
  assert.notEqual(
    seriesPersistenceKey({ ...series, sliceSpacing: 0.003 }, manifest),
    before,
  );
});
