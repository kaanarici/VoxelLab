import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlayKindsForSeries } from '../js/runtime/overlay-kinds.js';
import {
  CLOUD_OPTIONS,
  VALID_SERIES_ENTRY,
  freshCloudModule,
  installCloudTransport,
} from './helpers/node/cloud-transport.mjs';

test('cloud upload completion fetches the processed manifest entry from R2', async (t) => {
  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') {
      return new Response('', { status: 200 });
    }
    if (String(url).endsWith('/start_processing')) {
      return Response.json({ status: 'started' });
    }
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123' });
    }
    if (String(url).startsWith('https://r2.example/results/')) {
      return Response.json({ ...VALID_SERIES_ENTRY });
    }
    return new Response('not found', { status: 404 });
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.sourceJobId, result.jobId);
  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(calls.find(c => c.url === 'https://upload.example/slice-1.dcm')?.method, 'PUT');
  const startBody = JSON.parse(calls.find(c => c.url.endsWith('/start_processing'))?.body);
  assert.deepEqual(Object.keys(startBody).sort(), ['job_id', 'modality', 'total_upload_bytes']);
  assert.equal(startBody.modality, 'auto');
  assert.equal(startBody.total_upload_bytes, 0);
  const statusBody = JSON.parse(calls.find(c => c.url.endsWith('/check_status'))?.body);
  assert.deepEqual(statusBody, { job_id: result.jobId });
  assert.ok(calls.some(c => c.url.startsWith('https://r2.example/results/')));
});

test('cloud upload matches the signer content-type contract for DICOM and source manifests', async (t) => {
  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) return Response.json({ status: 'complete', slug: 'cloud_job123' });
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([
    { name: 'slice-1.dcm', size: 123, type: 'application/octet-stream' },
    { name: 'voxellab.source.json', size: 45, type: 'text/plain' },
  ]);

  const dicomPut = calls.find((call) => call.url === 'https://upload.example/slice-1.dcm');
  const manifestPut = calls.find((call) => call.url === 'https://upload.example/voxellab.source.json');

  assert.equal(dicomPut.headers['Content-Type'], 'application/dicom');
  assert.equal(manifestPut.headers['Content-Type'], 'application/json');
  const presignBody = JSON.parse(calls.find((call) => call.url.endsWith('/get_upload_urls')).body);
  assert.deepEqual(presignBody.items, [
    { upload_id: 'f000000', filename: 'slice-1.dcm', size_bytes: 123 },
    { upload_id: 'f000001', filename: 'voxellab.source.json', size_bytes: 45 },
  ]);
});

test('cloud upload still completes when no public R2 base is configured', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') {
      return new Response('', { status: 200 });
    }
    if (String(url).endsWith('/start_processing')) {
      return Response.json({ status: 'started' });
    }
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123' });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.slug, 'cloud_job123');
  assert.equal(result.seriesEntry, null);
});

test('cloud endpoints derive deployed Modal function URLs from app prefix', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('https://example-org--medical-imaging-pipeline', '', CLOUD_OPTIONS);

  assert.equal(
    cloud.cloudEndpoint('get_upload_urls'),
    'https://example-org--medical-imaging-pipeline-get-upload-urls.modal.run',
  );
  assert.equal(
    cloud.cloudEndpoint('check_status'),
    'https://example-org--medical-imaging-pipeline-check-status.modal.run',
  );
});

test('cloudProcessing=false disables cloud upload even when endpoints are configured', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('/api/cloud', 'https://r2.example/', {
    ...CLOUD_OPTIONS,
    enabled: false,
  });

  assert.equal(cloud.isCloudAvailable(), false);
  assert.deepEqual(cloud.cloudRuntimeStatus(), {
    available: false,
    code: 'disabled',
    message: 'Cloud GPU processing is disabled.',
  });
  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /not fully configured/i,
  );
});

test('cloud runtime status names setup and ready states', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('', '', CLOUD_OPTIONS);
  assert.deepEqual(cloud.cloudRuntimeStatus(), {
    available: false,
    code: 'setup-required',
    message: 'Cloud GPU processing needs Modal webhook settings.',
  });

  cloud.initCloud('/api/cloud', '', { trustedUploadOrigins: [] });
  assert.deepEqual(cloud.cloudRuntimeStatus(), {
    available: false,
    code: 'storage-required',
    message: 'Cloud GPU processing needs the trusted R2 S3 upload origin.',
  });

  cloud.initCloud('/api/cloud', 'https://public-results.example/', { trustedUploadOrigins: [] });
  assert.equal(cloud.cloudRuntimeStatus().available, false);

  cloud.initCloud('/api/cloud', 'https://r2.example/', CLOUD_OPTIONS);
  assert.deepEqual(cloud.cloudRuntimeStatus(), {
    available: true,
    code: 'ready',
    message: 'Cloud GPU processing is ready.',
  });
});

