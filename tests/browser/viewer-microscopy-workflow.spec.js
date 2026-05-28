/* global Buffer, Image, document, getComputedStyle, innerWidth, requestAnimationFrame */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedChannelTimeOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  drawEllipseRoi,
  drawPointRoi,
  dropFiles,
  expectScaleBarFits,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function writeFourPageHyperstackTiff(path, description, { width = 4, height = 3 } = {}) {
  const pageCount = 4;
  const descriptionBytes = Buffer.from(`${description}\0`, 'utf8');
  const ifdEntryCounts = [11, 10, 10, 10];
  const ifdOffsets = [];
  let cursor = 8;
  for (const entryCount of ifdEntryCounts) {
    ifdOffsets.push(cursor);
    cursor += 2 + entryCount * 12 + 4;
  }
  const descriptionOffset = cursor;
  cursor += descriptionBytes.length;
  const pixelOffsets = [];
  const pixelsByPage = Array.from({ length: pageCount }, (_, pageIndex) => {
    const pixels = Buffer.alloc(width * height);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = 20 + pageIndex * 45 + i;
    pixelOffsets.push(cursor);
    cursor += pixels.length;
    return pixels;
  });
  const buffer = Buffer.alloc(cursor);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffsets[0], 4);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    let ifdCursor = ifdOffsets[pageIndex];
    const entries = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 8],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      [273, 4, 1, pixelOffsets[pageIndex]],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, width * height],
      [339, 3, 1, 1],
    ];
    if (pageIndex === 0) entries.splice(5, 0, [270, 2, descriptionBytes.length, descriptionOffset]);
    buffer.writeUInt16LE(entries.length, ifdCursor);
    ifdCursor += 2;
    const writeEntry = (tag, type, count, value) => {
      buffer.writeUInt16LE(tag, ifdCursor);
      buffer.writeUInt16LE(type, ifdCursor + 2);
      buffer.writeUInt32LE(count, ifdCursor + 4);
      if (type === 3 && count === 1) buffer.writeUInt16LE(value, ifdCursor + 8);
      else buffer.writeUInt32LE(value, ifdCursor + 8);
      ifdCursor += 12;
    };
    for (const entry of entries) writeEntry(...entry);
    buffer.writeUInt32LE(ifdOffsets[pageIndex + 1] || 0, ifdCursor);
    pixelsByPage[pageIndex].copy(buffer, pixelOffsets[pageIndex]);
  }
  descriptionBytes.copy(buffer, descriptionOffset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeHyperstackImageJTiff(path, options = {}) {
  const description = [
    'ImageJ=1.54',
    'images=4',
    'channels=2',
    'slices=2',
    'frames=1',
    'hyperstack=true',
    'mode=grayscale',
    'unit=um',
    'pixel_width=0.5',
    'pixel_height=0.25',
    'spacing=1.5',
  ].join('\n');
  await writeFourPageHyperstackTiff(path, description, options);
}

async function drawLineMeasurement(page) {
  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-measure').click();
  const box = await page.locator('#view').boundingBox();
  const y = box.y + box.height * 0.55;
  await page.mouse.click(box.x + box.width * 0.25, y);
  await page.mouse.click(box.x + box.width * 0.75, y);
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
    const scaleY = canvas.height - 10;
    for (let x = Math.max(0, canvas.width - 130); x < canvas.width - 6; x += 1) {
      const offset = (scaleY * canvas.width + x) * 4;
      if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] > 230) scaleBarBrightPixels += 1;
    }
    let pointRoiBluePixels = 0;
    for (let y = Math.floor(canvas.height * 0.35); y < Math.floor(canvas.height * 0.65); y += 1) {
      for (let x = Math.floor(canvas.width * 0.35); x < Math.floor(canvas.width * 0.72); x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] < 180 && data[offset + 1] > 130 && data[offset + 2] > 180) pointRoiBluePixels += 1;
      }
    }
    let measurementWhitePixels = 0;
    for (let y = Math.floor(canvas.height * 0.52); y < Math.floor(canvas.height * 0.59); y += 1) {
      for (let x = Math.floor(canvas.width * 0.20); x < Math.floor(canvas.width * 0.80); x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] > 235 && data[offset + 1] > 235 && data[offset + 2] > 235) measurementWhitePixels += 1;
      }
    }
    let contextDarkPixels = 0;
    let contextBrightPixels = 0;
    for (let y = 10; y <= 34; y += 1) {
      for (let x = 10; x <= 150; x += 1) {
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
      pointRoiBluePixels,
      measurementWhitePixels,
    };
  }, dataUrl);
}

