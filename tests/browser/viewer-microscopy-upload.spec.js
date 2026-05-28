/* global Buffer, Event, File, document, innerHeight, innerWidth, requestAnimationFrame, window */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  drawEllipseRoi,
  dropFiles,
  expectScaleBarFits,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function writeTinySequenceTiff(path, pixels, options = {}) {
  const width = options.width || pixels.length;
  const height = options.height || 1;
  expect(pixels.length).toBe(width * height);
  const entries = 10;
  const ifdOffset = 8;
  const pixelOffset = ifdOffset + 2 + entries * 12 + 4;
  const buffer = Buffer.alloc(pixelOffset + pixels.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  const writeEntry = (tag, type, count, value) => {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(count, cursor + 4);
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, cursor + 8);
    else buffer.writeUInt32LE(value, cursor + 8);
    cursor += 12;
  };
  for (const entry of [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixels.length],
    [339, 3, 1, 1],
  ]) writeEntry(...entry);
  buffer.writeUInt32LE(0, cursor);
  Buffer.from(pixels).copy(buffer, pixelOffset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function sequencePlane(width, height, base) {
  return Array.from({ length: width * height }, (_, index) => (base + index) % 256);
}

function uint16LeChunk(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
  return buffer;
}

async function writeFourPageHyperstackTiff(path, description) {
  const width = 4;
  const height = 3;
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
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = pageIndex < 2
        ? 20 + pageIndex * 55 + i
        : 230 - (pageIndex - 2) * 35 - i * 2;
    }
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

async function writeHyperstackOmeTiff(path) {
  const description = '<OME><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="4" SizeY="3" SizeZ="2" SizeC="2" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.25" PhysicalSizeZ="1.5" PhysicalSizeXUnit="µm"><Channel ID="Channel:0:0" Name="DAPI" Color="65535" EmissionWavelength="460" EmissionWavelengthUnit="nm"/><Channel ID="Channel:0:1" Name="GFP" Color="16711935" EmissionWavelength="510" EmissionWavelengthUnit="nm"/></Pixels></Image></OME>';
  await writeFourPageHyperstackTiff(path, description);
}

async function writeHyperstackImageJTiff(path) {
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
  await writeFourPageHyperstackTiff(path, description);
}

async function dropDirectory(page, selector, rootName, files) {
  const payload = await Promise.all(files.map(async ({ path, mimeType = 'application/octet-stream', relativePath }) => ({
    bytes: Array.from(await readFile(path)),
    name: path.split('/').pop(),
    mimeType,
    relativePath,
  })));
  const dataTransfer = await page.evaluateHandle(({ rootName: directoryName, items }) => {
    const directory = (name) => ({
      name,
      isFile: false,
      isDirectory: true,
      children: [],
      createReader() {
        const children = this.children;
        let sent = false;
        return {
          readEntries(resolve) {
            const batch = sent ? [] : children;
            sent = true;
            resolve(batch);
          },
        };
      },
    });
    const fileEntry = (item) => ({
      name: item.name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
      },
    });
    const root = directory(directoryName);
    for (const item of items) {
      const parts = item.relativePath.split('/').filter(Boolean);
      let cursor = root;
      for (const part of parts.slice(0, -1)) {
        let child = cursor.children.find(entry => entry.isDirectory && entry.name === part);
        if (!child) {
          child = directory(part);
          cursor.children.push(child);
        }
        cursor = child;
      }
      cursor.children.push(fileEntry({ ...item, name: parts.at(-1) || item.name }));
    }
    return { files: [], items: [{ webkitGetAsEntry: () => root }] };
  }, { rootName, items: payload });
  await page.locator(selector).evaluate((target, transfer) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, dataTransfer);
}

