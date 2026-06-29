/* global Response, URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const CLOUD_OPTIONS = { trustedUploadOrigins: ['https://upload.example'] };

async function freshCloudModule() {
  const url = new URL(`../js/cloud.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

test('cloud upload can request rigid registration mode', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
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
        slug: 'cloud_reg_job123',
        series_entry: {
          slug: 'cloud_reg_job123',
          name: 'Registered moving',
          description: 'Derived registration volume',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          geometryKind: 'derivedVolume',
          sliceUrlBase: 'https://r2.example/data/cloud_reg_job123',
          rawUrl: 'https://r2.example/cloud_reg_job123.raw.zst',
          registration: { source: 'modal:rigid_registration', verdict: 'aligned' },
        },
      });
    }
    assert.fail(`unexpected fetch ${options.method || 'GET'} ${url}`);
  };

  const cloud = await freshCloudModule();
  cloud.initCloud('https://modal.example/', 'https://r2.example/', CLOUD_OPTIONS);
  const result = await cloud.uploadAndProcess(
    [{ name: 'fixed-1.dcm' }, { name: 'moving-1.dcm' }, { name: 'voxellab.source.json' }],
    () => {},
    { processingMode: 'rigid_registration', inputKind: 'dicom_registration_pair' },
  );

  const startBody = JSON.parse(calls.find(call => call.url.endsWith('/start_processing'))?.body);
  assert.equal(startBody.processing_mode, 'rigid_registration');
  assert.equal(startBody.input_kind, 'dicom_registration_pair');
  assert.deepEqual(result.seriesEntry.cloudAction, {
    id: 'cloud-rigid-registration',
    label: 'Cloud registration/alignment',
    provider: 'modal',
    jobId: result.jobId,
    processingMode: 'rigid_registration',
    inputKind: 'dicom_registration_pair',
    resultSlug: 'cloud_reg_job123',
  });
  assert.equal(result.seriesEntry.registration.source, 'modal:rigid_registration');
});