async function ensurePanelOpen(page, panelSelector, visibleSelector) {
  const panel = page.locator(panelSelector);
  const target = page.locator(visibleSelector);
  if (await panel.evaluate(el => el.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(target.first()).toBeVisible();
}

async function scaleBarSnapshot(page) {
  await expectScaleBarFits(page);
  return page.locator('#scale-bar').evaluate((bar) => ({
    label: document.getElementById('scale-bar-label')?.textContent || '',
    lineWidth: Math.round(document.getElementById('scale-bar-line')?.getBoundingClientRect().width || 0),
    aria: bar.getAttribute('aria-label') || '',
  }));
}

async function canvasPixel(page, x = 0, y = 0) {
  return page.locator('#view').evaluate((canvas, point) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

async function assertNoWorkflowOverflow(page) {
  const metrics = await page.evaluate(() => {
    const visibleRect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return null;
      return {
        selector,
        right: rect.right,
        bottom: rect.bottom,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    };
    const checked = [
      '#microscopy-channel-select',
      '#microscopy-channel-color',
      '#microscopy-time-select',
      '.hyperstack-channel-text',
      '.hyperstack-status',
      '#microscopy-split-preview',
      '#microscopy-calibration',
      '#scale-bar',
      '#microscopy-recipe-export',
      '#microscopy-recipe-import',
      '#microscopy-recipe-status',
      '[data-roi-result-row]',
      '#roi-results-export',
      '#roi-results-json-export',
      '#roi-results-json-import',
      '#roi-results-status',
    ].map(visibleRect).filter(Boolean);
    return {
      viewportWidth: innerWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      overflowing: checked.filter(item => item.overflow),
      outOfViewport: checked.filter(item => item.right > innerWidth + 1),
    };
  });
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.overflowing, JSON.stringify(metrics)).toEqual([]);
  expect(metrics.outOfViewport, JSON.stringify(metrics)).toEqual([]);
}

test('microscopy C/T workflow keeps calibration, channel rendering, ROI provenance, and CSV export aligned', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-channel-time.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('cells-channel-time');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#meta')).toContainText('Z 1 · C 2 · T 2');
  await waitForCanvasPaint(page, '#view');
  const initialScaleBar = await scaleBarSnapshot(page);

  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('0');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('#series-name')).toHaveText('cells-channel-time');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 1/1 · C 2/2 · T 2/2');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('GFP · 510 nm');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
  await page.locator('#microscopy-channel-color').fill('#aa00cc');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(170, 0, 204)');
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');
  expect(await scaleBarSnapshot(page)).toEqual(initialScaleBar);
  await expect(page.locator('#microscopy-split-preview')).toBeVisible();
  const splitPreview = await page.locator('#microscopy-split-preview').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      dapiPixel: Array.from(ctx.getImageData(5, 5, 1, 1).data),
      gfpPixel: Array.from(ctx.getImageData(22, 5, 1, 1).data),
      right: rect.right,
      viewportWidth: innerWidth,
    };
  });
  expect(splitPreview.width).toBe(33);
  expect(splitPreview.height).toBe(16);
  expect(splitPreview.dapiPixel[2], JSON.stringify(splitPreview)).toBeGreaterThan(0);
  expect(splitPreview.gfpPixel[0], JSON.stringify(splitPreview)).toBeGreaterThan(0);
  expect(splitPreview.gfpPixel[1], JSON.stringify(splitPreview)).toBe(0);
  expect(splitPreview.gfpPixel[2], JSON.stringify(splitPreview)).toBeGreaterThan(0);
  expect(splitPreview.right, JSON.stringify(splitPreview)).toBeLessThanOrEqual(splitPreview.viewportWidth + 1);

  const gfpPixel = await canvasPixel(page, 5, 5);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-composite-toggle');
  await page.locator('#microscopy-composite-toggle').check();
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C1 · DAPI');
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C2 · GFP');
  await expect.poll(() => canvasPixel(page, 5, 5)).not.toEqual(gfpPixel);
  const compositePixel = await canvasPixel(page, 5, 5);
  expect(compositePixel[0], JSON.stringify(compositePixel)).toBeGreaterThan(0);
  expect(compositePixel[1], JSON.stringify(compositePixel)).toBe(0);
  expect(compositePixel[2], JSON.stringify(compositePixel)).toBeGreaterThan(0);
  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('microscopy-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe).toMatchObject({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: { width: 16, height: 16, slices: 1, sizeZ: 1, sizeC: 2, sizeT: 2 },
    },
    stack: {
      channelIndex: 1,
      timeIndex: 1,
      compositeEnabled: true,
      compositeChannels: [true, true],
    },
  });
  expect(recipe.channels[1].color).toBe('#AA00CC');
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await page.locator('#microscopy-channel-color').fill('#0000ff');
  await page.locator('#microscopy-composite-toggle').uncheck();
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();
  await page.locator('#microscopy-composite-toggle').uncheck();
  await expect(page.locator('#microscopy-composite-toggle')).not.toBeChecked();

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  const row = page.locator('[data-roi-result-row]');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(row).toContainText('ROI 1');
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('T2');
  await expect(row).toContainText('µm²');
  await row.locator('.roi-result-name').fill('Nucleus A');
  await row.locator('.roi-result-name').press('Enter');
  await expect(row.locator('.roi-result-name')).toHaveText('Nucleus A');
  await expect(page.locator('#overlay-svg .roi-label')).toContainText('Nucleus A');
  const rowMetrics = await row.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(Object.keys(rowMetrics)).toEqual(['Area', 'Length', 'Count', 'Pixels', 'Mean', 'Std', 'Min', 'Max']);
  expect(Number(rowMetrics.Mean)).toBeGreaterThan(0);
  expect(Number(rowMetrics.Min)).toBeGreaterThanOrEqual(0);
  expect(Number(rowMetrics.Max)).toBeGreaterThanOrEqual(Number(rowMetrics.Min));
  const roiObjectId = await row.getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 1/1 · C 1/2 · T 1/2');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('T2');
  await expect(row).not.toHaveClass(/is-current/);
  await row.click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 1/1 · C 2/2 · T 2/2');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(row).toHaveClass(/is-current/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells-channel-time');
  const seriesSlug = cells[3];
  expect(seriesSlug).toMatch(/^micro_/);
  expect(cells[4]).toBe('1');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('ellipse');
  expect(cells[7]).toBe('Nucleus A');
  expect(cells[14]).toBe('GFP');
  expect(cells[15]).toBe('1');
  expect(cells[16]).toBe('2');
  expect(cells[17]).toBe('1');
  const areaUm2 = Number(cells[18]);
  const areaMm2 = Number(cells[19]);
  const pixels = Number(cells[20]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(areaUm2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(cells[25]).toBe('8-bit');
  expect(cells[26]).toBe('display_8bit');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('roi-results-roundtrip.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(jsonDownload.suggestedFilename()).toBe(`voxellab-roi-results-${seriesSlug}.json`);
  expect(bundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    series: { slug: seriesSlug, name: 'cells-channel-time', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy', format: 'OME-TIFF', warnings: [] },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.0015, displayUnit: 'µm' },
    rows: [{
      roiObjectId,
      slice: 1,
      sliceIndex: 0,
      kind: 'ellipse',
      label: 'Nucleus A',
      channel: 'GFP',
      channelIndex: 1,
      time: 2,
      timeIndex: 1,
      valueUnit: '8-bit',
      valueSource: 'display_8bit',
    }],
  });
  expect(bundle.rows[0].areaUnit).toBe('µm²');
  expect(bundle.rows[0].points.length).toBe(2);
  expect(bundle.rows[0].points[0].length).toBe(2);
  expect(Math.abs(bundle.rows[0].areaUnit2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(bundle.rows[0].areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(bundle.source.dataset.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 2, '', 0, false],
    ['t', 'time', 2, 'index', 1, false],
  ]);
  expect(bundle.source.dataset.channels.map(channel => [
    channel.index,
    channel.name,
    channel.color,
    channel.emissionWavelength,
    channel.emissionWavelengthUnit,
  ])).toEqual([
    [0, 'DAPI', '#0000FF', 460, 'nm'],
    [1, 'GFP', '#00FF00', 510, 'nm'],
  ]);
  expect(bundle.source.dataset.channels[0].displayColor === '' || bundle.source.dataset.channels[0].displayColor === '#0000FF').toBe(true);
  expect(bundle.source.dataset.channels[1].displayColor).toBe('#AA00CC');
  expect(bundle.source.dataset.channels[1].displayColorSource).toBe('user');
  expect(bundle.source.dataset.pixel).toMatchObject({ type: 'uint8', samplesPerPixel: 1, endianness: 'little' });
  expect(bundle.source.dataset.planes.map(plane => [plane.c, plane.z, plane.t, plane.pageIndex])).toEqual([
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [0, 0, 1, 2],
    [1, 0, 1, 3],
  ]);
  const displayFieldsBundlePath = testInfo.outputPath('roi-results-display-fields.json');
  const displayFieldsBundle = {
    ...bundle,
    rows: bundle.rows.map((resultRow) => {
      const { sliceIndex, channelIndex, timeIndex, ...displayOnlyRow } = resultRow;
      return displayOnlyRow;
    }),
  };
  await writeFile(displayFieldsBundlePath, `${JSON.stringify(displayFieldsBundle, null, 2)}\n`);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('[data-roi-result-row]')).toHaveCount(0);

  await page.locator('#roi-results-json-import-input').setInputFiles(displayFieldsBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('T2');
  await expect(row).toHaveClass(/is-current/);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      channelIndex: series.microscopy.channelIndex,
      channelName: series.microscopy.channelName,
      sourceColor: series.microscopyDataset.channels[1].color,
      displayColor: series.microscopyDataset.channels[1].displayColor,
      displayColorSource: series.microscopyDataset.channels[1].displayColorSource,
      timeIndex: series.microscopy.timeIndex,
      pixelSpacing: series.pixelSpacing,
      warnings: series.microscopyDataset.source.warnings,
      localStackKeys: Object.keys(state._localMicroscopyStacks[series.slug]).sort(),
    };
  });
  expect(snapshot).toEqual({
    channelIndex: 1,
    channelName: 'GFP',
    sourceColor: '#00FF00',
    displayColor: '#AA00CC',
    displayColorSource: 'user',
    timeIndex: 1,
    pixelSpacing: CALIBRATED_OME_TIFF.pixelSpacingMm,
    warnings: [],
    localStackKeys: ['0|0', '0|1', '1|0', '1|1'],
  });

  await assertNoWorkflowOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertNoWorkflowOverflow(page);
});

