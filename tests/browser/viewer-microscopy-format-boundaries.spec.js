import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { dropFiles, openUploadModal, routeConfig } from './microscopy-upload-helpers.mjs';

async function writePlaceholderFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'not a proprietary microscopy container\n');
}

async function openUploadModalWithoutLocalBackend(page) {
  await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.waitForFunction(
    () => document.documentElement.dataset.voxellabControlsReady === 'true',
    null,
    { timeout: 10_000 },
  );
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
}

test('vendor microscopy inputs are presented with local and Electron converter boundaries', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const row = page.locator('.format-capability-row', { hasText: 'CZI / ND2 / LIF / OIB / OIF / LSM bridge' });
  await expect(row.locator('.format-capability-status')).toHaveText('Converted');
  await expect(row).toContainText('Local backend can convert CZI/ND2/LIF with optional readers');
  await expect(row).toContainText('CZI/ND2/LIF/OIB/OIF/LSM through a configured external OME-TIFF converter');
  await expect(row).toContainText('Electron uses the same external-converter boundary');
  await expect(row).toContainText('not native browser import');
  await expect(row).toContainText('first-party Bio-Formats parity');

  // A malformed vendor file must fail closed: the backend conversion rejects it (or reports
  // the readers/backend are unavailable), the modal stays open, and no series is added.
  const initialSeriesCount = await page.locator('#series-list li').count();
  const path = testInfo.outputPath('sample.czi');
  await writePlaceholderFile(path);
  await dropFiles(page, '#upload-zone', [{ path }]);

  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 converter-backed file');
  await expect(page.locator('#notify-container .notify-text')).toContainText('converter-backed files need configured local readers or an OME-TIFF converter: sample.czi.');
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveClass(/error/);
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});

test('local vendor microscopy sidecars do not mask the converter boundary message', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const cziPath = testInfo.outputPath('sample-with-sidecar.czi');
  const recipePath = testInfo.outputPath('sample-with-sidecar-recipe.json');
  await writePlaceholderFile(cziPath);
  await writeFile(recipePath, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));

  await dropFiles(page, '#upload-zone', [
    { path: cziPath },
    { path: recipePath, mimeType: 'application/json' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText('Could not convert sample-with-sidecar.czi');
  await expect(status).not.toContainText('Import CZI/ND2/LIF files on their own');
});

test('vendor microscopy files explain reader or converter setup when local backend is unavailable', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModalWithoutLocalBackend(page);

  const path = testInfo.outputPath('needs-backend.czi');
  await writePlaceholderFile(path);
  await dropFiles(page, '#upload-zone', [{ path }]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText('Converter-backed CZI/ND2/LIF/OIB/OIF/LSM need the local VoxelLab backend');
  await expect(status).toContainText('optional microscopy readers or VOXELLAB_BFCONVERT');
  await expect(status).toContainText('OME-TIFF converter');
});

test('ImageJ ROI Manager ZIP boundary stays limited to sidecar archives', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const roiRow = page.locator('.format-capability-row', { hasText: 'ImageJ ROI .roi' });
  await expect(roiRow.locator('.format-capability-status')).toHaveText('Native');
  await expect(roiRow).toContainText('Limited ImageJ ROI Manager sidecar import');
  await expect(roiRow).toContainText('opened onto the active microscopy series');
  await expect(roiRow).toContainText('straight-line');
  await expect(roiRow).toContainText('angle');

  const zipRow = page.locator('.format-capability-row', { hasText: 'ImageJ ROI .zip' });
  await expect(zipRow.locator('.format-capability-status')).toHaveText('Native');
  await expect(zipRow).toContainText('stored/deflated supported ROI sidecars');
  await expect(zipRow).toContainText('opened onto the active microscopy series');
  await expect(zipRow).toContainText('VoxelLab-authored uncompressed ZIP export');
  await expect(zipRow).toContainText('straight-line and angle measurements');
  await expect(zipRow).toContainText('broader ROI Manager type parity is not claimed yet');

  const initialSeriesCount = await page.locator('#series-list li').count();
  const path = testInfo.outputPath('cells-rois.zip');
  await writePlaceholderFile(path);

  await dropFiles(page, '#upload-zone', [{ path }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('Sidecar files are not standalone images');
  await expect(page.locator('#upload-status')).toContainText('Selected sidecar: cells-rois.zip.');
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});
