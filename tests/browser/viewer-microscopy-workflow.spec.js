import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedChannelTimeOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { parseImageJRoiZip } from '../../js/microscopy/imagej-roi.js';
import { PIXEL, countPixels, parseCsvRows, readPngImage, readRenderedTiff } from '../helpers/browser/artifacts.mjs';
import { canvasPixel, settleFrames, waitForSlicePaint } from '../helpers/browser/canvas.mjs';
import { writeHyperstackImageJTiff } from '../helpers/browser/fixtures/tiff.mjs';
import { assertNoMicroscopyChromeOverflow } from '../helpers/browser/layout.mjs';
import {
  dropOnUploadZone,
  openLocalUploadModal,
  selectChannelAndTime,
} from '../helpers/browser/microscopy.mjs';
import {
  clearSliceDrawings,
  drawEllipseRoi,
  drawLineMeasurement,
  drawPointRoi,
  ensurePanelOpen,
} from '../helpers/browser/panels.mjs';
import { scaleBarSnapshot } from '../helpers/browser/scale-bar.mjs';

const CONTEXT_LABEL_BOX = { x0: 10, y0: 10, x1: 151, y1: 35 };

function fractionRect(image, left, top, right, bottom) {
  return {
    x0: Math.floor(image.width * left),
    y0: Math.floor(image.height * top),
    x1: Math.floor(image.width * right),
    y1: Math.floor(image.height * bottom),
  };
}

async function screenshotPngMetrics(page, pngPath) {
  const image = await readPngImage(page, pngPath);
  return {
    width: image.width,
    height: image.height,
    contextDarkPixels: countPixels(image, PIXEL.dark, CONTEXT_LABEL_BOX),
    contextBrightPixels: countPixels(image, PIXEL.chromeBright, CONTEXT_LABEL_BOX),
    scaleBarBrightPixels: countPixels(image, PIXEL.bright, {
      x0: Math.max(0, image.width - 130),
      y0: image.height - 10,
      x1: image.width - 6,
      y1: image.height - 9,
    }),
    pointRoiBluePixels: countPixels(image, PIXEL.roiBlue, fractionRect(image, 0.35, 0.35, 0.72, 0.65)),
    measurementWhitePixels: countPixels(image, PIXEL.white, fractionRect(image, 0.20, 0.52, 0.80, 0.59)),
  };
}

async function renderedTiffMetrics(tiffPath) {
  const image = await readRenderedTiff(tiffPath);
  return {
    ...image,
    pointRoiBluePixels: countPixels(image, PIXEL.roiBlue),
    measurementWhitePixels: countPixels(image, PIXEL.white),
  };
}

const CHANNEL_TIME_STACK = 'cells-channel-time';

async function openChannelTimeStack(page, testInfo) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath(`${CHANNEL_TIME_STACK}.ome.tiff`);
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText(CHANNEL_TIME_STACK);
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
}

async function useRecoloredGfpTimepointTwo(page) {
  await selectChannelAndTime(page, 1, 1);
  await page.locator('#microscopy-channel-color').fill('#aa00cc');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 1/1 · C 2/2 · T 2/2');
}

async function drawNamedRoi(page, label) {
  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  const row = page.locator('[data-roi-result-row]');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(row).toContainText('ROI 1');
  await row.locator('.roi-result-name').fill(label);
  await row.locator('.roi-result-name').press('Enter');
  await expect(row.locator('.roi-result-name')).toHaveText(label);
  return row;
}

test('microscopy C/T controls keep calibration, channel identity, and composite rendering aligned', async ({ page }, testInfo) => {
  await openChannelTimeStack(page, testInfo);
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#meta')).toContainText('Z 1 · C 2 · T 2');
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
});

test('the microscopy workflow recipe records and replays C/T, channel color, and composite state', async ({ page }, testInfo) => {
  await openChannelTimeStack(page, testInfo);
  await useRecoloredGfpTimepointTwo(page);
  await page.locator('#microscopy-composite-toggle').check();
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();

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
  await selectChannelAndTime(page, 0, 0);
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

});

