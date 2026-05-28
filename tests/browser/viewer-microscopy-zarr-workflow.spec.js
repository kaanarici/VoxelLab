/* global Buffer, Image */
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  drawEllipseRoi,
  dropFiles,
  expectScaleBarFits,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

function uint16LeChunk(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
  return buffer;
}

async function writeChunkedOmeZarrFixture(testInfo) {
  const files = [];
  const rootAttrsPath = testInfo.outputPath('zattrs.json');
  const levelArrayPath = testInfo.outputPath('zarray.json');
  for (let c = 0; c < 2; c += 1) {
    for (let cy = 0; cy < 2; cy += 1) {
      for (let cx = 0; cx < 2; cx += 1) {
        const yStart = cy * 48;
        const xStart = cx * 64;
        const values = [];
        for (let y = 0; y < 48; y += 1) {
          for (let x = 0; x < 64; x += 1) values.push(c * 1000 + (yStart + y) * 20 + xStart + x);
        }
        const chunkPath = testInfo.outputPath(`zarr-chunk-${c}-${cy}-${cx}.bin`);
        await writeFile(chunkPath, uint16LeChunk(values));
        files.push({ path: chunkPath, relativePath: `cells.zarr/0/${c}.${cy}.${cx}` });
      }
    }
  }
  await writeFile(rootAttrsPath, JSON.stringify({
    ome: {
      multiscales: [{
        version: '0.4',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
        }],
      }],
      omero: {
        channels: [{
          label: 'DAPI',
          color: '0000FF',
          family: 'linear',
          window: { min: 0, max: 4095, start: 100, end: 700 },
        }, {
          label: 'GFP',
          color: '00FF00',
          family: 'linear',
          window: { min: 0, max: 4095, start: 1000, end: 1700 },
        }],
      },
    },
  }));
  await writeFile(levelArrayPath, JSON.stringify({
    zarr_format: 2,
    shape: [2, 96, 128],
    chunks: [1, 48, 64],
    dtype: '<u2',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));
  return [
    { path: rootAttrsPath, relativePath: 'cells.zarr/.zattrs', mimeType: 'application/json' },
    { path: levelArrayPath, relativePath: 'cells.zarr/0/.zarray', mimeType: 'application/json' },
    ...files.map(file => ({ ...file, mimeType: 'application/octet-stream' })),
  ];
}

async function screenshotPngMetrics(page, pngPath) {
  const dataUrl = `data:image/png;base64,${(await readFile(pngPath)).toString('base64')}`;
  return page.evaluate(async (href) => {
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
    let scaleBarBrightPixels = 0;
    for (let y = Math.max(0, canvas.height - 18); y < canvas.height - 4; y += 1) {
      for (let x = Math.max(0, canvas.width - 90); x < canvas.width - 6; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] > 230) scaleBarBrightPixels += 1;
      }
    }
    let roiBluePixels = 0;
    for (let y = Math.floor(canvas.height * 0.30); y < Math.floor(canvas.height * 0.75); y += 1) {
      for (let x = Math.floor(canvas.width * 0.30); x < Math.floor(canvas.width * 0.75); x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] < 180 && data[offset + 1] > 130 && data[offset + 2] > 180) roiBluePixels += 1;
      }
    }
    let contextDarkPixels = 0;
    let contextBrightPixels = 0;
    for (let y = 8; y <= 34; y += 1) {
      for (let x = 8; x <= Math.min(126, canvas.width - 1); x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] < 55 && data[offset + 1] < 55 && data[offset + 2] < 55) contextDarkPixels += 1;
        if (data[offset] > 220 && data[offset + 1] > 220 && data[offset + 2] > 220) contextBrightPixels += 1;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      contextDarkPixels,
      contextBrightPixels,
      scaleBarBrightPixels,
      roiBluePixels,
    };
  }, dataUrl);
}

test('OME-Zarr microscopy ROI results export calibration and re-import safely', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const files = await writeChunkedOmeZarrFixture(testInfo);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', files);

  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-Zarr');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · LUT linear · range 100-700');

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('C1 DAPI');
  await expect(row).toContainText('µm²');
  const roiObjectId = await row.getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells');
  expect(cells[6]).toBe('ellipse');
  expect(cells[14]).toBe('DAPI');
  expect(cells[15]).toBe('0');
  const pixels = Number(cells[20]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(Number(cells[18]) - pixels * 0.125)).toBeLessThan(1e-6);
  expect(Math.abs(Number(cells[19]) - pixels * 0.00025 * 0.0005)).toBeLessThan(1e-12);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('ome-zarr-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source.format).toBe('OME-Zarr');
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' });
  expect(bundle.source.dataset.axes.map(axis => [axis.name, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 128, 'µm', 0.5, true],
    ['y', 96, 'µm', 0.25, true],
    ['z', 1, 'µm', 0, false],
    ['c', 2, '', 0, false],
    ['t', 1, 'index', 1, false],
  ]);
  expect(bundle.source.dataset.channels.map(channel => [channel.name, channel.color, channel.displayRange, channel.displayRangeSource])).toEqual([
    ['DAPI', '#0000FF', [100, 700], 'metadata'],
    ['GFP', '#00FF00', [1000, 1700], 'metadata'],
  ]);
  expect(bundle.rows[0]).toMatchObject({
    roiObjectId,
    kind: 'ellipse',
    channel: 'DAPI',
    channelIndex: 0,
    time: 1,
    timeIndex: 0,
    areaUnit: 'µm²',
  });

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z1_c1_t1\.png$/);
  const pngMetrics = await screenshotPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({ width: 128, height: 96 });
  expect(pngMetrics.contextDarkPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(600);
  expect(pngMetrics.contextBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(20);
  expect(pngMetrics.scaleBarBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(35);
  expect(pngMetrics.roiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(8);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toHaveAttribute('data-roi-object-id', roiObjectId);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
});
