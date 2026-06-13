/* global document */
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

async function ensurePanelOpen(page, panelSelector) {
  const panel = page.locator(panelSelector);
  await expect(panel).toBeVisible();
  if (await panel.evaluate((el) => el.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await expect(panel).not.toHaveClass(/collapsed/);
}

test('Analyze panel runs particle analysis into the ROI results table', async ({ page }, testInfo) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const omeTiffPath = testInfo.outputPath('cells-channel-time.ome.tiff');
  await mkdir(dirname(omeTiffPath), { recursive: true });
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  // Wait for the uploaded microscopy series to become active (the auto-loaded default study
  // would otherwise satisfy waitForCanvasPaint before the upload switches series).
  await expect(page.locator('#series-name')).toHaveText('cells-channel-time');
  await waitForCanvasPaint(page, '#view');

  // The Analyze panel appears for microscopy series with retained raw planes.
  await ensurePanelOpen(page, '#microscopy-analysis-panel');
  await expect(page.locator('#analyze-run')).toBeEnabled();

  // Deterministic: a manual threshold of 0 (dark background) selects every pixel, so the
  // whole image is one connected component → exactly one particle row.
  await page.locator('#analyze-threshold-method').selectOption('manual');
  await page.locator('#analyze-threshold-value').fill('0');
  await page.locator('#analyze-run').click();

  await expect(page.locator('#analyze-status')).toContainText('particle');

  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('1');

  // The particle row is a raw-domain polygon (Fiji "Mean gray value" parity).
  const row = await page.locator('#roi-results .roi-result-foot').first().textContent();
  expect(row).toContain('Raw intensity');
});
