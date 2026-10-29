import { expect, test } from '@playwright/test';
import {
  localVolumeSeries,
  openPerfViewer,
  openPerfVolumeFixture,
  routeLocalVolumeStudy,
} from '../helpers/browser/local-study.mjs';
import { waitForCanvasPaint } from '../helpers/browser/canvas.mjs';
import { waitForControlsReady } from '../helpers/browser/app.mjs';

test.setTimeout(90_000);

function trackModuleRequests(page, modulePaths) {
  const seen = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (modulePaths.some((modulePath) => pathname.endsWith(modulePath))) seen.push(pathname);
  });
  return seen;
}

async function expectStillDeferred(page, seen) {
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual([]);
}

async function expectLoaded(seen) {
  await expect.poll(() => seen.length, { timeout: 4_000 }).toBeGreaterThan(0);
}

async function seedRoiResult(page, stats) {
  await page.evaluate(async (roiStats) => {
    const { state } = await import('/js/core/state.js');
    const { setRoiEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const { renderRoiResults } = await import('/js/roi/roi-results.js');
    const series = state.manifest.series[state.seriesIdx];
    setRoiEntriesForSlice(series.slug, state.sliceIdx || 0, [{
      id: 1,
      "shape": 'polygon',
      label: 'lazy-module-check',
      pts: [[1, 1], [12, 1], [12, 12], [1, 12]],
      stats: roiStats,
      createdAt: Date.now(),
    }]);
    renderRoiResults(state);
  }, stats);
}

test.describe('viewer defers optional modules until their entry point is used', () => {
  test('GPU MPR loads only when MPR opens', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/mpr/mpr-gpu.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    await page.locator('#btn-mpr').click();
    await expectLoaded(seen);
  });

  test('the Three.js renderer stack loads only when 3D opens', async ({ page }) => {
    const seen = trackModuleRequests(page, [
      '/js/volume/vendor-three.js',
      '/js/volume/vendor-trackball-controls.js',
      '/js/volume/volume-three-bootstrap.js',
      '/js/volume/volume-raycast-material.js',
    ]);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    await page.locator('#btn-3d').click();
    await expect(page.locator('#three-container.active canvas')).toBeVisible();
    await expectLoaded(seen);
  });

  test('the upload workflow and every importer stay unloaded until upload opens', async ({ page }) => {
    const uploadSeen = trackModuleRequests(page, ['/js/projects/study-upload-modal.js']);
    const importerSeen = trackModuleRequests(page, [
      '/js/dicom/dicom-derived-import.js',
      '/js/dicom/dicom-import.js',
      '/js/dicom/dicomweb-import.js',
      '/js/dicom/dicomweb/dicomweb-source.js',
      '/js/microscopy/microscopy-import.js',
      '/js/microscopy/microscopy-workflow-recipe.js',
    ]);

    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, uploadSeen);
    expect(importerSeen).toEqual([]);

    await page.locator('#btn-upload').click();
    await expect(page.locator('#upload-modal')).toHaveClass(/visible/);
    await expectLoaded(uploadSeen);
    await expectStillDeferred(page, importerSeen);
  });

  test('the DICOM SR exporter loads only when an SR export is requested', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/dicom/dicom-sr.js']);
    const legacyScripts = trackModuleRequests(page, ['/dcmjs.js', '/dcmjs.min.js']);

    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);
    expect(legacyScripts).toEqual([]);

    await seedRoiResult(page, { area_mm2: 121, mean: 42, std: 3 });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-sr').click();
    await downloadPromise;
    await expect(page.locator('#confirm-modal')).toHaveClass(/visible/);
    await expect(page.locator('#confirm-modal')).toContainText('DICOM SR exported');
    await expectLoaded(seen);
    expect(legacyScripts).toEqual([]);
  });

  test('the ImageJ ROI codec loads only when a ROI ZIP export is requested', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/microscopy/imagej-roi.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    await seedRoiResult(page, { pixels: 121, count: 121 });
    await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
    await page.locator('#roi-results-imagej-export').evaluate((button) => button.click());
    await expectLoaded(seen);
  });

  test('the screenshot exporter loads only when an export is requested', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/screenshot.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-shot').click();
    await downloadPromise;
    await expectLoaded(seen);
  });

  test('the shortcut customizer loads only when it is requested', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/shortcuts-modal.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    await page.locator('#btn-cmdk-open').click();
    await page.locator('#cmdk-input').fill('shortcuts');
    await page.getByRole('button', { name: /Customize shortcuts/ }).click();
    await expect(page.locator('#shortcuts-modal')).toHaveClass(/visible/);
    await expectLoaded(seen);
  });

  test('the Ask/Consult API module loads only when an AI action opens', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/consult-ask.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    const consultButton = page.locator('#btn-consult');
    test.skip(await consultButton.evaluate((button) => button.classList.contains('hidden')), 'Local AI actions are disabled.');
    await consultButton.click();
    await expect(page.locator('#consult-modal')).toHaveClass(/visible/);
    await expectLoaded(seen);
  });

  test('microscopy controls, analysis, and recipe modules stay unloaded outside microscopy workflows', async ({ page }) => {
    const seen = trackModuleRequests(page, [
      '/js/microscopy/microscopy-hyperstack-controls.js',
      '/js/microscopy/microscopy-analysis.js',
      '/js/microscopy/microscopy-analysis-panel.js',
      '/js/microscopy/microscopy-workflow-recipe.js',
    ]);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);
  });

  test('DICOM-derived hydration stays unloaded when no persisted objects exist', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/dicom/dicom-derived-import.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);
  });
});

