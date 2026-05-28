/* global Buffer, document, innerWidth, window */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { writeCalibratedOmeTiff } from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  dropFiles,
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

test('microscopy ruler stores calibrated micrometer distance and renders without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-measure.ome.tiff');
  const pixels = Buffer.alloc(16 * 16, 64);
  pixels[8 * 16 + 4] = 120;
  pixels[8 * 16 + 8] = 220;
  await writeCalibratedOmeTiff(omeTiffPath, { pixels });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');

  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-measure').click();
  await clickCanvasPixel(page, 4, 8);
  await clickCanvasPixel(page, 8, 8);

  const label = page.locator('#overlay-svg .m-label');
  await expect(label).toHaveText('2.00 µm');
  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    const key = `${series.slug}|${state.sliceIdx}`;
    const measurement = state.measurements[key]?.[0] || null;
    const labelEl = document.querySelector('#overlay-svg .m-label');
    const labelRect = labelEl?.getBoundingClientRect();
    return {
      mm: measurement?.mm,
      unit: measurement?.unit,
      spacingKnown: measurement?.spacingKnown,
      x1: measurement?.x1,
      x2: measurement?.x2,
      y1: measurement?.y1,
      y2: measurement?.y2,
      label: labelEl?.textContent || '',
      labelFitsViewport: !!labelRect && labelRect.left >= -1 && labelRect.right <= innerWidth + 1,
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(snapshot).toMatchObject({
    unit: 'mm',
    spacingKnown: true,
    label: '2.00 µm',
  });
  expect(snapshot.mm, JSON.stringify(snapshot)).toBeCloseTo(0.002, 10);
  expect(snapshot.x1, JSON.stringify(snapshot)).toBeCloseTo(4, 6);
  expect(snapshot.x2, JSON.stringify(snapshot)).toBeCloseTo(8, 6);
  expect(snapshot.y1, JSON.stringify(snapshot)).toBeCloseTo(8, 6);
  expect(snapshot.y2, JSON.stringify(snapshot)).toBeCloseTo(8, 6);
  expect(snapshot.labelFitsViewport, JSON.stringify(snapshot)).toBe(true);
  expect(snapshot.rootScrollWidth, JSON.stringify(snapshot)).toBeLessThanOrEqual(snapshot.viewportWidth + 1);

  await page.locator('#roi-results-panel .sec-title').click();
  const row = page.locator('[data-roi-result-row]');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(row).toContainText('Line 1');
  await expect(row).toContainText('line');
  await expect(row).toContainText('Length');
  await expect(row).toContainText('2.00 µm');
  await expect(row).toContainText('Calibrated length');
  const objectId = await row.getAttribute('data-roi-object-id');
  expect(objectId).toMatch(/^measure:[^|]+\|0:1$/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  expect(cells[1]).toBe(objectId);
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('line');
  expect(cells[7]).toBe('Line 1');
  expect(Number(cells[8])).toBeCloseTo(6, 6);
  expect(Number(cells[9])).toBeCloseTo(8, 6);
  expect(Number(cells[11])).toBeCloseTo(2, 10);
  expect(Number(cells[12])).toBeCloseTo(0.002, 10);
  expect(cells[13]).toBe('');
  expect(cells[14]).toBe('DAPI');
  expect(cells[15]).toBe('0');
  expect(cells[16]).toBe('1');
  expect(cells[17]).toBe('0');
  expect(cells[26]).toBe('linear_measurement');
});
