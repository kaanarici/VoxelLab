import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  acceleratePolling,
  openAdvancedOptions,
  openEmptyStudyUploadModal as openUploadModal,
  routeConfig,
  routeManifest,
} from '../helpers/browser/app.mjs';
import { writeTinyDicom, writeTinyDicomStack } from '../helpers/browser/fixtures/dicom.mjs';
import { writeTinyNifti } from '../helpers/browser/fixtures/nifti.mjs';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5WZ1AAAAAASUVORK5CYII=';

async function routeTinyPngStack(page, slug, slices = 1) {
  const body = Buffer.from(TINY_PNG_BASE64, 'base64');
  await page.route(`**/data/${slug}/*.png`, async (route) => {
    const file = route.request().url().split('/').pop() || '';
    const index = Number.parseInt(file.replace('.png', ''), 10);
    if (!Number.isFinite(index) || index < 0 || index >= slices) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/png', body });
  });
}

test('command palette opens cloud GPU processing as a native action', async ({ page }) => {
  await routeManifest(page, { patient: 'anonymous', studyDate: '', series: [] });
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: true },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-cmdk-open')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.voxellabControlsReady === 'true',
    null,
    { timeout: 10_000 },
  );
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('cloud gpu processing');
  await page.getByRole('button', { name: /Cloud GPU processing/ }).click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is ready.');
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Needs source');
  await expect(page.locator('#upload-cloud-actions')).not.toContainText('Source ready');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Loaded study: no CT/MR source volume candidate.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Next: load one DICOM CT/MR volume stack before launching Process CT/MR on cloud GPU.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud reconstruction');
  await expect(page.locator('#upload-cloud-actions')).toContainText('single-frame projection DICOM files plus voxellab.source.json');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud registration/alignment');
  await expect(page.locator('#upload-cloud-actions')).toContainText('fixedSeriesUID and movingSeriesUID');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud ultrasound scan conversion');

  await page.keyboard.press('Escape');
  await expect(page.locator('#upload-modal')).toBeHidden();
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('ultrasound scan conversion');
  await page.getByRole('button', { name: /Cloud ultrasound scan conversion/ }).click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-context-hint')).toContainText('Cloud ultrasound scan conversion');
  await expect(page.locator('#upload-context-hint')).toContainText('Input: ultrasound DICOM files plus voxellab.source.json.');
  await expect(page.locator('#upload-context-hint')).toContainText('Upload study must select files and run preflight before any cloud job starts.');
});

test('upload modal lists imported cloud results and can reopen one', async ({ page }) => {
  const baseSeries = {
    description: 'fixture volume',
    modality: 'CT',
    slices: 1,
    width: 1,
    height: 1,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    renderability: 'volume',
  };
  await routeManifest(page, {
    patient: 'anonymous',
    studyDate: '',
    series: [
      { ...baseSeries, slug: 'local_ct', name: 'Local CT' },
      {
        ...baseSeries,
        slug: 'cloud_seg',
        name: 'Cloud Segmentation Result',
        hasSeg: true,
        hasStats: true,
        sourceJobId: 'job_history_123',
        cloudAction: {
          id: 'cloud-volume-segmentation',
          label: 'Cloud CT/MR segmentation',
          provider: 'modal',
          jobId: 'job_history_123',
          processingMode: 'standard',
          inputKind: 'dicom_volume_stack',
          resultSlug: 'cloud_seg',
        },
      },
    ],
  });
  await routeTinyPngStack(page, 'local_ct', 1);
  await routeTinyPngStack(page, 'cloud_seg', 1);
  await page.route('**/data/cloud_seg_stats.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ slug: 'cloud_seg' }),
    });
  });
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: true },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-name')).toHaveText('Local CT');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await expect(page.locator('#upload-cloud-history')).toContainText('Cloud results in this study');
  await expect(page.locator('#upload-cloud-history')).toContainText('Cloud Segmentation Result');
  await expect(page.locator('#upload-cloud-history')).toContainText('job job_history_123');
  await expect(page.locator('#upload-cloud-history')).toContainText('outputs tissue, stats');
  await expect(page.locator('#upload-cloud-history')).toContainText('provider modal · mode standard · input dicom_volume_stack');

  await page.locator('#upload-modal').evaluate((modal) => { modal.dataset.closeBlocked = 'true'; });
  await page.locator('[data-cloud-result-slug="cloud_seg"]').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('Cloud job is running');
  await expect(page.locator('#series-name')).toHaveText('Local CT');
  await page.locator('#btn-upload').evaluate((button) => button.click());
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-cloud-history')).toContainText('Cloud Segmentation Result');
  await expect(page.locator('#series-name')).toHaveText('Local CT');
  await page.locator('#upload-modal').evaluate((modal) => { delete modal.dataset.closeBlocked; });

  await page.locator('[data-cloud-result-slug="cloud_seg"]').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('Cloud Segmentation Result');
});

