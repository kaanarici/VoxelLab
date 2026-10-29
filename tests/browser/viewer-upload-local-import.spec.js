import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  openAdvancedOptions,
  openEmptyStudyUploadModal as openUploadModal,
  routeConfig,
  routeManifest,
} from '../helpers/browser/app.mjs';
import { waitForCanvasPaint } from '../helpers/browser/canvas.mjs';
import { dropFile } from '../helpers/browser/drag-drop.mjs';
import { writeTinyDicom, writeTinySr } from '../helpers/browser/fixtures/dicom.mjs';
import { writeTinyNifti } from '../helpers/browser/fixtures/nifti.mjs';
import { expectThreeCanvasFitsContainer, waitForThreeSurface } from '../helpers/browser/layout.mjs';

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

async function routeDcmjsModule(page) {
  const dcmjsModule = await readFile('node_modules/dcmjs/build/dcmjs.es.js', 'utf8');
  await page.route('**/node_modules/dcmjs/build/dcmjs.es.js', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: dcmjsModule });
  });
}

test('upload modal can drag-and-drop a local NIfTI file through 2D, MPR, and 3D rendering', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('tiny-upload.nii');
  await writeTinyNifti(niftiPath, { pixdim: [0.5, 0.75, 1] });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFile(page, '#upload-zone', niftiPath);

  await expect(page.locator('#series-name')).toHaveText('tiny-upload');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('NIfTI metadata (mm)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted voxel metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Pixel spacing' })).toContainText('0.750 mm × 0.500 mm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('tiny-upload.nii');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-co')).toBeVisible();
  await expect(page.locator('#mpr-sa')).toBeVisible();
  await waitForCanvasPaint(page, '#mpr-ax');
  await waitForCanvasPaint(page, '#mpr-co');
  await waitForCanvasPaint(page, '#mpr-sa');

  await page.locator('#btn-3d').click();
  await expect(page.locator('#btn-3d')).toHaveClass(/active/);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/mpr3d/);
  await waitForThreeSurface(page);
  await expectThreeCanvasFitsContainer(page);

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#canvas-wrap')).toHaveClass(/threeD/);
  await waitForThreeSurface(page);
  await expectThreeCanvasFitsContainer(page);
});

test('upload modal keeps unknown-unit NIfTI uncalibrated in metadata', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('unknown-unit.nii');
  await writeTinyNifti(niftiPath, { xyztUnits: 0 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFile(page, '#upload-zone', niftiPath);

  await expect(page.locator('#series-name')).toHaveText('unknown-unit');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Pixel spacing' })).toContainText('—');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('Uncalibrated (NIfTI unit unknown)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Unknown · NIfTI spatial unit unknown');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('unknown-unit.nii');
  await expect(page.locator('#meta .meta-row').filter({ hasText: '3D reason' })).toContainText('spatial unit is unknown');
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
});

test('upload modal falls back locally after second-pass DICOM worker failure', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('local-source.dcm');
  await writeTinyDicom(dicomPath);

  await page.addInitScript(() => {
    const nativePostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function postMessage(message, transfer) {
      if (message?.type === 'parse-dicom-files') throw new Error('synthetic second-pass worker failure');
      return transfer === undefined
        ? nativePostMessage.call(this, message)
        : nativePostMessage.call(this, message, transfer);
    };
  });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFile(page, '#upload-zone', dicomPath, 'application/dicom');

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('DICOM metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted XY metadata · 2D only');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('local-source.dcm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Import single-image');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Study 1.2.826.0.1.3680043.10.543.10');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Series 1.2.826.0.1.3680043.10.543.20');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Frame of reference' })).toContainText('1.2.826.0.1.3680043.10.543.30');
  await waitForCanvasPaint(page, '#view');
});

test('supported local SR waits for and then attaches to its matching source series', async ({ page }, testInfo) => {
  const sourceSeriesUID = '1.2.826.0.1.3680043.10.543.777';
  const srPath = testInfo.outputPath('pending-local-sr/measurements.sr');
  const dicomPath = testInfo.outputPath('pending-local-sr/source.dcm');
  await writeTinySr(srPath, { sourceSeriesUID, sourceSlug: 'source-before-reimport' });
  await writeTinyDicom(dicomPath, { seriesUID: sourceSeriesUID });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(srPath);

  await expect(page.locator('#notify-container .notify-text', { hasText: 'Holding 1 derived object in this session' }))
    .toContainText('attach automatically when the matching source series is loaded');
  await expect(page.locator('#upload-modal')).toBeHidden();

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPath);

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { noteEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      pending: state._pendingDerivedObjects?.length || 0,
      notes: noteEntriesForSlice(state, series, 0).filter(note => note.sourceObjectUID).length,
      derived: Object.keys(state._localDerivedObjects?.[series.slug] || {}).length,
    };
  })).toEqual({ pending: 0, notes: 1, derived: 1 });
  await waitForCanvasPaint(page, '#view');
});

