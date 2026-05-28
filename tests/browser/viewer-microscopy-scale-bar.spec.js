/* global document, getComputedStyle, innerWidth, requestAnimationFrame */
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  drawEllipseRoi,
  dropFiles,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function scaleBarQaSnapshot(page) {
  const metrics = await page.evaluate(async (fixture) => {
    const { state } = await import('/js/state.js');
    const visibleRect = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return null;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const intersects = (a, b) => !!a && !!b
      && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const scale = visibleRect(document.getElementById('scale-bar'));
    const line = document.getElementById('scale-bar-line');
    const label = document.getElementById('scale-bar-label');
    const canvas = document.getElementById('view');
    const series = state.manifest?.series?.[state.seriesIdx];
    const canvasCssWidth = Number.parseFloat(canvas?.style?.width || '') || canvas?.getBoundingClientRect?.().width || 0;
    const niceLengthMm = (idealMm) => {
      const power = 10 ** Math.floor(Math.log10(idealMm));
      const candidates = [1, 2, 5, 10].map(factor => factor * power);
      return candidates.reduce((best, next) =>
        Math.abs(next - idealMm) < Math.abs(best - idealMm) ? next : best, candidates[0]);
    };
    const formatUm = (lengthMm) => {
      const value = lengthMm / 0.001;
      return `${Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value.toPrecision(2)} µm`;
    };
    const rowMm = Number(series?.pixelSpacing?.[0]);
    const colMm = Number(series?.pixelSpacing?.[1]);
    const cssPxPerImagePx = canvasCssWidth / (canvas?.width || 0);
    const mmPerScreenPx = colMm / (cssPxPerImagePx * state.zoom);
    let expectedLengthMm = niceLengthMm(96 * mmPerScreenPx);
    let expectedWidthPx = expectedLengthMm / mmPerScreenPx;
    if (expectedWidthPx < 64) {
      expectedLengthMm = niceLengthMm(64 * mmPerScreenPx);
      expectedWidthPx = expectedLengthMm / mmPerScreenPx;
    } else if (expectedWidthPx > 150) {
      expectedLengthMm = niceLengthMm(150 * mmPerScreenPx);
      expectedWidthPx = expectedLengthMm / mmPerScreenPx;
    }
    const lineStyleWidth = Number.parseFloat(line?.style?.width || '');
    const chrome = [
      ['wl', document.getElementById('wl-overlay')],
      ['toolbar', document.querySelector('.controls')],
      ['measure-tools', document.querySelector('#toolbox-measure.open .toolbox-panel')],
      ['roi', document.querySelector('#overlay-svg .roi-group')],
      ...[...document.querySelectorAll('.orient-marker')]
        .filter((marker) => marker.textContent.trim())
        .map((marker, index) => [`orientation-${index}`, marker]),
    ].map(([name, el]) => ({ name, rect: visibleRect(el) })).filter((item) => item.rect);
    return {
      hidden: !scale,
      label: label?.textContent || '',
      aria: document.getElementById('scale-bar')?.getAttribute('aria-label') || '',
      expectedLabel: formatUm(expectedLengthMm),
      expectedWidthPx: Math.max(1, Math.round(expectedWidthPx)),
      rowMm,
      colMm,
      expectedRowMm: fixture.pixelSpacingMm[0],
      expectedColMm: fixture.pixelSpacingMm[1],
      lineWidth: line?.getBoundingClientRect().width || 0,
      lineStyleWidth,
      lineOverflow: line ? line.scrollWidth > line.clientWidth + 1 : false,
      labelOverflow: label ? label.scrollWidth > label.clientWidth + 1 : false,
      scale,
      chrome,
      conflicts: chrome.filter((item) => intersects(scale, item.rect)).map((item) => item.name),
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      zoom: state.zoom,
      tx: state.tx,
      ty: state.ty,
    };
  }, { pixelSpacingMm: CALIBRATED_OME_TIFF.pixelSpacingMm });
  expect(metrics.hidden, JSON.stringify(metrics)).toBe(false);
  expect(metrics.rowMm, JSON.stringify(metrics)).toBe(metrics.expectedRowMm);
  expect(metrics.colMm, JSON.stringify(metrics)).toBe(metrics.expectedColMm);
  expect(metrics.label, JSON.stringify(metrics)).toContain('µm');
  expect(metrics.label, JSON.stringify(metrics)).toBe(metrics.expectedLabel);
  expect(metrics.aria, JSON.stringify(metrics)).toContain(metrics.label);
  expect(metrics.lineWidth, JSON.stringify(metrics)).toBeGreaterThan(20);
  expect(metrics.lineStyleWidth, JSON.stringify(metrics)).toBe(metrics.expectedWidthPx);
  expect(Math.abs(metrics.lineWidth - metrics.expectedWidthPx), JSON.stringify(metrics)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(metrics.lineWidth - metrics.lineStyleWidth), JSON.stringify(metrics)).toBeLessThanOrEqual(0.5);
  expect(metrics.lineOverflow, JSON.stringify(metrics)).toBe(false);
  expect(metrics.labelOverflow, JSON.stringify(metrics)).toBe(false);
  expect(metrics.conflicts, JSON.stringify(metrics)).toEqual([]);
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  return metrics;
}

test('microscopy scale bar stays calibrated through zoom, pan, fit, and resize without chrome overlap', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-scale.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');
  await drawEllipseRoi(page);
  await page.keyboard.press('Escape');

  const initialFit = await scaleBarQaSnapshot(page);
  const wrap = await page.locator('#canvas-wrap').boundingBox();
  expect(wrap).toBeTruthy();
  await page.locator('#view').dblclick();
  const reset = await scaleBarQaSnapshot(page);
  expect(reset.zoom, JSON.stringify({ initialFit, reset })).toBeLessThan(initialFit.zoom);
  expect(reset.label, JSON.stringify({ initialFit, reset })).not.toBe(initialFit.label);

  await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -500);
  await page.keyboard.up('Control');
  const zoomed = await scaleBarQaSnapshot(page);
  expect(zoomed.zoom, JSON.stringify({ reset, zoomed })).toBeGreaterThan(reset.zoom);
  expect(zoomed.lineWidth, JSON.stringify({ reset, zoomed })).toBeGreaterThan(reset.lineWidth);

  const canvas = await page.locator('#view').boundingBox();
  expect(canvas).toBeTruthy();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 32, canvas.y + canvas.height / 2 + 18);
  await page.mouse.up();
  const panned = await scaleBarQaSnapshot(page);
  expect(Math.abs(panned.tx) + Math.abs(panned.ty), JSON.stringify(panned)).toBeGreaterThan(0);
  expect(panned.lineWidth, JSON.stringify({ zoomed, panned })).toBe(zoomed.lineWidth);

  await page.locator('#btn-zoomfit').click();
  const fit = await scaleBarQaSnapshot(page);
  expect(fit.tx, JSON.stringify(fit)).toBe(0);
  expect(fit.ty, JSON.stringify(fit)).toBe(0);

  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await scaleBarQaSnapshot(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const resized = await scaleBarQaSnapshot(page);
  expect(resized.scale.right, JSON.stringify(resized)).toBeLessThanOrEqual(resized.viewportWidth + 1);
});
