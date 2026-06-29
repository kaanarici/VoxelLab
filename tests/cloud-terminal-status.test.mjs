/* global Response, URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const CLOUD_OPTIONS = { trustedUploadOrigins: ['https://upload.example'] };
const VALID_SERIES_ENTRY = {
  slug: 'cloud_job123',
  name: 'Cloud CT',
  description: '2 slices',
  slices: 2,
  width: 4,
  height: 4,
  pixelSpacing: [1, 1],
  sliceThickness: 1,
  hasRaw: true,
};

async function freshCloudModule() {
  const url = new URL(`../js/cloud.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

function installFastTimers(t) {
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  t.after(() => {
    globalThis.setTimeout = previousSetTimeout;
  });
}

function installCloudFetch(t, statusFactory) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/get_upload_urls')) {
      const body = JSON.parse(options.body);
      return Response.json({ urls: Object.fromEntries(body.items.map(item => [item.upload_id, 'https://upload.example/slice-1.dcm'])) });
    }
    if (href === 'https://upload.example/slice-1.dcm') return new Response('', { status: 200 });
    if (href.endsWith('/start_processing')) return Response.json({ status: 'started' });
    if (href.endsWith('/check_status')) return Response.json(statusFactory());
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
}

test('cloud upload imports partial terminal results when a series entry is available', async (t) => {
  const progress = [];
  installFastTimers(t);
  installCloudFetch(t, () => ({ status: 'partial', slug: 'cloud_job123', series_entry: { ...VALID_SERIES_ENTRY } }));

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);

  const result = await cloud.uploadAndProcess([{ name: 'slice-1.dcm' }], (stage, detail) => {
    progress.push({ stage, detail });
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.slug, 'cloud_job123');
  assert.equal(result.seriesEntry.cloudAction.resultStatus, 'partial');
  assert.equal(progress.at(-1).stage, 'partial');
});

test('cloud upload fails immediately on failed terminal status', async (t) => {
  let statusCalls = 0;
  installFastTimers(t);
  installCloudFetch(t, () => {
    statusCalls += 1;
    return { status: 'failed', error: 'segmentation crashed' };
  });

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', '', CLOUD_OPTIONS);

  await assert.rejects(
    () => cloud.uploadAndProcess([{ name: 'slice-1.dcm' }]),
    /Cloud job failed: segmentation crashed/,
  );
  assert.equal(statusCalls, 1);
});