test('microscopy point count ROI exports C/T-scoped coordinates and count', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  const omeTiffPath = testInfo.outputPath('cells-point-count.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');

  await drawPointRoi(page);
  await drawPointRoi(page, 0.62, 0.58);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  const row = page.locator('[data-roi-result-row]');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(row).toContainText('point');
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('T2');
  const pointMetrics = await row.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(pointMetrics.Count).toBe('2');
  expect(pointMetrics.Pixels).toBe('2');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('point');
  expect(cells[7]).toBe('ROI 1');
  expect(Number(cells[8])).toBeGreaterThanOrEqual(0);
  expect(Number(cells[9])).toBeGreaterThanOrEqual(0);
  expect(cells[10]).toBe('2');
  expect(cells[14]).toBe('GFP');
  expect(cells[15]).toBe('1');
  expect(cells[16]).toBe('2');
  expect(cells[17]).toBe('1');
  expect(cells[20]).toBe('2');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('point-count-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.rows[0]).toMatchObject({
    kind: 'point',
    label: 'ROI 1',
    count: 2,
    channel: 'GFP',
    channelIndex: 1,
    time: 2,
    timeIndex: 1,
    pixels: 2,
  });
  expect(bundle.rows[0].points).toHaveLength(2);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const importedMetrics = await row.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(importedMetrics.Count).toBe('2');
  expect(importedMetrics.Pixels).toBe('2');
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(row).not.toHaveClass(/is-current/);
  await row.press('Enter');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(row).toHaveClass(/is-current/);

  const reexportPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const reexportDownload = await reexportPromise;
  const reexportBundle = JSON.parse(await readFile(await reexportDownload.path(), 'utf8'));
  expect(reexportBundle.rows[0].roiObjectId).toBe(bundle.rows[0].roiObjectId);
  expect(reexportBundle.rows[0].points).toEqual(bundle.rows[0].points);
  expect(reexportBundle.rows[0].count).toBe(2);
});