test('a calibrated ROI carries its C/T provenance into the results row and CSV export', async ({ page }, testInfo) => {
  await openChannelTimeStack(page, testInfo);
  await useRecoloredGfpTimepointTwo(page);
  const row = await drawNamedRoi(page, 'Nucleus A');
  await expect(page.locator('#overlay-svg .roi-label')).toContainText('Nucleus A');
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('T2');
  await expect(row).toContainText('µm²');

  await row.locator('.roi-result-name').press('Enter');
  await expect(row.locator('.roi-result-name')).toHaveText('Nucleus A');
  await expect(page.locator('#overlay-svg .roi-label')).toContainText('Nucleus A');
  const rowMetrics = await row.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(Object.keys(rowMetrics)).toEqual(['Angle', 'Area', 'Center', 'Perimeter', 'Circularity', 'Length', 'Count', 'Pixels', 'Mean', 'Std', 'Min', 'Max', 'IntDen', 'RawIntDen']);
  expect(rowMetrics.Center).toContain('µm');
  expect(rowMetrics.Perimeter).toContain('µm');
  expect(Number(rowMetrics.Circularity)).toBeGreaterThan(0);
  expect(Number(rowMetrics.Circularity)).toBeLessThanOrEqual(1);
  expect(Number(rowMetrics.Mean)).toBeGreaterThan(0);
  expect(Number(rowMetrics.Min)).toBeGreaterThanOrEqual(0);
  expect(Number(rowMetrics.Max)).toBeGreaterThanOrEqual(Number(rowMetrics.Min));
  expect(Number(rowMetrics.IntDen)).toBeGreaterThan(0);
  expect(Number(rowMetrics.RawIntDen)).toBeGreaterThan(0);
  const roiObjectId = await row.getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await selectChannelAndTime(page, 0, 0);
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
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = line.split(',');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells-channel-time');
  const seriesSlug = cells[3];
  expect(seriesSlug).toMatch(/^micro_/);
  expect(cells[4]).toBe('1');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('ellipse');
  expect(cells[7]).toBe('Nucleus A');
  expect(cells[14]).toBe('');
  expect(cells[15]).toBe('GFP');
  expect(cells[16]).toBe('1');
  expect(cells[17]).toBe('2');
  expect(cells[18]).toBe('1');
  const areaUm2 = Number(cells[19]);
  const areaMm2 = Number(cells[20]);
  const pixels = Number(cells[21]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(areaUm2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(cells[26]).toBe('raw');
  expect(cells[27]).toBe('raw_16bit');
  expect(cells[29]).toBe('OME-TIFF');
  expect(cells[30]).toBe('cells-channel-time.ome.tiff');
  expect(cells[31]).toBe('');
  expect(cells[32]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[0]));
  expect(cells[33]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[1]));
  expect(cells[34]).toBe('0.0015');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('metadata');
  expect(cells[37]).toBe('Trusted metadata');
  expect(Number(cells[38])).toBeGreaterThan(0);
  expect(Number(cells[39])).toBeGreaterThan(0);
  expect(Number(cells[40])).toBeGreaterThan(0);
  expect(Number(cells[41])).toBeGreaterThan(0);
  expect(Number(cells[42])).toBeGreaterThan(0);
  expect(Number(cells[42])).toBeLessThanOrEqual(1);
  expect(Number(cells[43])).toBeGreaterThan(0);
  expect(Number(cells[44])).toBeGreaterThan(0);
  expect(Math.abs(Number(cells[45]) - Number(cells[43]) * 0.001)).toBeLessThan(1e-12);
  expect(Math.abs(Number(cells[46]) - Number(cells[44]) * 0.001)).toBeLessThan(1e-12);
  expect(Math.abs(Number(cells[47]) - Number(cells[19]) * Number(cells[22]))).toBeLessThan(1e-9);
  expect(Math.abs(Number(cells[48]) - Number(cells[20]) * Number(cells[22]))).toBeLessThan(1e-12);

});