test.describe('viewer keeps desktop-only and peer modules out of the browser cold path', () => {
  async function openFusionPeerStudy(page) {
    const series = ['fusion_source', 'fusion_peer'].map((slug, index) => ({
      ...localVolumeSeries(slug, index === 0 ? 'Fusion Source' : 'Fusion Peer', {
        slices: 2,
        width: 1,
        height: 1,
      }),
      group: 'fusion-fixture',
    }));
    await routeLocalVolumeStudy(page, series);
    const manifest = await openPerfViewer(page);
    await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
    await waitForCanvasPaint(page, '#view');
    return manifest;
  }

  test('the Electron path-backed file adapter stays unloaded outside native path opens', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/desktop-path-file.js']);
    await openFusionPeerStudy(page);
    await expectStillDeferred(page, seen);
  });

  test('the Electron window chrome module stays unloaded outside the desktop runtime', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/shell/desktop-window-chrome.js']);
    await openFusionPeerStudy(page);
    await expectStillDeferred(page, seen);
  });

  test('the fusion peer loader loads only when a fusion peer is selected', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/fusion-loader.js']);
    await openFusionPeerStudy(page);
    await expect(page.locator('#fusion-select option[value="fusion_peer"]')).toHaveCount(1);
    await expectStillDeferred(page, seen);

    await page.locator('#fusion-select').selectOption('fusion_peer');
    await expectLoaded(seen);
  });
});

test.describe('cloud entry points open the upload workflow lazily', () => {
  test('the segmentation catalog opens the upload workflow with TotalSegmentator context', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/projects/study-upload-modal.js']);
    const series = localVolumeSeries('ct_seg_source', 'CT Segmentation Source', {
      description: 'CT chest volume',
      modality: 'CT',
      slices: 3,
    });
    await page.addInitScript(() => localStorage.setItem('voxellab:interaction-hint-seen', '1'));
    await routeLocalVolumeStudy(page, [series]);
    await openPerfViewer(page, '/?segmentationAction=1');
    await waitForControlsReady(page);

    await expect(page.locator('#btn-slimsam')).toBeVisible();
    await page.locator('#btn-slimsam').click();
    await expect(page.locator('#slimsam-menu')).toBeVisible();
    const totalSegmentator = page.locator('.segmentation-engine[data-engine="totalsegmentator"]');
    await expect(totalSegmentator).toContainText('TotalSegmentator');
    await expect(totalSegmentator.locator('.segmentation-engine-action')).toHaveText('Run on Cloud GPU');
    expect(seen).toEqual([]);

    await totalSegmentator.locator('.segmentation-engine-action').scrollIntoViewIfNeeded();
    await totalSegmentator.locator('.segmentation-engine-action').click();
    await expect(page.locator('#upload-modal')).toBeVisible();
    await expect(page.locator('#upload-context-hint')).toContainText('TotalSegmentator · Cloud GPU');
    await expect(page.locator('#upload-context-hint')).toContainText('Select the original CT/MR DICOM stack');
    await expectLoaded(seen);
  });

  test('the command palette opens the upload workflow with cloud context', async ({ page }) => {
    const seen = trackModuleRequests(page, ['/js/projects/study-upload-modal.js']);
    await openPerfVolumeFixture(page);
    await expectStillDeferred(page, seen);

    await page.locator('#btn-cmdk-open').click();
    await page.locator('#cmdk-input').fill('cloud gpu');
    await page.getByRole('button', { name: /Cloud GPU processing/ }).click();
    await expect(page.locator('#upload-modal')).toBeVisible();
    await expect(page.locator('#upload-context-hint')).toContainText('Cloud GPU processing');
    await expect(page.locator('#upload-context-hint')).toContainText('VoxelLab checks eligibility before any upload');
    await expectLoaded(seen);
  });
});

test('SlimSAM integration loads only when the segmentation menu opens', async ({ page }) => {
  const seen = trackModuleRequests(page, ['/js/overlay/slimsam.js']);
  const series = localVolumeSeries('perf_volume', 'Performance Volume Fixture', {
    description: 'self-contained browser performance fixture',
    slices: 3,
  });
  await routeLocalVolumeStudy(page, [series]);
  await page.route('**/api/cloud-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'local-env',
        storagePath: '/tmp/voxellab/.env',
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        cloudProcessing: true,
        hasModalAuthToken: false,
        configured: false,
      }),
    });
  });
  await openPerfViewer(page);
  await waitForControlsReady(page);
  await expect(page.locator('#btn-slimsam')).toBeVisible();
  await page.evaluate(async (fixtureSeries) => {
    const { state } = await import('/js/core/state.js');
    state.manifest = { patient: 'anonymous', studyDate: '', series: [fixtureSeries] };
    state.seriesIdx = 0;
    state.mode = '2d';
  }, series);
  await expectStillDeferred(page, seen);

  await page.locator('#btn-slimsam').click();
  await expect(page.locator('#slimsam-menu')).toBeVisible();
  await expect(page.locator('#slimsam-title')).toHaveText('Segmentation');
  await expect(page.locator('#segmentation-engine-list')).toContainText('SlimSAM');
  await expect(page.locator('#slimsam-state-pill')).not.toHaveText('Blocked');
  await expect(page.locator('#slimsam-status')).toContainText('does not have local click-to-segment embeddings yet');
  await expect(page.locator('#slimsam-command-code')).toContainText('python3 python/slimsam_embed.py');
  await expect(page.locator('label.slimsam-toggle.ui-checkbox #slimsam-smooth.ui-checkbox-input')).toBeChecked();
  await expect(page.locator('label.slimsam-toggle .ui-checkbox-box')).toBeVisible();
  await page.locator('#segmentation-cloud-settings').click();
  await expect(page.locator('#cloud-settings-modal')).toBeVisible();
  await expect(page.locator('#cloud-settings-status')).toContainText('Enter Modal webhook base');
  await expectLoaded(seen);
});