test('upload modal can start cloud processing through the local proxy path', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const seenProxyHeaders = [];
  const seenUploadHeaders = [];
  const startBodies = [];
  let statusChecks = 0;
  let releaseCloudComplete = () => {};
  const cloudCompleteReady = new Promise(resolve => { releaseCloudComplete = resolve; });
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    startBodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    statusChecks += 1;
    if (statusChecks === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'running' }),
      });
      return;
    }
    await cloudCompleteReady;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: 'Cloud CT',
          description: '2 slices',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          hasStats: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    seenUploadHeaders.push(route.request().headers()['x-voxellab-local-token']);
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/proxy-asset?url=*cloud_job123*', async (route) => {
    const proxiedUrl = new URL(route.request().url()).searchParams.get('url') || '';
    if (decodeURIComponent(proxiedUrl).endsWith('/data/cloud_job123_stats.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          slug: 'cloud_job123',
          source: 'modal:totalsegmentator',
          sourceRegions: 'data/cloud_job123_regions.json',
          regionVolumes: [{ id: '1', name: 'Heart', volumeMl: 12.25, voxels: 12250 }],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
  });
  await page.route('**/data/cloud_job123.raw', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.alloc(4 * 4 * 2 * 2),
    });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Cloud action ready');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('2 DICOM files');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Expected result: derived volume overlays, labels, stats, or raw volume when returned by Modal.');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Modal/R2 account may incur');
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Running cloud segmentation on GPU');
  await expect(page.locator('#upload-cloud-job-card')).toBeVisible();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText(/job_/);
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Running');
  releaseCloudComplete();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud action' })).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud job' })).toContainText('job_');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('modal');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('raw volume');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('stats');
  await expect(page.locator('#quantification-panel')).toBeVisible();
  await expect(page.locator('#quantification')).toContainText('Region Heart');
  await expect(page.locator('#quantification')).toContainText('12.3 mL');
  await expect(page.locator('#quantification')).toContainText('https://r2.example/data/cloud_job123_stats.json');
  await expect(page.locator('#cloud-provenance-export-json')).toBeVisible();
  const provenanceDownloadPromise = page.waitForEvent('download');
  await page.locator('#cloud-provenance-export-json').click();
  const provenanceDownload = await provenanceDownloadPromise;
  expect(provenanceDownload.suggestedFilename()).toBe('voxellab-cloud-provenance-cloud_job123.json');
  const provenance = JSON.parse(await readFile(await provenanceDownload.path(), 'utf8'));
  expect(provenance.schema).toBe('voxellab.cloud-provenance.v1');
  expect(provenance.disclaimer).toContain('not clinical output');
  expect(provenance.series.slug).toBe('cloud_job123');
  expect(provenance.action.label).toBe('Cloud CT/MR segmentation');
  expect(provenance.action.inputKind).toBe('dicom_volume_stack');
  expect(provenance.action.jobId).toMatch(/^job_/);
  expect(provenance.outputs.previewStack.urlBase).toBe('https://r2.example/data/cloud_job123');
  expect(provenance.outputs.rawVolume.url).toBe('https://r2.example/cloud_job123.raw.zst');
  expect(provenance.outputs.sidecars.stats).toBe('https://r2.example/data/cloud_job123_stats.json');
  expect(JSON.stringify(provenance)).not.toContain('local-token-123');
  await expect(page.locator('#cloud-result-package-json')).toBeVisible();
  const packageDownloadPromise = page.waitForEvent('download');
  await page.locator('#cloud-result-package-json').click();
  const packageDownload = await packageDownloadPromise;
  expect(packageDownload.suggestedFilename()).toBe('voxellab-cloud-package-cloud_job123.json');
  const resultPackage = JSON.parse(await readFile(await packageDownload.path(), 'utf8'));
  expect(resultPackage.schema).toBe('voxellab.cloud-result-package.v1');
  expect(resultPackage.packageType).toBe('manifest-only');
  expect(resultPackage.assets).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'preview-stack', urlBase: 'https://r2.example/data/cloud_job123', slices: 2 }),
    expect.objectContaining({ kind: 'raw-volume', url: 'https://r2.example/cloud_job123.raw.zst' }),
    expect.objectContaining({ kind: 'sidecar-stats', url: 'https://r2.example/data/cloud_job123_stats.json' }),
  ]));
  expect(resultPackage.provenance.action.jobId).toMatch(/^job_/);
  expect(JSON.stringify(resultPackage)).not.toContain('local-token-123');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT');
  expect(startBodies[0]?.input_kind).toBe('dicom_volume_stack');
  expect(seenProxyHeaders).toEqual(['local-token-123', 'local-token-123', 'local-token-123', 'local-token-123']);
  expect(seenUploadHeaders).toEqual([undefined, undefined]);
});