test('the ROI JSON bundle records the dataset contract and re-imports display-only rows', async ({ page }, testInfo) => {
  await openChannelTimeStack(page, testInfo);
  await useRecoloredGfpTimepointTwo(page);
  const row = await drawNamedRoi(page, 'Nucleus A');
  const roiObjectId = await row.getAttribute('data-roi-object-id');
  const seriesSlug = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return state.manifest.series[state.seriesIdx].slug;
  });
  const pixels = Number(await row.locator('.roi-result-metrics div')
    .filter({ hasText: 'Pixels' }).locator('b').textContent());
  expect(pixels).toBeGreaterThan(0);

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
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.0015, displayUnit: 'µm', trust: 'Trusted metadata' },
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
      valueUnit: 'raw',
      valueSource: 'raw_16bit',
    }],
  });
  expect(Number(bundle.rows[0].rawIntDen)).toBeGreaterThan(0);
  expect(bundle.rows[0].areaUnit).toBe('µm²');
  expect(bundle.rows[0].perimeterDisplay).toContain('µm');
  expect(Number(bundle.rows[0].perimeterUnitValue)).toBeGreaterThan(0);
  expect(Number(bundle.rows[0].perimeterMm)).toBeGreaterThan(0);
  expect(Number(bundle.rows[0].perimeterPx)).toBeGreaterThan(0);
  expect(Number(bundle.rows[0].circularity)).toBeGreaterThan(0);
  expect(Number(bundle.rows[0].circularity)).toBeLessThanOrEqual(1);
  expect(Number(bundle.rows[0].xUnitValue)).toBeGreaterThan(0);
  expect(Number(bundle.rows[0].yUnitValue)).toBeGreaterThan(0);
  expect(Math.abs(Number(bundle.rows[0].xMm) - Number(bundle.rows[0].xUnitValue) * 0.001)).toBeLessThan(1e-12);
  expect(Math.abs(Number(bundle.rows[0].yMm) - Number(bundle.rows[0].yUnitValue) * 0.001)).toBeLessThan(1e-12);
  expect(Math.abs(Number(bundle.rows[0].intDen) - Number(bundle.rows[0].areaUnit2) * Number(bundle.rows[0].mean))).toBeLessThan(1e-9);
  expect(Math.abs(Number(bundle.rows[0].intDenMm2) - Number(bundle.rows[0].areaMm2) * Number(bundle.rows[0].mean))).toBeLessThan(1e-12);
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
      const displayOnlyRow = { ...resultRow };
      delete displayOnlyRow.sliceIndex;
      delete displayOnlyRow.channelIndex;
      delete displayOnlyRow.timeIndex;
      return displayOnlyRow;
    }),
  };
  await writeFile(displayFieldsBundlePath, `${JSON.stringify(displayFieldsBundle, null, 2)}\n`);

  await clearSliceDrawings(page);
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
    const { state } = await import('/js/core/state.js');
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

  await assertNoMicroscopyChromeOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await settleFrames(page);
  await assertNoMicroscopyChromeOverflow(page);
});


test('microscopy point count ROI exports C/T-scoped coordinates and count', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  const omeTiffPath = testInfo.outputPath('cells-point-count.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await selectChannelAndTime(page, 1, 1);

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
  expect(Number(pointMetrics.RawIntDen)).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = line.split(',');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('point');
  expect(cells[7]).toBe('ROI 1');
  expect(Number(cells[8])).toBeGreaterThanOrEqual(0);
  expect(Number(cells[9])).toBeGreaterThanOrEqual(0);
  expect(cells[10]).toBe('2');
  expect(cells[14]).toBe('');
  expect(cells[15]).toBe('GFP');
  expect(cells[16]).toBe('1');
  expect(cells[17]).toBe('2');
  expect(cells[18]).toBe('1');
  expect(cells[21]).toBe('2');
  expect(cells[36]).toBe('metadata');
  expect(cells[37]).toBe('Trusted metadata');
  expect(Number(cells[38])).toBeGreaterThan(0);

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
  expect(Number(bundle.rows[0].rawIntDen)).toBeGreaterThan(0);
  expect(bundle.rows[0].points).toHaveLength(2);

  await clearSliceDrawings(page);
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
  expect(Number(importedMetrics.RawIntDen)).toBeGreaterThan(0);
  await selectChannelAndTime(page, 0, 0);
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

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');

  await selectChannelAndTime(page, 1, 1);
  await page.locator('#microscopy-channel-color').fill('#aa00cc');
  await page.locator('#microscopy-composite-toggle').check();
  await page.locator('#microscopy-composite-c0').check();
  await page.locator('#microscopy-composite-c1').uncheck();

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('cells-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe.schema).toBe('voxellab.microscopyWorkflowRecipe.v1');
  expect(recipe.stack.channelIndex).toBe(1);
  expect(recipe.stack.timeIndex).toBe(1);
  expect(recipe.stack.compositeEnabled).toBe(true);
  expect(recipe.stack.compositeChannels).toEqual([true, false]);

  await selectChannelAndTime(page, 0, 0);
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
    const { state } = await import('/js/core/state.js');
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
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      channelIndex: series.microscopy.channelIndex,
      timeIndex: series.microscopy.timeIndex,
      color: series.microscopyDataset.channels[1].displayColor,
    };
  });
  expect(stateAfterFailure).toEqual(stateBeforeFailure);

  const countBeforeRecipeSidecarDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeRecipeSidecarDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('cells-recipe');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();
  await expect(page.locator('#microscopy-composite-c0')).toBeChecked();
  await expect(page.locator('#microscopy-composite-c1')).not.toBeChecked();
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
});