async function assertNoViewportOverflow(page) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const panel = document.getElementById('roi-results-panel');
    const exportButton = document.getElementById('roi-results-export');
    const jsonExportButton = document.getElementById('roi-results-json-export');
    const exportRect = exportButton?.getBoundingClientRect();
    const jsonExportRect = jsonExportButton?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-roi-result-row]')];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      panelRight: panel ? Math.ceil(panel.getBoundingClientRect().right) : 0,
      exportFits: !exportRect || (exportRect.left >= -1 && exportRect.right <= innerWidth + 1),
      jsonExportFits: !jsonExportRect || (jsonExportRect.left >= -1 && jsonExportRect.right <= innerWidth + 1),
      visibleRowsFit: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
      visibleMetricCellsFit: [...document.querySelectorAll('.roi-result-metrics b')]
        .every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
    };
  });
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.exportFits, JSON.stringify(metrics)).toBe(true);
  expect(metrics.jsonExportFits, JSON.stringify(metrics)).toBe(true);
  expect(metrics.visibleRowsFit, JSON.stringify(metrics)).toBe(true);
  expect(metrics.visibleMetricCellsFit, JSON.stringify(metrics)).toBe(true);
}

async function openDetailsPanelForViewport(page, viewport) {
  if (viewport.width > 1100) return;
  const rightPanel = page.locator('aside.right');
  if (!(await rightPanel.evaluate((panel) => panel.classList.contains('mobile-open')))) {
    await page.locator('#btn-show-right').click();
  }
  await expect(rightPanel).toHaveClass(/mobile-open/);
  await page.waitForFunction(() => {
    const panel = document.querySelector('aside.right');
    if (!panel?.classList.contains('mobile-open')) return false;
    const rect = panel.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
}

test('upload modal can drag-and-drop a local OME-TIFF microscopy image with micron metadata', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Slice thickness' })).toContainText('1.50 µm');
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      physicalUnit: series.microscopy?.physicalUnit,
      pixelSpacing: series.pixelSpacing,
      sliceThickness: series.sliceThickness,
      spacingKnown: series._spacingKnown,
      sliceSpacingKnown: series._sliceSpacingKnown,
      hasRaw: series.hasRaw,
      rawCached: !!state._localRawVolumes?.[series.slug],
      capability: series.reconstructionCapability,
    };
  });
  expect(stateSnapshot).toEqual({
    imageDomain: 'microscopy',
    physicalUnit: 'µm',
    pixelSpacing: CALIBRATED_OME_TIFF.pixelSpacingMm,
    sliceThickness: CALIBRATED_OME_TIFF.sliceThicknessMm,
    spacingKnown: true,
    sliceSpacingKnown: true,
    hasRaw: false,
    rawCached: false,
    capability: '2d-only',
  });
});

test('local microscopy upload clears the public empty-state viewer chrome', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('public-empty-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
    });
  });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);

  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('public-empty-cells');
  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#canvas-wrap')).not.toHaveClass(/no-series/);
  await expect(page.locator('#empty-state')).toBeHidden();
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#view')).toBeVisible();
  await expectScaleBarFits(page);
});

