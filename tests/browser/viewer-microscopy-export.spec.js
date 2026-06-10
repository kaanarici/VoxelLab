/* global HTMLAnchorElement, Image, TextDecoder, atob, document, window */
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

test('microscopy screenshot export includes calibrated scale bar in PNG and rendered TIFF', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
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
    const { state } = await import('/js/core/state.js');
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
  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-angle').click();
  await clickCanvasPixel(page, 230, 32);
  await clickCanvasPixel(page, 204, 32);
  await clickCanvasPixel(page, 230, 58);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.3°');
  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-annot').click();
  await clickCanvasPixel(page, 150, 92);
  await expect(page.locator('#annot-modal')).toBeVisible();
  await page.locator('#annot-text').fill('Mitotic edge check');
  await page.locator('#annot-save').click();
  await expect(page.locator('#annot-modal')).not.toBeVisible();
  await expect(page.locator('#annot-list')).toContainText('Mitotic edge check');

  await page.evaluate(() => {
    window.__voxellabScreenshots = [];
    if (window.__voxellabScreenshotPatched) return;
    window.__voxellabScreenshotPatched = true;
    HTMLAnchorElement.prototype.click = function captureScreenshotClick() {
      const download = String(this.download || '');
      if (download.endsWith('.png') || download.endsWith('.tif')) {
        window.__voxellabScreenshots.push({ href: this.href, download });
      }
    };
  });
  await page.locator('#btn-shot').click();
  await expect.poll(() => page.evaluate(() => window.__voxellabScreenshots.at(-1)?.href || '')).toContain('data:image/png');
  const screenshot = await page.evaluate(() => window.__voxellabScreenshots.at(-1));
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
    let angleWhitePixels = 0;
    for (let py = 28; py <= 62; py += 1) {
      for (let px = 200; px <= 235; px += 1) {
        const offset = (py * canvas.width + px) * 4;
        if (data[offset] > 225 && data[offset + 1] > 225 && data[offset + 2] > 225) angleWhitePixels += 1;
      }
    }
    let annotationBrightPixels = 0;
    let annotationDarkPixels = 0;
    for (let py = 84; py <= 100; py += 1) {
      for (let px = 142; px <= 158; px += 1) {
        const offset = (py * canvas.width + px) * 4;
        if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] > 230) annotationBrightPixels += 1;
        if (data[offset] < 55 && data[offset + 1] < 55 && data[offset + 2] < 55) annotationDarkPixels += 1;
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
      angleWhitePixels,
      annotationBrightPixels,
      annotationDarkPixels,
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
  expect(metrics.angleWhitePixels, JSON.stringify(metrics)).toBeGreaterThan(40);
  expect(metrics.annotationBrightPixels, JSON.stringify(metrics)).toBeGreaterThan(60);
  expect(metrics.annotationDarkPixels, JSON.stringify(metrics)).toBeGreaterThan(15);

  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  await expect.poll(() => page.evaluate(() => window.__voxellabScreenshots.at(-1)?.href || '')).toContain('data:image/tiff');
  const tiff = await page.evaluate(() => window.__voxellabScreenshots.at(-1));
  expect(tiff.download).toMatch(/_z1_c2_t2\.tif$/);
  const tiffMetrics = await page.evaluate((href) => {
    const binary = atob(href.slice(href.indexOf(',') + 1));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const entryCount = view.getUint16(8, true);
    const tags = new Map();
    for (let i = 0; i < entryCount; i += 1) {
      const offset = 10 + i * 12;
      tags.set(view.getUint16(offset, true), {
        type: view.getUint16(offset + 2, true),
        count: view.getUint32(offset + 4, true),
        value: view.getUint32(offset + 8, true),
      });
    }
    const pixelOffset = tags.get(273).value;
    const pixelBytes = bytes.subarray(pixelOffset);
    const descriptionTag = tags.get(270);
    const description = new TextDecoder().decode(bytes.slice(descriptionTag.value, descriptionTag.value + descriptionTag.count)).replace(/\0$/, '');
    const rational = (tag) => {
      const offset = tags.get(tag).value;
      return view.getUint32(offset, true) / view.getUint32(offset + 4, true);
    };
    let roiBluePixels = 0;
    let angleWhitePixels = 0;
    let annotationBrightPixels = 0;
    let annotationDarkPixels = 0;
    const tiffWidth = tags.get(256).value;
    for (let i = 0; i < pixelBytes.length; i += 3) {
      if (pixelBytes[i] < 170 && pixelBytes[i + 1] > 160 && pixelBytes[i + 2] > 190) roiBluePixels += 1;
    }
    for (let py = 84; py <= 100; py += 1) {
      for (let px = 142; px <= 158; px += 1) {
        const offset = (py * tiffWidth + px) * 3;
        if (pixelBytes[offset] > 230 && pixelBytes[offset + 1] > 230 && pixelBytes[offset + 2] > 230) annotationBrightPixels += 1;
        if (pixelBytes[offset] < 55 && pixelBytes[offset + 1] < 55 && pixelBytes[offset + 2] < 55) annotationDarkPixels += 1;
      }
    }
    for (let py = 28; py <= 62; py += 1) {
      for (let px = 200; px <= 235; px += 1) {
        const offset = (py * tiffWidth + px) * 3;
        if (pixelBytes[offset] > 225 && pixelBytes[offset + 1] > 225 && pixelBytes[offset + 2] > 225) angleWhitePixels += 1;
      }
    }
    return {
      magic: [bytes[0], bytes[1], view.getUint16(2, true)],
      width: tags.get(256).value,
      height: tags.get(257).value,
      compression: tags.get(259).value,
      photometric: tags.get(262).value,
      samplesPerPixel: tags.get(277).value,
      description,
      xResolution: rational(282),
      yResolution: rational(283),
      resolutionUnit: tags.get(296).value,
      pixelByteCount: tags.get(279).value,
      roiBluePixels,
      angleWhitePixels,
      annotationBrightPixels,
      annotationDarkPixels,
    };
  }, tiff.href);
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width,
    height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    xResolution: 2,
    yResolution: 4,
    resolutionUnit: 1,
    pixelByteCount: width * height * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('unit=um');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=1.5');
  expect(tiffMetrics.description).toContain('label=Z 1 · C2 GFP · T2');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(20);
  expect(tiffMetrics.angleWhitePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(40);
  expect(tiffMetrics.annotationBrightPixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(60);
  expect(tiffMetrics.annotationDarkPixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(15);
});
