import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import { writeCalibratedChannelTimeOmeTiff } from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  dropFiles,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function openPanel(page, selector) {
  const panel = page.locator(selector);
  await expect(panel).toBeVisible();
  if (await panel.evaluate(el => el.classList.contains('collapsed'))) await panel.locator('.sec-title').click();
}

async function clickCanvasPixel(page, x, y) {
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  const size = await canvas.evaluate(el => ({ width: el.width, height: el.height }));
  await page.mouse.click(box.x + (x / size.width) * box.width, box.y + (y / size.height) * box.height);
}

test('microscopy Analyze panel plots an active raw line and reports bounded pixel-wise colocalization', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('quantification.ome.tiff');
  await mkdir(dirname(path), { recursive: true });
  await writeCalibratedChannelTimeOmeTiff(path);
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');

  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-measure').click();
  await clickCanvasPixel(page, 4, 8);
  await clickCanvasPixel(page, 8, 8);

  await openPanel(page, '#microscopy-analysis-panel');
  await page.locator('#analyze-line-profile-run').click();
  await expect(page.locator('#analyze-line-profile-status')).toContainText('raw samples');
  await expect(page.locator('#analyze-line-profile-plot svg')).toBeVisible();
  await page.locator('#analyze-profile-sampling').selectOption('bilinear');
  await expect(page.locator('#analyze-line-profile-status')).toHaveText('');
  await expect(page.locator('#analyze-line-profile-plot svg')).toHaveCount(0);
  await page.locator('#analyze-line-profile-run').click();
  await expect(page.locator('#analyze-line-profile-status')).toContainText('bilinear');
  await expect(page.locator('#analyze-line-profile-plot svg')).toBeVisible();
  await clickCanvasPixel(page, 5, 7);
  await clickCanvasPixel(page, 9, 7);
  await expect(page.locator('#analyze-line-profile-plot svg')).toHaveCount(0);
  await page.locator('#analyze-line-profile-run').click();
  await expect(page.locator('#analyze-line-profile-plot svg')).toBeVisible();

  await page.locator('#analyze-coloc-run').click();
  await expect(page.locator('#analyze-coloc-status')).toContainText('finite, nonnegative thresholds');
  await page.locator('#analyze-coloc-threshold-a').fill('0');
  await page.locator('#analyze-coloc-threshold-b').fill('0');
  await page.locator('#analyze-coloc-run').click();
  await expect(page.locator('#analyze-coloc-status')).toContainText('Pearson r');
  await page.locator('#analyze-coloc-threshold-a').fill('1');
  await expect(page.locator('#analyze-coloc-status')).toHaveText('');
  await page.locator('#analyze-coloc-threshold-a').fill('0');
  await expect(page.locator('#analyze-coloc-status')).toContainText('Pearson r');
  await page.locator('#analyze-coloc-channel-b').selectOption('0');
  await expect(page.locator('#analyze-coloc-status')).toHaveText('');
  await page.locator('#analyze-coloc-channel-b').selectOption('1');
  await expect(page.locator('#analyze-coloc-status')).toContainText('Pearson r');
  await expect(page.locator('#microscopy-analysis-controls')).toContainText('No Costes');
});