test('upload modal can open signed grayscale OME-TIFF microscopy planes', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('signed-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { width: 2, height: 1, pixels: [-128, 127], sampleFormat: 2 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('signed-cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal opens a local uncompressed chunked OME-Zarr microscopy array', async ({ page }, testInfo) => {
  const rootAttrsPath = testInfo.outputPath('zattrs.json');
  const levelArrayPath = testInfo.outputPath('zarray.json');
  const chunks = [];
  for (let c = 0; c < 2; c += 1) {
    for (let cy = 0; cy < 2; cy += 1) {
      for (let cx = 0; cx < 2; cx += 1) {
        const yStart = cy * 2;
        const xStart = cx * 5;
        const ySize = Math.min(2, 4 - yStart);
        const xSize = Math.min(5, 8 - xStart);
        const values = [];
        for (let y = 0; y < ySize; y += 1) {
          for (let x = 0; x < xSize; x += 1) values.push((c * 1000) + ((yStart + y) * 100) + ((xStart + x) * 10));
        }
        const chunkPath = testInfo.outputPath(`zarr-chunk-${c}-${cy}-${cx}.bin`);
        await writeFile(chunkPath, uint16LeChunk(values));
        chunks.push({ path: chunkPath, relativePath: `0/${c}.${cy}.${cx}`, mimeType: 'application/octet-stream' });
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
          window: { min: 0, max: 4095, start: 100, end: 220 },
        }, {
          label: 'GFP',
          color: '00FF00',
          family: 'linear',
          window: { min: 0, max: 4095, start: 10, end: 1800 },
        }],
      },
    },
  }));
  await writeFile(levelArrayPath, JSON.stringify({
    zarr_format: 2,
    shape: [2, 4, 8],
    chunks: [1, 2, 5],
    dtype: '<u2',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await dropDirectory(page, '#upload-zone', 'cells.zarr', [
    { path: rootAttrsPath, relativePath: '.zattrs', mimeType: 'application/json' },
    { path: levelArrayPath, relativePath: '0/.zarray', mimeType: 'application/json' },
    ...chunks,
  ]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-Zarr');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  await page.locator('#microscopy-stack-panel .sec-title').click();
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · LUT linear · range 100-220');
  await expect(page.locator('#microscopy-display-range-min')).toHaveValue('100');
  await expect(page.locator('#microscopy-display-range-max')).toHaveValue('220');
  const rangeMetaUi = await page.locator('.hyperstack-channel-meta').evaluate((row) => {
    const text = row.querySelector('.hyperstack-channel-text');
    return {
      textOverflow: text.scrollWidth > text.clientWidth + 1,
      rowWidth: Math.round(row.getBoundingClientRect().width),
      textWidth: Math.round(text.getBoundingClientRect().width),
    };
  });
  expect(rangeMetaUi.textOverflow).toBe(false);
  expect(rangeMetaUi.textWidth).toBeLessThanOrEqual(rangeMetaUi.rowWidth);
  const beforeRangePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(3, 1, 1, 1).data);
  });
  await page.locator('#microscopy-display-range-min').evaluate((input) => {
    input.value = '0';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#microscopy-display-range-max').evaluate((input) => {
    input.value = '370';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#microscopy-display-range-min')).toHaveValue('0');
  await expect(page.locator('#microscopy-display-range-max')).toHaveValue('370');
  const afterRangePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(3, 1, 1, 1).data);
  });
  expect(afterRangePixel).not.toEqual(beforeRangePixel);
  const rangeControlUi = await page.locator('.hyperstack-range-group').evaluate((group) => ({
    scrollWidth: group.scrollWidth,
    clientWidth: group.clientWidth,
    minOverflow: group.querySelector('#microscopy-display-range-min').scrollWidth > group.querySelector('#microscopy-display-range-min').clientWidth + 1,
    maxOverflow: group.querySelector('#microscopy-display-range-max').scrollWidth > group.querySelector('#microscopy-display-range-max').clientWidth + 1,
  }));
  expect(rangeControlUi.scrollWidth).toBeLessThanOrEqual(rangeControlUi.clientWidth + 1);
  expect(rangeControlUi.minOverflow).toBe(false);
  expect(rangeControlUi.maxOverflow).toBe(false);

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      physicalUnit: series.microscopy?.physicalUnit,
      pixelSpacing: series.pixelSpacing,
      sizeC: series.microscopy?.sizeC,
      sourceFormat: series.microscopyDataset?.source.originalFormat,
      localStackKeys: Object.keys(state._localMicroscopyStacks?.[series.slug] || {}).sort(),
      displayRangeSource: series.microscopyDataset?.channels?.[0]?.displayRangeSource,
      displayRange: series.microscopyDataset?.channels?.[0]?.displayRange,
      rawRange: state._localMicroscopyStacks?.[series.slug]?.['0|0']?.[0]?._microscopyRawRange,
      displayByteRange: state._localMicroscopyStacks?.[series.slug]?.['0|0']?.[0]?._microscopyDisplayByteRange,
    };
  });
  expect(stateSnapshot).toMatchObject({
    imageDomain: 'microscopy',
    physicalUnit: 'µm',
    pixelSpacing: [0.00025, 0.0005],
    sizeC: 2,
    sourceFormat: 'OME-Zarr',
    localStackKeys: ['0|0', '1|0'],
    displayRangeSource: 'user',
    displayRange: [0, 370],
    rawRange: [0, 370],
  });
  expect(stateSnapshot.displayByteRange).toEqual([0, 255]);
});