test('cloud upload can request calibrated projection-set reconstruction mode', async (t) => {
  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_projection_job123',
        projection_set_entry: {
          id: 'projection_set_1',
          name: 'Projection Source',
          modality: 'XA',
          projectionKind: 'cbct',
          projectionCount: 2,
          reconstructionStatus: 'requires-calibration',
        },
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_projection_job123',
          name: 'Projection Result',
          description: 'Derived volume',
          geometryKind: 'derivedVolume',
          sourceProjectionSetId: 'projection_set_1',
          sliceUrlBase: 'https://r2.example/data/cloud_projection_job123',
          rawUrl: 'https://r2.example/cloud_projection_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess(
    [{ name: 'projection-1.dcm' }, { name: 'projection-2.dcm' }],
    () => {},
    {
      processingMode: 'projection_set_reconstruction',
      inputKind: 'calibrated_projection_set',
    },
  );

  const startBody = JSON.parse(calls.find(call => call.url.endsWith('/start_processing'))?.body);
  assert.equal(startBody.modality, 'auto');
  assert.equal(startBody.total_upload_bytes, 0);
  assert.equal(startBody.processing_mode, 'projection_set_reconstruction');
  assert.equal(startBody.input_kind, 'calibrated_projection_set');
  assert.equal(result.seriesEntry.geometryKind, 'derivedVolume');
  assert.deepEqual(result.seriesEntry.cloudAction, {
    id: 'cloud-projection-reconstruction',
    label: 'Cloud reconstruction',
    provider: 'modal',
    jobId: result.jobId,
    processingMode: 'projection_set_reconstruction',
    inputKind: 'calibrated_projection_set',
    resultSlug: 'cloud_projection_job123',
  });
  assert.equal(result.seriesEntry.sourceProjectionSetId, 'projection_set_1');
  assert.equal(result.projectionSetEntry.id, 'projection_set_1');
  assert.equal(result.projectionSetEntry.projectionKind, 'cbct');
});

test('cloud upload uses trusted series entry returned by Modal status when present', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.sliceUrlBase, 'https://r2.example/data/cloud_job123');
  assert.equal(result.seriesEntry.rawUrl, 'https://r2.example/cloud_job123.raw.zst');
  assert.equal(result.seriesEntry.sourceJobId, result.jobId);
});

test('cloud upload preserves explicit job identity fields returned by Modal', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sourceJobId: 'modal_job_identity',
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.sourceJobId, 'modal_job_identity');
});

test('cloud upload backfills trusted region overlay URLs for cloud results', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          hasRegions: true,
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  assert.equal(result.seriesEntry.regionUrlBase, 'https://r2.example/data/cloud_job123_regions');
  assert.equal(result.seriesEntry.regionMetaUrl, 'https://r2.example/data/cloud_job123_regions.json');
});

test('cloud normalization exposes canonical overlay kinds without changing legacy manifest flags', async () => {
  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const series = cloud.ingestCloudSeriesEntry({
    ...VALID_SERIES_ENTRY,
    hasSeg: true,
    hasRegions: true,
    hasSym: true,
  }, { publicBase: 'https://r2.example/' });
  const overlays = overlayKindsForSeries(series);

  assert.equal(series.hasSeg, true);
  assert.equal(series.hasRegions, true);
  assert.equal(series.hasSym, true);
  assert.deepEqual(overlays.availableKinds, ['tissue', 'labels', 'heatmap']);
  assert.equal(overlays.byKind.tissue.available, true);
  assert.equal(overlays.byKind.labels.available, true);
  assert.equal(overlays.byKind.heatmap.available, true);
  assert.equal('source' in overlays.byKind.tissue, false);
});

test('cloud upload requests presigned URLs in batches and uploads every file before starting', async (t) => {
  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, `https://upload.example/${item.filename}`])),
      });
    }
    if (String(url).startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);
  const files = Array.from({ length: 501 }, (_, index) => ({ name: `slice-${index}.dcm` }));

  await cloud.uploadAndProcess(files);

  const urlRequests = calls.filter(call => call.url.endsWith('/get_upload_urls'));
  const putRequests = calls.filter(call => call.method === 'PUT');
  const startIndex = calls.findIndex(call => call.url.endsWith('/start_processing'));
  const lastPutIndex = Math.max(...calls.map((call, index) => call.method === 'PUT' ? index : -1));

  assert.deepEqual(urlRequests.map(call => JSON.parse(call.body).items.length), [450, 51]);
  assert.equal(putRequests.length, 501);
  assert.ok(startIndex > lastPutIndex);
});

test('cloud upload aborts before Modal processing when an R2 PUT fails', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 403 });
    if (String(url).endsWith('/start_processing')) assert.fail('processing should not start after failed upload');
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /Failed to upload slice-1\.dcm: 403/,
  );
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload aborts before Modal processing when a presigned URL is missing', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) return Response.json({ urls: {} });
    if (String(url).endsWith('/start_processing')) assert.fail('processing should not start without all upload URLs');
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /Missing upload URL for slice-1\.dcm/,
  );
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload keeps duplicate basenames distinct with upload ids', async (t) => {
  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.items.map(item => item.filename), ['IM0001', 'IM0001']);
      assert.deepEqual(body.items.map(item => item.upload_id), ['f000000', 'f000001']);
      return Response.json({
        urls: {
          f000000: 'https://upload.example/a',
          f000001: 'https://upload.example/b',
        },
      });
    }
    if (String(url) === 'https://upload.example/a') return new Response('', { status: 200 });
    if (String(url) === 'https://upload.example/b') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([{ name: 'IM0001' }, { name: 'IM0001' }]);

  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
});

test('cloud upload fails fast on sustained status-check transport failures', async (t) => {
  let statusChecks = 0;

  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) { statusChecks++; return new Response('bad gateway', { status: 502 }); }
    return new Response('not found', { status: 404 });
  });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    (error) => /kept failing/.test(error.message) && /502/.test(error.message),
  );

  assert.equal(statusChecks, 12);
});
