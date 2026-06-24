/* global document, HTMLAnchorElement, Image, URL, window */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeCalibratedOmeTiff } from './fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  assertShellFits,
  closeApp,
  launchVoxelLab,
} from './fixtures/electron-runtime-smoke-helpers.mjs';

async function ensurePanelOpen(page, panelSelector, visibleSelector) {
  const collapsed = await page.$eval(panelSelector, panel => panel.classList.contains('collapsed')).catch(() => false);
  if (collapsed) await page.click(`${panelSelector} .sec-title`);
  await page.waitForSelector(visibleSelector, { state: 'visible', timeout: 10_000 });
}

async function clickCanvasPixel(page, x, y) {
  const canvas = await page.locator('#view');
  const box = await canvas.boundingBox();
  assert.ok(box, 'viewer canvas must be visible');
  const size = await canvas.evaluate(el => ({ width: el.width, height: el.height }));
  await page.mouse.click(
    box.x + (x / size.width) * box.width,
    box.y + (y / size.height) * box.height,
  );
}

async function installDownloadCapture(page) {
  await page.evaluate(() => {
    if (window.__voxellabDownloadCaptureInstalled) {
      window.__voxellabCapturedDownloads = [];
      return;
    }
    window.__voxellabDownloadCaptureInstalled = true;
    window.__voxellabCapturedDownloads = [];
    window.__voxellabDownloadBlobs = new Map();
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      const url = originalCreateObjectUrl(blob);
      window.__voxellabDownloadBlobs.set(url, blob);
      return url;
    };
    HTMLAnchorElement.prototype.click = function captureBlobDownload() {
      const blob = window.__voxellabDownloadBlobs.get(this.href);
      if (this.href?.startsWith('data:') && this.download) {
        window.__voxellabCapturedDownloads.push({
          download: this.download,
          type: this.href.slice(5, this.href.indexOf(';')),
          href: this.href,
          text: '',
          ready: true,
        });
        return;
      }
      if (blob && this.download) {
        const record = { download: this.download, type: blob.type, text: '', ready: false };
        window.__voxellabCapturedDownloads.push(record);
        blob.text().then((text) => {
          record.text = text;
          record.ready = true;
        });
        return;
      }
      return originalClick.call(this);
    };
  });
}

async function capturedDownloadCount(page) {
  return page.evaluate(() => window.__voxellabCapturedDownloads?.length || 0);
}

async function latestCapturedDownload(page, previousCount = 0) {
  await page.waitForFunction(count => (
    (window.__voxellabCapturedDownloads?.length || 0) > count
    && window.__voxellabCapturedDownloads.at(-1)?.ready === true
  ), previousCount, { timeout: 10_000 });
  return page.evaluate(() => window.__voxellabCapturedDownloads.at(-1));
}