test('microscopy workflow recipes replay deterministically and fail closed on incompatible dimensions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1300, height: 860 });
  const omeTiffPath = testInfo.outputPath('cells-recipe.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');

  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await page.locator('#microscopy-channel-color').fill('#aa00cc');
  await page.locator('#microscopy-composite-toggle').check();
  await page.locator('#microscopy-composite-c0').check();
  await page.locator('#microscopy-composite-c1').uncheck();

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = await recipeDownload.path();
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe.schema).toBe('voxellab.microscopyWorkflowRecipe.v1');
  expect(recipe.stack.channelIndex).toBe(1);
  expect(recipe.stack.timeIndex).toBe(1);
  expect(recipe.stack.compositeEnabled).toBe(true);
  expect(recipe.stack.compositeChannels).toEqual([true, false]);

  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await page.locator('#microscopy-channel-color').fill('#00ff00');
  await page.locator('#microscopy-composite-toggle').uncheck();

  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();
  await expect(page.locator('#microscopy-composite-c0')).toBeChecked();
  await expect(page.locator('#microscopy-composite-c1')).not.toBeChecked();

  const stateBeforeFailure = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      channelIndex: series.microscopy.channelIndex,
      timeIndex: series.microscopy.timeIndex,
      color: series.microscopyDataset.channels[1].displayColor,
    };
  });
  const invalidRecipePath = testInfo.outputPath('cells-recipe-invalid.json');
  recipe.target.geometry.sizeC = 3;
  await writeFile(invalidRecipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(invalidRecipePath);
  await expect(page.locator('#microscopy-recipe-status')).toContainText('dimensions do not match');
  const stateAfterFailure = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      channelIndex: series.microscopy.channelIndex,
      timeIndex: series.microscopy.timeIndex,
      color: series.microscopyDataset.channels[1].displayColor,
    };
  });
  expect(stateAfterFailure).toEqual(stateBeforeFailure);
});