test('upload modal reports skipped local derived objects after loading their source series', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('local-dicom-with-skipped-sr/source.dcm');
  const srPath = testInfo.outputPath('local-dicom-with-skipped-sr/clinical-note.sr');
  await writeTinyDicom(dicomPath);
  await writeTinySr(srPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([dicomPath, srPath]);

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 derived object' }))
    .toContainText('SR: SR import contains no measurement groups');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal labels multi-file DICOM source provenance in metadata', async ({ page }, testInfo) => {
  const firstPath = testInfo.outputPath('local-dicom-volume/IM0001.dcm');
  const secondPath = testInfo.outputPath('local-dicom-volume/IM0002.dcm');
  await writeTinyDicom(firstPath, { instanceNumber: 1, z: 0 });
  await writeTinyDicom(secondPath, { instanceNumber: 2, z: 1 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([firstPath, secondPath]);

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' }))
    .toContainText('2 files (IM0001.dcm, IM0002.dcm)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Import volume-stack');
  await waitForCanvasPaint(page, '#view');
});

test('persisted SEG overlays hydrate on the first series selection after reload', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeManifest(page, {
    patient: 'anonymous',
    studyDate: '',
    series: [{
      slug: 'ct_chest_1',
      name: 'CT Chest 1',
      description: '1 slice',
      modality: 'CT',
      slices: 1,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
    }],
  });
  await routeTinyPngStack(page, 'ct_chest_1', 1);
  await page.addInitScript(() => {

    localStorage.setItem('mri-viewer/derived-objects/v1', JSON.stringify({
      version: 1,
      entries: {
        'slug:ct_chest_1|obj:seg-test': {
          id: 'slug:ct_chest_1|obj:seg-test',
          objectUID: 'seg-test',
          name: 'Imported SEG',
          modality: 'SEG',
          importedAt: 1,
          binding: {
            derivedKind: 'seg',
            frameOfReferenceUID: '',
            sourceSeriesSlug: 'ct_chest_1',
            requiresRegistration: false,
            affineCompatibility: 'exact',
          },
          payload: {
            format: 'seg-overlay-v1',
            sparseSlices: [[0, 1]],
            regionMeta: {
              regions: { 1: { name: 'Imported SEG', voxels: 1, mL: 0.25, source: 'dicom-seg' } },
              colors: { 1: [255, 0, 0] },
            },
          },
        },
      },
    }));
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-list li.active')).toBeVisible();
  await expect(page.locator('#series-name')).not.toHaveText('');
  await expect(page.locator('#slice-cur')).not.toHaveText('');
  const sourceSeries = page.locator('#series-list li').filter({ hasText: 'CT Chest 1' });
  await expect(sourceSeries).toBeVisible();
  await sourceSeries.click();
  await expect(page.locator('#series-name')).toHaveText('CT Chest 1');
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series.find((item) => item.slug === 'ct_chest_1');
    const button = document.getElementById('btn-regions');
    return {
      hasRegions: !!series?.hasRegions,
      hasRegionMeta: !!state.overlays.regionMeta?.regions?.[1],
      buttonHidden: button?.classList.contains('hidden') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    hasRegions: true,
    hasRegionMeta: true,
    buttonHidden: false,
  });
  await page.evaluate(() => document.getElementById('btn-regions')?.click());

  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      labels: !!state.overlays.labels,
      hasRegionMeta: !!state.overlays.regionMeta?.regions?.[1],
      regionImageCount: state.regionImgs?.length || 0,
      firstRegionReady: !!state.regionImgs?.[0]?.complete,
      buttonActive: document.getElementById('btn-regions')?.classList.contains('active') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    labels: true,
    hasRegionMeta: true,
    regionImageCount: 1,
    firstRegionReady: true,
    buttonActive: true,
  });

  const volumesPanel = page.locator('[data-panel="region-volumes"]');
  await expect(volumesPanel).toHaveAttribute('data-collapse-wired', '1');
  if (await volumesPanel.evaluate(panel => panel.classList.contains('collapsed'))) {
    await volumesPanel.getByText('Regional Volumes', { exact: true }).click();
  }
  await expect(volumesPanel.locator('.sec-title')).toHaveAttribute('aria-expanded', 'true');
  await volumesPanel.locator('.rp-body').evaluate(async (body) => {
    await Promise.all(body.getAnimations().map(animation => animation.finished));
  });
  await expect(page.locator('#regional-volumes-export-csv')).toBeVisible();
  const regionalCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#regional-volumes-export-csv').click();
  const regionalCsvDownload = await regionalCsvDownloadPromise;
  expect(regionalCsvDownload.suggestedFilename()).toBe('voxellab-regional-volumes-ct_chest_1.csv');
  const regionalCsv = await readFile(await regionalCsvDownload.path(), 'utf8');
  expect(regionalCsv.split('\n')[0]).toBe('series_slug,series_name,label_id,label_name,value,unit,percent_of_reported_total,source,provenance,note');
  expect(regionalCsv).toContain('ct_chest_1,CT Chest 1,1,Imported SEG,0.25,mL,100.0,dicom-seg,label voxel count x calibrated voxel spacing,Research measurement; not clinical output.');
});