test('Electron runtime supports calibrated microscopy measure, annotation, CSV, PNG, and recipe export', { timeout: 45_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-electron-microscopy-workflow-'));
  const omeTiffPath = path.join(tempDir, 'workflow-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'workflow-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => document.getElementById('meta')?.textContent?.includes('Trusted metadata'), null, { timeout: 10_000 });
    await installDownloadCapture(page);

    await page.locator('#toolbox-measure .toolbox-trigger').click();
    await page.locator('#btn-measure').click();
    await clickCanvasPixel(page, 4, 8);
    await clickCanvasPixel(page, 8, 8);
    await page.waitForFunction(() => document.querySelector('#overlay-svg .m-label')?.textContent === '2.00 µm', null, { timeout: 10_000 });

    await page.locator('#toolbox-measure .toolbox-trigger').click();
    await page.locator('#btn-annot').click();
    await clickCanvasPixel(page, 12, 12);
    await page.waitForSelector('#annot-modal', { state: 'visible', timeout: 10_000 });
    await page.locator('#annot-text').fill('Desktop note');
    await page.locator('#annot-save').click();
    await page.waitForSelector('#annot-modal', { state: 'hidden', timeout: 10_000 });
    await page.waitForFunction(() => /Desktop note/.test(document.getElementById('annot-list')?.textContent || ''), null, { timeout: 10_000 });

    let previousDownloadCount = await capturedDownloadCount(page);
    await page.locator('#btn-shot').click();
    const pngDownload = await latestCapturedDownload(page, previousDownloadCount);
    assert.match(pngDownload.download, /_z1_c1_t1\.png$/);
    assert.equal(pngDownload.type, 'image/png');
    const pngMetrics = await page.evaluate(async (href) => {
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
      let measurementWhitePixels = 0;
      for (let y = Math.floor(canvas.height * 0.45); y < Math.floor(canvas.height * 0.60); y += 1) {
        for (let x = Math.floor(canvas.width * 0.20); x < Math.floor(canvas.width * 0.65); x += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset] > 235 && data[offset + 1] > 235 && data[offset + 2] > 235) measurementWhitePixels += 1;
        }
      }
      let annotationBrightPixels = 0;
      let annotationDarkPixels = 0;
      for (let y = Math.floor(canvas.height * 0.65); y < canvas.height; y += 1) {
        for (let x = Math.floor(canvas.width * 0.65); x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220) annotationBrightPixels += 1;
          if (data[offset] < 70 && data[offset + 1] < 70 && data[offset + 2] < 70) annotationDarkPixels += 1;
        }
      }
      return {
        width: canvas.width,
        height: canvas.height,
        measurementWhitePixels,
        annotationPixels: annotationBrightPixels + annotationDarkPixels,
      };
    }, pngDownload.href);
    assert.deepEqual({ width: pngMetrics.width, height: pngMetrics.height }, { width: 16, height: 16 });
    assert.ok(pngMetrics.measurementWhitePixels > 0, JSON.stringify(pngMetrics));
    assert.ok(pngMetrics.annotationPixels > 0, JSON.stringify(pngMetrics));

    await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
    await page.waitForFunction(() => document.getElementById('roi-results-count')?.textContent === '1', null, { timeout: 10_000 });
    const row = await page.$eval('[data-roi-result-row]', item => ({
      objectId: item.getAttribute('data-roi-object-id'),
      text: item.textContent || '',
    }));
    assert.match(row.objectId || '', /^measure:[^|]+\|0:1$/);
    assert.match(row.text, /Line 1/);
    assert.match(row.text, /2\.00 µm/);
    assert.match(row.text, /workflow-cells\.ome\.tiff/);

    previousDownloadCount = await capturedDownloadCount(page);
    await page.locator('#roi-results-export').click();
    const csvDownload = await latestCapturedDownload(page, previousDownloadCount);
    assert.match(csvDownload.download, /^voxellab-roi-results-.+\.csv$/);
    assert.match(csvDownload.type, /^text\/csv/);
    const csv = csvDownload.text;
    const [header, line] = csv.trim().split('\n');
    const columns = header.split(',');
    const cells = line.split(',');
    const values = Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? '']));
    assert.equal(values.roi_object_id, row.objectId);
    assert.equal(values.kind, 'line');
    assert.equal(values.label, 'Line 1');
    assert.equal(values.channel, 'DAPI');
    assert.equal(values.source_format, 'OME-TIFF');
    assert.equal(values.source_files, 'workflow-cells.ome.tiff');
    assert.equal(values.calibration_source, 'metadata');
    assert.equal(values.spacing_trust, 'Trusted metadata');
    assert.equal(values.xy_spacing_row_mm, '0.00025');
    assert.equal(values.xy_spacing_col_mm, '0.0005');
    assert.ok(Math.abs(Number(values.length_um) - 2) < 1e-10);
    assert.ok(Math.abs(Number(values.length_mm) - 0.002) < 1e-10);

    await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-recipe-export');
    previousDownloadCount = await capturedDownloadCount(page);
    await page.locator('#microscopy-recipe-export').click();
    const recipeDownload = await latestCapturedDownload(page, previousDownloadCount);
    assert.match(recipeDownload.download, /^voxellab-microscopy-workflow-.+\.json$/);
    assert.match(recipeDownload.type, /^application\/json/);
    const recipe = JSON.parse(recipeDownload.text);
    assert.equal(recipe.schema, 'voxellab.microscopyWorkflowRecipe.v1');
    assert.equal(recipe.target.imageDomain, 'microscopy');
    assert.equal(recipe.target.sourceFormat, 'OME-TIFF');
    assert.deepEqual(recipe.target.geometry, {
      width: 16,
      height: 16,
      slices: 1,
      sizeZ: 1,
      sizeC: 1,
      sizeT: 1,
    });
    assert.equal(recipe.requirements.calibrationRequired, true);
    assert.equal(recipe.requirements.measurementPrerequisite, 'results-present');
    assert.equal(recipe.roiResults.source.format, 'OME-TIFF');
    assert.deepEqual(recipe.roiResults.source.sourceFiles, ['workflow-cells.ome.tiff']);
    assert.equal(recipe.roiResults.rows[0].roiObjectId, row.objectId);
    assert.equal(recipe.roiResults.rows[0].kind, 'line');
    assert.equal(recipe.roiResults.rows[0].lengthUnitValue, 2);

    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.path, omeTiffPath);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});
