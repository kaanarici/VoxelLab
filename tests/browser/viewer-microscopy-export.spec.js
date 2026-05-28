/* global HTMLAnchorElement, Image, document, window */
import { expect, test } from '@playwright/test';

import { writeCalibratedChannelTimeOmeTiff } from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  drawEllipseRoi,
  dropFiles,
  expectScaleBarFits,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function clickCanvasPixel(page, x, y) {
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const size = await canvas.evaluate((el) => ({ width: el.width, height: el.height }));
  await page.mouse.click(
    box.x + (x / size.width) * box.width,
    box.y + (y / size.height) * box.height,
  );
}

test('microscopy screenshot export includes the calibrated scale bar in the PNG', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const width = 256;
  const height = 128;
  const omeTiffPath = testInfo.outputPath('cells-screenshot.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath, { width, height });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);
  const stackPanel = page.locator('#microscopy-stack-panel');
  if (await stackPanel.evaluate(el => el.classList.contains('collapsed')).catch(() => false)) {
    await stackPanel.locator('.sec-title').click();
  }
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 1/1 · C 2/2 · T 2/2');
  const exportContext = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { screenshot2DContextLabel } = await import('/js/screenshot.js');
    return screenshot2DContextLabel(state.manifest.series[state.seriesIdx], state.sliceIdx);
  });
  expect(exportContext).toBe('Z 1 · C2 GFP · T2');
  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-measure').click();
  await clickCanvasPixel(page, 32, 64);
  await clickCanvasPixel(page, 96, 64);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-label')).toHaveText('32.0 µm');

  await page.evaluate(() => {
    window.__voxellabScreenshot = null;
    if (window.__voxellabScreenshotPatched) return;
    window.__voxellabScreenshotPatched = true;
    HTMLAnchorElement.prototype.click = function captureScreenshotClick() {
      if (String(this.download || '').endsWith('.png')) {
        window.__voxellabScreenshot = { href: this.href, download: this.download };
      }
    };
  });
  await page.locator('#btn-shot').click();
  await expect.poll(() => page.evaluate(() => window.__voxellabScreenshot?.href || '')).toContain('data:image/png');
  const screenshot = await page.evaluate(() => window.__voxellabScreenshot);
  expect(screenshot.download).toMatch(/_z1_c2_t2\.png$/);

  const metrics = await page.evaluate(async (href) => {
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    img.src = href;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const y = canvas.height - 10;
    let brightLinePixels = 0;
    for (let x = canvas.width - 120; x < canvas.width - 8; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] > 230) brightLinePixels += 1;
    }
    let roiBluePixels = 0;
    for (let py = Math.floor(canvas.height * 0.25); py < Math.floor(canvas.height * 0.78); py += 1) {
      for (let px = Math.floor(canvas.width * 0.25); px < Math.floor(canvas.width * 0.78); px += 1) {
        const offset = (py * canvas.width + px) * 4;
        if (data[offset] < 170 && data[offset + 1] > 160 && data[offset + 2] > 190) roiBluePixels += 1;
      }
    }
    let measurementWhitePixels = 0;
    for (let py = 61; py <= 67; py += 1) {
      for (let px = 28; px <= 100; px += 1) {
        const offset = (py * canvas.width + px) * 4;
        if (data[offset] > 240 && data[offset + 1] > 240 && data[offset + 2] > 240) measurementWhitePixels += 1;
      }
    }
    let contextDarkPixels = 0;
    let contextBrightPixels = 0;
    for (let py = 10; py <= 30; py += 1) {
      for (let px = 10; px <= 130; px += 1) {
        const offset = (py * canvas.width + px) * 4;
        if (data[offset] < 55 && data[offset + 1] < 55 && data[offset + 2] < 55) contextDarkPixels += 1;
        if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220) contextBrightPixels += 1;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      brightLinePixels,
      roiBluePixels,
      measurementWhitePixels,
      contextDarkPixels,
      contextBrightPixels,
    };
  }, screenshot.href);
  expect(metrics).toMatchObject({ width, height });
  expect(metrics.contextDarkPixels, JSON.stringify(metrics)).toBeGreaterThan(600);
  expect(metrics.contextBrightPixels, JSON.stringify(metrics)).toBeGreaterThan(40);
  expect(metrics.brightLinePixels, JSON.stringify(metrics)).toBeGreaterThan(80);
  expect(metrics.roiBluePixels, JSON.stringify(metrics)).toBeGreaterThan(20);
  expect(metrics.measurementWhitePixels, JSON.stringify(metrics)).toBeGreaterThan(40);
});
