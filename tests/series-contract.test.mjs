import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  applyPublicSeriesUrls,
  mergeSeriesIntoManifest,
  normalizeCloudSeriesEntry,
  normalizeCloudProjectionSetEntry,
  normalizeCloudUploadResult,
} = await import('../js/series/series-contract.js');

function validCloudSeries(overrides = {}) {
  return {
    slug: 'cloud_job123',
    name: 'Cloud CT',
    description: '2 slices',
    slices: 2,
    width: 4,
    height: 4,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    hasRaw: true,
    ...overrides,
  };
}

test('applyPublicSeriesUrls backfills trusted cloud asset paths from slug', () => {
  const entry = applyPublicSeriesUrls(validCloudSeries({ hasRegions: true }), 'https://r2.example/');

  assert.equal(entry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(entry.rawUrl, 'https://r2.example/cloud_job123.raw.zst');
  assert.equal(entry.regionUrlBase, 'https://r2.example/data/cloud_job123_regions');
  assert.equal(entry.regionMetaUrl, 'https://r2.example/data/cloud_job123_regions.json');
});

test('mergeSeriesIntoManifest does not treat sourceSeriesUID as an identity key', () => {
  const manifest = {
    patient: 'anonymous',
    studyDate: '',
    series: [{ slug: 'cloud_old', sourceSeriesUID: '1.2.3', name: 'Old' }],
  };

  const idx = mergeSeriesIntoManifest(manifest, {
    slug: 'cloud_new',
    sourceSeriesUID: '1.2.3',
    name: 'New',
  });

  assert.equal(idx, 1);
  assert.equal(manifest.series.length, 2);
  assert.equal(manifest.series[0].slug, 'cloud_old');
  assert.equal(manifest.series[1].slug, 'cloud_new');
  assert.equal(manifest.series[1].name, 'New');
});

test('normalizeCloudProjectionSetEntry accepts canonical reconstruction statuses and safe ids only', () => {
  const projectionSet = normalizeCloudProjectionSetEntry({
    id: 'projection_set_1',
    name: 'Projection Source',
    modality: 'XA',
    projectionKind: 'cbct',
    projectionCount: 2,
    reconstructionStatus: 'reconstruction-pending',
  }, { sourceProjectionSetId: 'projection_set_1' });

  assert.equal(projectionSet.reconstructionStatus, 'reconstruction-pending');
  assert.equal(projectionSet.slug, 'projection_set_1');
  assert.throws(
    () => normalizeCloudProjectionSetEntry({
      id: '../bad',
      name: 'Projection Source',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionStatus: 'reconstructed',
    }),
    /safe projection set id/i,
  );
});

test('normalizeCloudUploadResult binds job identity and projection-set linkage', () => {
  const result = normalizeCloudUploadResult({
    slug: 'cloud_projection_job123',
    projection_set_entry: {
      id: 'projection_set_1',
      name: 'Projection Source',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionStatus: 'requires-calibration',
    },
    series_entry: validCloudSeries({
      slug: 'cloud_projection_job123',
      name: 'Projection Result',
      description: 'Derived volume',
      geometryKind: 'derivedVolume',
      sourceProjectionSetId: 'projection_set_1',
    }),
  }, {
    jobId: 'job_123',
    publicBase: 'https://r2.example/',
    processing: {
      processingMode: 'projection_set_reconstruction',
      inputKind: 'calibrated_projection_source',
    },
  });

  assert.equal(result.slug, 'cloud_projection_job123');
  assert.equal(result.seriesEntry.sourceJobId, 'job_123');
  assert.deepEqual(result.seriesEntry.cloudAction, {
    id: 'cloud-projection-reconstruction',
    label: 'Cloud reconstruction',
    provider: 'modal',
    jobId: 'job_123',
    processingMode: 'projection_set_reconstruction',
    inputKind: 'calibrated_projection_source',
    resultSlug: 'cloud_projection_job123',
  });
  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_projection_job123');
  assert.equal(result.projectionSetEntry.id, 'projection_set_1');
});

test('normalizeCloudSeriesEntry defaults preview/context flags and rejects string booleans', () => {
  const entry = normalizeCloudSeriesEntry(validCloudSeries({ hasStats: true }), { publicBase: 'https://r2.example/' });

  assert.equal(entry.hasPreview, false);
  assert.equal(entry.hasContext, false);
  assert.equal(entry.hasAskHistory, false);
  assert.equal(entry.statsUrl, 'https://r2.example/data/cloud_job123_stats.json');
  assert.throws(
    () => normalizeCloudSeriesEntry(validCloudSeries({ hasContext: 'true' }), { publicBase: 'https://r2.example/' }),
    /hasContext must be a boolean/,
  );
  assert.throws(
    () => normalizeCloudSeriesEntry(validCloudSeries({ hasAskHistory: 'true' }), { publicBase: 'https://r2.example/' }),
    /hasAskHistory must be a boolean/,
  );
  assert.throws(
    () => normalizeCloudSeriesEntry(validCloudSeries({ hasPreview: 'false' }), { publicBase: 'https://r2.example/' }),
    /hasPreview must be a boolean/,
  );
  assert.throws(
    () => normalizeCloudSeriesEntry(validCloudSeries({ hasStats: true, statsUrl: 'https://evil.example/cloud_job123_stats.json' }), { publicBase: 'https://r2.example/' }),
    /stats origin/i,
  );
});
