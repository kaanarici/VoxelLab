/* global document, window */
import { expect, test } from '@playwright/test';

import { writeCalibratedTimeSeriesOmeTiff } from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  dropFiles,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function canvasChecksum(page) {
  return page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let index = 0; index < data.length; index += 4) {
      const pixel = index / 4;
      hash = (hash + data[index] * ((pixel % 997) + 1)) % 1_000_000_007;
    }
    return hash;
  });
}

test('OME-TIFF time-series import switches T without changing series or Z', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const omeTiffPath = testInfo.outputPath('cells-time.ome.tiff');
  await writeCalibratedTimeSeriesOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('cells-time');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta')).toContainText('Z 1 · C 1 · T 2');
  await waitForCanvasPaint(page, '#view');

  const timeSelect = page.locator('#microscopy-time-select');
  const stackStatus = page.locator('#microscopy-stack-controls .hyperstack-status');
  await expect(timeSelect).toBeVisible();
  await expect(timeSelect).toHaveValue('0');
  await expect(stackStatus).toHaveText('Z 1/1 · C 1/1 · T 1/2');
  const firstChecksum = await canvasChecksum(page);

  await timeSelect.selectOption('1');
  await expect(timeSelect).toHaveValue('1');
  await expect(stackStatus).toHaveText('Z 1/1 · C 1/1 · T 2/2');
  await expect(page.locator('#slice-cur')).toHaveText('1');
  await expect.poll(() => canvasChecksum(page)).not.toBe(firstChecksum);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    const time = document.getElementById('microscopy-time-select');
    return {
      seriesCount: state.manifest.series.length,
      sliceIdx: state.sliceIdx,
      channelIndex: series.microscopy?.channelIndex,
      timeIndex: series.microscopy?.timeIndex,
      localStackKeys: Object.keys(state._localMicroscopyStacks?.[series.slug] || {}).sort(),
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      timeSelectFits: !time || time.scrollWidth <= time.clientWidth + 1,
    };
  });
  expect(snapshot).toEqual({
    seriesCount: initialCount + 1,
    sliceIdx: 0,
    channelIndex: 0,
    timeIndex: 1,
    localStackKeys: ['0|0', '0|1'],
    rootScrollWidth: expect.any(Number),
    viewportWidth: expect.any(Number),
    timeSelectFits: true,
  });
  expect(snapshot.rootScrollWidth, JSON.stringify(snapshot)).toBeLessThanOrEqual(snapshot.viewportWidth + 1);
});