test('ImageJ hyperstack workflow supports calibrated count and line export, PNG proof, and JSON re-import', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const imageJPath = testInfo.outputPath('cells-imagej-workflow.tif');
  await writeHyperstackImageJTiff(imageJPath, { width: 256, height: 128 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: imageJPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej-workflow');
  await expect(page.locator('#series-desc')).toContainText('ImageJ-TIFF');
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-calibration')).toContainText('X 0.500 µm/px · Y 0.250 µm/px');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');

  await drawPointRoi(page, 0.45, 0.45);
  await drawPointRoi(page, 0.6, 0.55);
  await drawLineMeasurement(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);

  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  const rowTexts = await page.locator('[data-roi-result-row]').allTextContents();
  expect(rowTexts.some((text) => text.includes('point'))).toBe(true);
  expect(rowTexts.some((text) => text.includes('line'))).toBe(true);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const lines = csv.trim().split('\n');
  expect(lines.length).toBe(3);
  expect(lines.slice(1).map(line => line.split(',')[6]).sort()).toEqual(['line', 'point']);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('imagej-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.rows).toHaveLength(2);
  expect(bundle.rows.some((row) => row.kind === 'point' && row.count === 2)).toBe(true);
  expect(bundle.rows.some((row) => row.kind === 'line' && Number(row.lengthMm) > 0)).toBe(true);

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z1_c2_t1\.png$/);
  const pngMetrics = await screenshotPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({ width: 256, height: 128 });
  expect(pngMetrics.contextDarkPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(600);
  expect(pngMetrics.contextBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(25);
  expect(pngMetrics.scaleBarBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(80);
  expect(pngMetrics.pointRoiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(5);
  expect(pngMetrics.measurementWhitePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(40);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 2 result rows');
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  const pointObjectId = bundle.rows.find(row => row.kind === 'point')?.roiObjectId;
  const lineObjectId = bundle.rows.find(row => row.kind === 'line')?.roiObjectId;
  const importedPointRow = page.locator(`[data-roi-object-id="${pointObjectId}"]`);
  await expect(importedPointRow).toContainText('point');
  await expect(importedPointRow).toContainText('Count');
  await expect(importedPointRow).toContainText('Display-domain 8-bit intensity');
  const importedLineRow = page.locator(`[data-roi-object-id="${lineObjectId}"]`);
  await expect(importedLineRow).toContainText('line');
  await expect(importedLineRow).toContainText('µm');
  await expect(importedLineRow).toContainText('Calibrated length');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await page.locator('#microscopy-channel-select').selectOption('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(importedLineRow).not.toHaveClass(/is-current/);
  await importedLineRow.press('Enter');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(importedLineRow).toHaveClass(/is-current/);
});
