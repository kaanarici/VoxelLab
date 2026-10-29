import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUD_OPTIONS,
  VALID_SERIES_ENTRY,
  freshCloudModule,
  installCloudTransport,
  sharedConfigModule,
} from './helpers/node/cloud-transport.mjs';

test('cloud upload rejects upload URLs outside the trusted allowlist', async (t) => {
  const previousFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://evil.example/upload'])) });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /untrusted origin/,
  );
});

test('cloud upload rejects presigned URLs that exceed the 15 minute expiry limit', async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm?expires=901'])),
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm', size: 1234 }]),
    /invalid expiry: 901s/,
  );
  assert.equal(calls.some(call => call.method === 'PUT'), false);
  assert.equal(calls.some(call => call.url.endsWith('/start_processing')), false);
});

test('cloud upload fails immediately on invalid complete payloads', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) {
      return Response.json({ status: 'complete', slug: 'cloud_job123', series_entry: { slug: 'broken' } });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing required series metadata/i,
  );
});

test('cloud upload rejects complete payloads without any trustworthy slug', async (t) => {
  installCloudTransport(t, async ({ url }, options = {}) => {
    if (String(url).endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (String(url) === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (String(url).endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (String(url).endsWith('/check_status')) return Response.json({ status: 'complete' });
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing a completed slug/i,
  );
});

test('cloud upload rejects complete payloads whose status slug disagrees with the trusted series entry', async (t) => {
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
        slug: 'cloud_wrong',
        series_entry: {
          ...VALID_SERIES_ENTRY,
          slug: 'cloud_job123',
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
    });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /slug mismatch/i,
  );
});

test('cloud upload rejects derived results that omit the projection set registry entry', async (t) => {
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
        slug: 'cloud_projection_job123',
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

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /missing projection set projection_set_1/i,
  );
});

test('cloud upload rejects projection set entries that do not match the derived result binding', async (t) => {
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
        slug: 'cloud_projection_job123',
        projection_set_entry: {
          id: 'projection_set_wrong',
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

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /projection set id mismatch/i,
  );
});

test('local cloud proxy requests include the same-origin runtime token header', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/config.local.json') || String(url).endsWith('./config.local.json')) {
      return new Response('', { status: 404 });
    }
    if (String(url).endsWith('/config.json') || String(url).endsWith('./config.json')) {
      return Response.json({ localApiToken: 'local-token-123' });
    }
    assert.fail(`unexpected config fetch ${url}`);
  };
  const config = await sharedConfigModule();
  await config.loadConfig();

  const { calls } = installCloudTransport(t, async ({ url }, options = {}) => {
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
  cloud.initCloud('/api/cloud', 'https://r2.example/', CLOUD_OPTIONS);

  await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]);

  const proxyCalls = calls.filter(call => call.url.startsWith('/api/cloud/'));
  assert.equal(proxyCalls.length, 3);
  assert.deepEqual(
    proxyCalls.map(call => call.headers['X-VoxelLab-Local-Token']),
    ['local-token-123', 'local-token-123', 'local-token-123'],
  );
  const uploadCall = calls.find(call => call.method === 'PUT');
  assert.equal(uploadCall?.headers['X-VoxelLab-Local-Token'], undefined);
});