test('upload modal blocks cloud processing for non-DICOM medical inputs', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('cloud-blocked.nii');
  await writeTinyNifti(niftiPath);

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloudCalls = [];
  await page.route('**/api/cloud/**', async (route) => {
    cloudCalls.push(route.request().url());
    await route.fulfill({ status: 500, body: 'unexpected cloud call' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(niftiPath);

  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('DICOM CT/MR volume stacks only');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('cloud-blocked.nii');
  expect(cloudCalls).toEqual([]);
});

test('upload modal blocks default cloud segmentation for mixed CT/MR series', async ({ page }, testInfo) => {
  const first = testInfo.outputPath('cloud-mixed-series-a.dcm');
  const second = testInfo.outputPath('cloud-mixed-series-b.dcm');
  await writeTinyDicom(first, { seriesUID: '1.2.826.0.1.3680043.10.543.20.1', instanceNumber: 1, z: 0 });
  await writeTinyDicom(second, { seriesUID: '1.2.826.0.1.3680043.10.543.20.2', instanceNumber: 2, z: 1 });

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloudCalls = [];
  await page.route('**/api/cloud/**', async (route) => {
    cloudCalls.push(route.request().url());
    await route.fulfill({ status: 500, body: 'unexpected cloud call' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles([first, second]);

  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('one coherent DICOM series');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('voxellab.source.json for registration/alignment');
  expect(cloudCalls).toEqual([]);
});

test('upload modal updates an existing cloud series instead of duplicating it', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-repeat-input');

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  let cloudRun = 0;
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    cloudRun += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: cloudRun === 1 ? 'Cloud CT' : 'Cloud CT Updated',
          description: cloudRun === 1 ? '2 slices' : '2 slices updated',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT Updated');
  await expect(page.locator('#series-desc')).toHaveText('2 slices updated');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT Updated');
});

test('upload modal keeps cloud job failures visible instead of pretending success', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-error-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: 'GPU pipeline failed',
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('GPU pipeline failed');
  await expect(page.locator('#upload-cloud-job-card')).toBeVisible();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Failed');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText(/job_/);
  await expect(page.locator('#upload-cloud-job-card')).toContainText('GPU pipeline failed');
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
});

test('upload modal fails completed cloud jobs that do not return importable results', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-missing-result-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: '',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'complete', slug: 'cloud_missing_result' }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('did not return an importable series entry');
  await expect(page.locator('#upload-status')).toContainText('Configure an R2 public URL');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Failed');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('did not return an importable series entry');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
});

test('upload modal can stop waiting for a running cloud job', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-stop-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'running' }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Running');
  await expect(page.locator('[data-cloud-job-stop]')).toHaveText('Stop waiting');
  await expect.poll(async () => page.locator('#upload-modal').evaluate((el) => el.dataset.closeBlocked)).toBe('true');

  await page.keyboard.press('Escape');
  await expect(page.locator('#upload-modal')).toBeVisible();

  await page.locator('[data-cloud-job-stop]').click();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Stopped');
  await expect(page.locator('#upload-status')).toContainText('Stopped waiting for cloud job');
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
  await page.locator('#upload-close').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
});