test('ImageJ hyperstack workflow supports Z/C/T-scoped calibrated count and line exports', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const imageJPath = testInfo.outputPath('cells-imagej-workflow.tif');
  await writeHyperstackImageJTiff(imageJPath, { width: 256, height: 128 });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: imageJPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej-workflow');
  await expect(page.locator('#series-desc')).toContainText('ImageJ-TIFF');
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-calibration')).toContainText('X 0.500 µm/px · Y 0.250 µm/px');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 2/2 · C 2/2 · T 1/1');
  await page.locator('#microscopy-channel-color').fill('#cc00aa');

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

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('imagej-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe).toMatchObject({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: { sourceFormat: 'ImageJ-TIFF' },
    requirements: { measurementPrerequisite: 'results-present' },
    view: { sliceIndex: 1 },
    stack: { channelIndex: 1, timeIndex: 0 },
    exportPreferences: { embeddedRoiResults: true },
  });
  expect(recipe.channels[1].color).toBe('#CC00AA');
  expect(recipe.roiResults.rows).toHaveLength(2);
  expect(recipe.roiResults.rows.some((row) => row.kind === 'point' && row.count === 2)).toBe(true);
  expect(recipe.roiResults.rows.some((row) => row.kind === 'line' && Number(row.lengthMm) > 0)).toBe(true);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows).toHaveLength(2);
  expect(csvRows.map(row => row.kind).sort()).toEqual(['line', 'point']);
  const pointCsv = csvRows.find(row => row.kind === 'point');
  const lineCsv = csvRows.find(row => row.kind === 'line');
  expect(pointCsv).toMatchObject({
    slice: '2',
    z_index0: '1',
    count: '2',
    channel: 'Channel 2',
    channel_index0: '1',
    time: '1',
    time_index0: '0',
    value_unit: 'raw',
    value_source: 'raw_16bit',
  });
  expect(Number(pointCsv.raw_int_den)).toBeGreaterThan(0);
  expect(Number(pointCsv.x_um)).toBeGreaterThan(0);
  expect(Number(pointCsv.y_um)).toBeGreaterThan(0);
  expect(Math.abs(Number(pointCsv.x_mm) - Number(pointCsv.x_um) * 0.001)).toBeLessThan(1e-12);
  expect(Math.abs(Number(pointCsv.y_mm) - Number(pointCsv.y_um) * 0.001)).toBeLessThan(1e-12);
  expect(lineCsv).toMatchObject({
    slice: '2',
    z_index0: '1',
    channel: 'Channel 2',
    channel_index0: '1',
    time: '1',
    time_index0: '0',
    value_source: 'linear_measurement',
  });
  expect(lineCsv.raw_int_den).toBe('');
  expect(Number(lineCsv.x_um)).toBeGreaterThan(0);
  expect(Number(lineCsv.y_um)).toBeGreaterThan(0);
  expect(pointCsv).toMatchObject({
    source_format: 'ImageJ-TIFF',
    source_files: 'cells-imagej-workflow.tif',
    xy_spacing_row_mm: '0.00025',
    xy_spacing_col_mm: '0.0005',
    z_spacing_mm: '0.0015',
    calibration_unit: 'µm',
  });
  expect(Number(lineCsv.length_um)).toBeGreaterThan(0);
  expect(Number(lineCsv.length_mm)).toBeGreaterThan(0);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('imagej-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source).toMatchObject({
    imageDomain: 'microscopy',
    format: 'ImageJ-TIFF',
    sourceFiles: ['cells-imagej-workflow.tif'],
    warnings: [],
  });
  expect(bundle.calibration).toMatchObject({
    xyKnown: true,
    rowMm: 0.00025,
    colMm: 0.0005,
    zKnown: true,
    zMm: 0.0015,
    displayUnit: 'µm',
    trust: 'Trusted metadata',
  });
  expect(bundle.rows).toHaveLength(2);
  expect(bundle.rows.every((row) => row.slice === 2 && row.sliceIndex === 1)).toBe(true);
  expect(bundle.rows.some((row) => row.kind === 'point' && row.count === 2)).toBe(true);
  expect(bundle.rows.some((row) => row.kind === 'line' && Number(row.lengthMm) > 0)).toBe(true);

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z2_c2_t1\.png$/);
  const pngMetrics = await screenshotPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({ width: 256, height: 128 });
  expect(pngMetrics.contextDarkPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(600);
  expect(pngMetrics.contextBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(25);
  expect(pngMetrics.scaleBarBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(80);
  expect(pngMetrics.pointRoiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(5);
  expect(pngMetrics.measurementWhitePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(40);

  const tiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const tiffDownload = await tiffDownloadPromise;
  expect(tiffDownload.suggestedFilename()).toMatch(/_z2_c2_t1\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: 256,
    height: 128,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    xResolution: 2,
    yResolution: 4,
    resolutionUnit: 1,
    pixelByteCount: 256 * 128 * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('unit=um');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=1.5');
  expect(tiffMetrics.description).toContain('label=Z 2 · C2 Channel 2 · T1');
  expect(tiffMetrics.pointRoiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(5);
  expect(tiffMetrics.measurementWhitePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(40);

  await clearSliceDrawings(page);
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await clearSliceDrawings(page);
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
  await page.locator('#scrub').evaluate((input) => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await page.locator('#microscopy-channel-select').selectOption('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(importedLineRow).not.toHaveClass(/is-current/);
  await importedLineRow.press('Enter');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('.hyperstack-status')).toHaveText('Z 2/2 · C 2/2 · T 1/1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(importedLineRow).toHaveClass(/is-current/);

  const imagejZipDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejZipDownload = await imagejZipDownloadPromise;
  const imagejZipPath = testInfo.outputPath('imagej-hyperstack-point-line-rois.zip');
  await imagejZipDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois.map(roi => roi['shape']).sort()).toEqual(['line', 'point']);
  expect(exportedRois.map(roi => roi.label).sort()).toEqual(['Line 1', 'ROI 1']);
  for (const roi of exportedRois) {
    expect(roi.zPosition).toBe(2);
    expect(roi.channelPosition).toBe(2);
    expect(roi.timePosition).toBe(1);
  }

  const zipReplayImageJPath = testInfo.outputPath('cells-imagej-zip-replay.tif');
  await writeHyperstackImageJTiff(zipReplayImageJPath, { width: 256, height: 128 });
  const countBeforeZipSidecarDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropOnUploadZone(page, [
    { path: zipReplayImageJPath, mimeType: 'image/tiff' },
    { path: imagejZipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeZipSidecarDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej-zip-replay');
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  const zipReplayPointResultRow = page.locator('[data-roi-result-row]').filter({ hasText: 'ROI 1' });
  const zipReplayLineResultRow = page.locator('[data-roi-result-row]').filter({ hasText: 'Line 1' });
  await expect(zipReplayPointResultRow).toContainText('Count');
  await expect(zipReplayLineResultRow).toContainText('Calibrated length');
  await zipReplayLineResultRow.press('Enter');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 2 ImageJ ROIs' }))
    .toContainText('Imported 2 ImageJ ROIs onto the active microscopy series.');
  const zipReplayCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const zipReplayCsvDownload = await zipReplayCsvDownloadPromise;
  const zipReplayCsv = await readFile(await zipReplayCsvDownload.path(), 'utf8');
  const zipReplayRows = parseCsvRows(zipReplayCsv);
  expect(zipReplayRows.map(row => row.kind).sort()).toEqual(['line', 'point']);
  expect(zipReplayRows.find(row => row.kind === 'point')).toMatchObject({
    label: 'ROI 1',
    slice: '2',
    z_index0: '1',
    channel_index0: '1',
    time_index0: '0',
    source_format: 'ImageJ-TIFF',
    calibration_unit: 'µm',
  });
  expect(zipReplayRows.find(row => row.kind === 'line')).toMatchObject({
    label: 'Line 1',
    slice: '2',
    z_index0: '1',
    channel_index0: '1',
    time_index0: '0',
    value_source: 'linear_measurement',
    source_format: 'ImageJ-TIFF',
  });
  const zipReplayJsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const zipReplayJsonDownload = await zipReplayJsonDownloadPromise;
  const zipReplayBundle = JSON.parse(await readFile(await zipReplayJsonDownload.path(), 'utf8'));
  expect(zipReplayBundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    source: {
      imageDomain: 'microscopy',
      format: 'ImageJ-TIFF',
      sourceFiles: ['cells-imagej-zip-replay.tif'],
      warnings: [],
    },
    calibration: {
      xyKnown: true,
      rowMm: 0.00025,
      colMm: 0.0005,
      zKnown: true,
      zMm: 0.0015,
      displayUnit: 'µm',
      trust: 'Trusted metadata',
    },
  });
  expect(zipReplayBundle.rows).toHaveLength(2);
  const zipReplayPointRow = zipReplayBundle.rows.find(row => row.kind === 'point');
  const zipReplayLineRow = zipReplayBundle.rows.find(row => row.kind === 'line');
  expect(zipReplayPointRow).toMatchObject({
    label: 'ROI 1',
    slice: 2,
    sliceIndex: 1,
    channel: 'Channel 2',
    channelIndex: 1,
    time: 1,
    timeIndex: 0,
    count: 2,
    valueSource: 'display_8bit',
  });
  expect(zipReplayLineRow).toMatchObject({
    label: 'Line 1',
    slice: 2,
    sliceIndex: 1,
    channel: 'Channel 2',
    channelIndex: 1,
    time: 1,
    timeIndex: 0,
    valueSource: 'linear_measurement',
  });
  expect(Number(zipReplayLineRow.lengthMm)).toBeGreaterThan(0);
  const zipReplayPngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const zipReplayPngDownload = await zipReplayPngDownloadPromise;
  expect(zipReplayPngDownload.suggestedFilename()).toMatch(/_z2_c2_t1\.png$/);
  const zipReplayPngMetrics = await screenshotPngMetrics(page, await zipReplayPngDownload.path());
  expect(zipReplayPngMetrics).toMatchObject({ width: 256, height: 128 });
  expect(zipReplayPngMetrics.contextDarkPixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(600);
  expect(zipReplayPngMetrics.contextBrightPixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(25);
  expect(zipReplayPngMetrics.scaleBarBrightPixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(80);
  expect(zipReplayPngMetrics.pointRoiBluePixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(5);
  expect(zipReplayPngMetrics.measurementWhitePixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(40);
  const zipReplayTiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const zipReplayTiffDownload = await zipReplayTiffDownloadPromise;
  expect(zipReplayTiffDownload.suggestedFilename()).toMatch(/_z2_c2_t1\.tif$/);
  const zipReplayTiffMetrics = await renderedTiffMetrics(await zipReplayTiffDownload.path());
  expect(zipReplayTiffMetrics.description).toContain('ImageJ=1.54');
  expect(zipReplayTiffMetrics.description).toContain('pixel_width=0.5');
  expect(zipReplayTiffMetrics.description).toContain('pixel_height=0.25');
  expect(zipReplayTiffMetrics.description).toContain('label=Z 2 · C2 Channel 2 · T1');
  expect(zipReplayTiffMetrics.pointRoiBluePixels, JSON.stringify(zipReplayTiffMetrics)).toBeGreaterThan(5);
  expect(zipReplayTiffMetrics.measurementWhitePixels, JSON.stringify(zipReplayTiffMetrics)).toBeGreaterThan(40);

  const countBeforeSidecarDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropOnUploadZone(page, [
    { path: imageJPath, mimeType: 'image/tiff' },
    { path: jsonBundlePath, mimeType: 'application/json' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeSidecarDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej-workflow');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#cc00aa');
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  const sidecarRows = page.locator('[data-roi-result-row]');
  await expect(sidecarRows.filter({ hasText: 'point' })).toContainText('Z 2');
  await expect(sidecarRows.filter({ hasText: 'point' })).toContainText('Channel 2');
  await expect(sidecarRows.filter({ hasText: 'line' })).toContainText('Z 2');
  await expect(sidecarRows.filter({ hasText: 'line' })).toContainText('Calibrated length');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);

  const invalidSidecarPath = testInfo.outputPath('not-roi-results.json');
  await writeFile(invalidSidecarPath, `${JSON.stringify({ schema: 'example.not-roi-results.v1' })}\n`);
  const countBeforeInvalidSidecarDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropOnUploadZone(page, [
    { path: imageJPath, mimeType: 'image/tiff' },
    { path: invalidSidecarPath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('Remove unsupported JSON sidecar before importing microscopy TIFF');
  await expect(page.locator('#upload-status')).toContainText('not-roi-results.json (unrecognized JSON sidecar schema: example.not-roi-results.v1)');
  await expect(page.locator('#upload-status')).toContainText('recognized ROI-results or workflow-recipe JSON sidecars');
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeInvalidSidecarDrop);
});