test('upload modal rejects mixed microscopy TIFF and DICOM selections', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('mixed-cells.ome.tiff');
  const dicomPath = testInfo.outputPath('mixed-source.dcm');
  await writeCalibratedOmeTiff(omeTiffPath);
  await mkdir(dirname(dicomPath), { recursive: true });
  await writeFile(dicomPath, Buffer.from([0, 1, 2, 3]));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: dicomPath, mimeType: 'application/dicom' },
  ]);

  await expect(page.locator('#upload-status')).toContainText('Import microscopy TIFF files separately');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
});

test('upload modal groups a local TIFF image sequence into one microscopy Z stack', async ({ page }, testInfo) => {
  const sequencePaths = [
    testInfo.outputPath('seq_z003.tif'),
    testInfo.outputPath('seq_z001.tif'),
    testInfo.outputPath('seq_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], [240, 250, 255]);
  await writeTinySequenceTiff(sequencePaths[1], [20, 30, 40]);
  await writeTinySequenceTiff(sequencePaths[2], [120, 130, 140]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_z');
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await expect(page.locator('#slice-tot')).toHaveText('3');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#scale-bar')).toBeHidden();
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 2 warnings');
  await page.locator('#microscopy-calibration-x').fill('0.5');
  await page.locator('#microscopy-calibration-y').fill('0.25');
  await page.locator('#microscopy-calibration-z').fill('1.5');
  await page.locator('#microscopy-calibration-apply').click();
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');
  await expect(page.locator('#microscopy-recipe-export')).toBeVisible();
  await expect(page.locator('#microscopy-recipe-import')).toBeVisible();

  await page.locator('#scrub').evaluate((input) => {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('3');
  await waitForCanvasPaint(page, '#view');

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      sourceFiles: series.microscopy?.sourceFiles,
      axes: series.microscopyDataset?.axes.map(axis => [axis.name, axis.size]),
      sourceFormat: series.microscopyDataset?.source.originalFormat,
      orderStrategy: series.microscopy?.sequenceProvenance?.orderStrategy,
      provenanceNames: series.microscopyDataset?.source.provenance?.planes.map(plane => plane.name),
      sourceWarnings: series.microscopyDataset?.source.warnings,
      pixelSpacing: series.pixelSpacing,
      sliceSpacing: series.sliceSpacing,
      axesCalibration: series.microscopyDataset?.axes
        .filter(axis => ['x', 'y', 'z'].includes(axis.name))
        .map(axis => [axis.name, axis.scale, axis.unit, axis.known]),
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(snapshot).toEqual({
    imageDomain: 'microscopy',
    sourceFiles: ['seq_z001.tif', 'seq_z002.tif', 'seq_z003.tif'],
    axes: [['x', 3], ['y', 1], ['z', 3], ['c', 1], ['t', 1]],
    sourceFormat: 'TIFF sequence',
    orderStrategy: 'numeric-suffix',
    provenanceNames: ['seq_z001.tif', 'seq_z002.tif', 'seq_z003.tif'],
    sourceWarnings: [],
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.0015,
    axesCalibration: [['x', 0.5, 'µm', true], ['y', 0.25, 'µm', true], ['z', 1.5, 'µm', true]],
    localStackCount: 1,
    rootScrollWidth: expect.any(Number),
    viewportWidth: expect.any(Number),
  });
  expect(snapshot.rootScrollWidth).toBeLessThanOrEqual(snapshot.viewportWidth + 1);
});

test('manual calibrated TIFF sequence supports trusted ROI export and re-import', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const width = 96;
  const height = 64;
  const sequencePaths = [
    testInfo.outputPath('seq_workflow_z003.tif'),
    testInfo.outputPath('seq_workflow_z001.tif'),
    testInfo.outputPath('seq_workflow_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], sequencePlane(width, height, 180), { width, height });
  await writeTinySequenceTiff(sequencePaths[1], sequencePlane(width, height, 20), { width, height });
  await writeTinySequenceTiff(sequencePaths[2], sequencePlane(width, height, 90), { width, height });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#scale-bar')).toBeHidden();

  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await page.locator('#microscopy-calibration-x').fill('0.5');
  await page.locator('#microscopy-calibration-y').fill('0.25');
  await page.locator('#microscopy-calibration-z').fill('2');
  await page.locator('#microscopy-calibration-apply').click();
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 2.00 µm');
  await expectScaleBarFits(page);

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await waitForCanvasPaint(page, '#view');

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = await recipeDownload.path();
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe.target.sourceFormat).toBe('TIFF sequence');
  expect(recipe.requirements).toMatchObject({ calibrationRequired: true, measurementPrerequisite: 'none' });
  expect(recipe.view.sliceIndex).toBe(1);

  const replaySequencePaths = [
    testInfo.outputPath('seq_replay_z003.tif'),
    testInfo.outputPath('seq_replay_z001.tif'),
    testInfo.outputPath('seq_replay_z002.tif'),
  ];
  await writeTinySequenceTiff(replaySequencePaths[0], sequencePlane(width, height, 210), { width, height });
  await writeTinySequenceTiff(replaySequencePaths[1], sequencePlane(width, height, 40), { width, height });
  await writeTinySequenceTiff(replaySequencePaths[2], sequencePlane(width, height, 120), { width, height });
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_replay_z');
  await expect(page.locator('#scale-bar')).toBeHidden();
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Recipe requires calibrated XY spacing, but this series is uncalibrated.');
  await expect(page.locator('#slice-cur')).toHaveText('1');

  await page.locator('#microscopy-calibration-x').fill('0.5');
  await page.locator('#microscopy-calibration-y').fill('0.25');
  await page.locator('#microscopy-calibration-z').fill('2');
  await page.locator('#microscopy-calibration-apply').click();
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expectScaleBarFits(page);

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('Z 2');
  await expect(row).toContainText('µm²');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  expect(cells[4]).toBe('2');
  expect(cells[5]).toBe('1');
  expect(cells[6]).toBe('ellipse');
  expect(Number(cells[18])).toBeGreaterThan(0);
  expect(Number(cells[19])).toBeGreaterThan(0);
  expect(Number(cells[20])).toBeGreaterThan(0);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = await jsonDownload.path();
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source.format).toBe('TIFF sequence');
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.002 });
  expect(bundle.rows[0]).toMatchObject({ slice: 2, sliceIndex: 1, kind: 'ellipse', areaUnit: 'µm²' });
  expect(bundle.source.dataset.axes.filter(axis => ['x', 'y', 'z'].includes(axis.name)).map(axis => [axis.name, axis.scale, axis.unit, axis.known])).toEqual([
    ['x', 0.5, 'µm', true],
    ['y', 0.25, 'µm', true],
    ['z', 2, 'µm', true],
  ]);

  const mismatchedBundlePath = testInfo.outputPath('mismatched-roi-results.json');
  await writeFile(mismatchedBundlePath, `${JSON.stringify({
    ...bundle,
    calibration: { ...bundle.calibration, rowMm: 0.001 },
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(mismatchedBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('ROI bundle calibration does not match this microscopy stack');
  await expect(page.locator('#roi-results-count')).toHaveText('1');

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  const pngBytes = await readFile(await pngDownload.path());
  expect(pngDownload.suggestedFilename()).toMatch(/_z2_c1_t1\.png$/);
  expect(pngBytes.length).toBeGreaterThan(50);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const importedRow = page.locator('[data-roi-result-row]');
  await expect(importedRow).toHaveAttribute('data-roi-object-id', bundle.rows[0].roiObjectId);
  await expect(importedRow).toContainText('Z 2');
  await expect(importedRow).toContainText('µm²');
  await expect(importedRow).toContainText('Display-domain 8-bit intensity');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
});

test('microscopy ROI results render calibrated rows and export CSV without layout overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-roi.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');

  await page.locator('#roi-results-panel .sec-title').click();
  await expect(page.locator('#roi-results')).toContainText('No ROI results');
  await expect(page.locator('#roi-results-export')).toBeDisabled();
  await expect(page.locator('#roi-results-json-export')).toBeDisabled();

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('ROI 1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('µm²');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Display-domain 8-bit intensity');
  const roiObjectId = await page.locator('[data-roi-result-row]').getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csvPath = await download.path();
  const csv = await readFile(csvPath, 'utf8');
  const csvLines = csv.trim().split('\n');
  expect(csvLines[0]).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = csvLines[1].split(',');
  expect(cells[0]).toBe('1');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells-roi');
  expect(cells[4]).toBe('1');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('ellipse');
  expect(cells[7]).toBe('ROI 1');
  expect(cells[14]).toBe('DAPI');
  expect(cells[15]).toBe('0');
  const areaUm2 = Number(cells[18]);
  const areaMm2 = Number(cells[19]);
  const pixels = Number(cells[20]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(areaUm2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(cells[25]).toBe('8-bit');
  expect(cells[26]).toBe('display_8bit');

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 820, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await openDetailsPanelForViewport(page, viewport);
    await assertNoViewportOverflow(page);
  }
});

test('OME microscopy hyperstack import stays one series and switches channels without losing Z', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-hyper.ome.tiff');
  await writeHyperstackOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-hyper');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  await page.locator('#microscopy-stack-panel .sec-title').click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 1/2 · T 1/1');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · 460 nm');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(0, 0, 255)');
  const before = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });

  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 2/2 · T 1/1');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('GFP · 510 nm');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
  await page.locator('#microscopy-composite-toggle').check();
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C1 · DAPI');
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C2 · GFP');
  const compositeUi = await page.locator('.hyperstack-composite-list').evaluate((list) => {
    return [...list.querySelectorAll('.hyperstack-checkbox-text')].every((text) => text.scrollWidth <= text.clientWidth + 1);
  });
  expect(compositeUi).toBe(true);
  const compositePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  });
  expect(compositePixel[1]).toBeGreaterThan(0);
  expect(compositePixel[2]).toBeGreaterThan(0);
  expect(compositePixel[0]).toBe(0);
  await page.locator('#microscopy-composite-c1').uncheck();
  const dapiOnlyPixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  });
  expect(dapiOnlyPixel[2]).toBeGreaterThan(0);
  expect(dapiOnlyPixel[1]).toBe(0);
  const hyperstackUi = await page.locator('.hyperstack-channel-meta').evaluate((row) => {
    const text = row.querySelector('.hyperstack-channel-text');
    const rowRect = row.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return {
      rowRight: Math.round(rowRect.right),
      textRight: Math.round(textRect.right),
      textOverflow: text.scrollWidth > text.clientWidth + 1,
    };
  });
  expect(hyperstackUi.textOverflow).toBe(false);
  expect(hyperstackUi.textRight).toBeLessThanOrEqual(hyperstackUi.rowRight);
  const after = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      seriesCount: state.manifest.series.length,
      channelIndex: series.microscopy.channelIndex,
      channelName: series.microscopy.channelName,
      channelColor: series.microscopyDataset.channels[1].color,
      emissionWavelength: series.microscopyDataset.channels[1].emissionWavelength,
      timeIndex: series.microscopy.timeIndex,
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
      mprHidden: document.getElementById('btn-mpr').classList.contains('hidden'),
      threeHidden: document.getElementById('btn-3d').classList.contains('hidden'),
    };
  });
  expect(snapshot).toEqual({
    seriesCount: initialCount + 1,
    channelIndex: 1,
    channelName: 'GFP',
    channelColor: '#00FF00',
    emissionWavelength: 510,
    timeIndex: 0,
    localStackCount: 2,
    mprHidden: true,
    threeHidden: true,
  });
});

test('ImageJ microscopy hyperstack import uses channel-fast order in the same C/T controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const imageJPath = testInfo.outputPath('cells-imagej.tif');
  await writeHyperstackImageJTiff(imageJPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: imageJPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-desc')).toContainText('ImageJ-TIFF');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#microscopy-stack-panel .sec-title').click();
  const before = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });

  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 2/2 · T 1/1');
  const after = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      seriesCount: state.manifest.series.length,
      channelIndex: series.microscopy.channelIndex,
      channelName: series.microscopy.channelName,
      timeIndex: series.microscopy.timeIndex,
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
    };
  });
  expect(snapshot).toEqual({
    seriesCount: initialCount + 1,
    channelIndex: 1,
    channelName: 'Channel 2',
    timeIndex: 0,
    localStackCount: 2,
  });
});
