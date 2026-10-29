import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedChannelTimeOmeTiff,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { parseImageJRoiZip } from '../../js/microscopy/imagej-roi.js';
import { isolatedFixturePath, reopenUploadModal } from '../helpers/browser/app.mjs';
import { PIXEL, countPixels, parseCsvRows, readPngImage, readRenderedTiff } from '../helpers/browser/artifacts.mjs';
import { waitForSlicePaint } from '../helpers/browser/canvas.mjs';
import {
  writeCompressedImageJRoiZip,
  writeImageJAngleRoi,
  writeImageJLineRoi,
  writeImageJOvalRoi,
  writeImageJPointRoi,
  writeImageJPolygonRoi,
  writeImageJRectRoi,
  writeUnsupportedImageJRoi,
} from '../helpers/browser/fixtures/imagej-roi.mjs';
import {
  dropOnUploadZone,
  openLocalUploadModal,
  selectChannelAndTime,
} from '../helpers/browser/microscopy.mjs';
import { clearSliceDrawings, ensurePanelOpen } from '../helpers/browser/panels.mjs';

const SCALE_BAR_BAND = (image) => ({
  x0: Math.max(0, image.width - 84),
  y0: Math.max(0, image.height - 18),
  x1: image.width - 6,
  y1: image.height - 4,
});

const ANGLE_LABEL_BOX = { x0: 1, y0: 2, x1: 9, y1: 11 };

async function renderedTiffMetrics(tiffPath) {
  const image = await readRenderedTiff(tiffPath);
  return {
    ...image,
    roiBluePixels: countPixels(image, PIXEL.roiBlue),
    scaleBarBrightPixels: countPixels(image, PIXEL.bright, SCALE_BAR_BAND(image)),
  };
}

async function renderedPngMetrics(page, pngPath) {
  const image = await readPngImage(page, pngPath);
  return {
    width: image.width,
    height: image.height,
    roiBluePixels: countPixels(image, PIXEL.roiBlue),
    angleWhitePixels: countPixels(image, PIXEL.nearWhite, ANGLE_LABEL_BOX),
    scaleBarBrightPixels: countPixels(image, PIXEL.bright, SCALE_BAR_BAND(image)),
  };
}

test('co-dropped unsupported ImageJ ROI sidecar opens the image and reports a skipped sidecar', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('unsupported-roi-cells.ome.tiff');
  const roiPath = testInfo.outputPath('unsupported-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeUnsupportedImageJRoi(roiPath);

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: roiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('unsupported-roi-cells');
  await waitForSlicePaint(page);
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text')).toContainText(
    'Skipped 1 ImageJ ROI entry: unsupported-cell.roi (Unsupported ImageJ ROI type).',
  );
});

test('co-dropped ImageJ ROI sidecars keep C/T provenance and skip out-of-range positions', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('positioned-roi-cells.ome.tiff');
  const validRoiPath = testInfo.outputPath('gfp-timepoint-spots.roi');
  const outOfRangeRoiPath = testInfo.outputPath('missing-channel-spots.roi');
  const outOfBoundsRoiPath = testInfo.outputPath('clipped-spots.roi');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJPointRoi(validRoiPath, { points: [[4, 5], [10, 8]], position: { c: 2, z: 1, t: 2 } });
  await writeImageJPointRoi(outOfRangeRoiPath, { points: [[6, 6]], position: { c: 3, z: 1, t: 1 } });
  await writeImageJPointRoi(outOfBoundsRoiPath, { points: [[4, 5], [99, 8]], position: { c: 2, z: 1, t: 2 } });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: validRoiPath, mimeType: 'application/octet-stream' },
    { path: outOfRangeRoiPath, mimeType: 'application/octet-stream' },
    { path: outOfBoundsRoiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('positioned-roi-cells');
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('gfp-timepoint-spots');
  await expect(row).toContainText('GFP');
  await expect(row).toContainText('T2');
  await expect(row).not.toContainText('missing-channel-spots');
  await expect(row).not.toContainText('clipped-spots');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Skipped 2 ImageJ ROI entries: missing-channel-spots (did not fit active series), clipped-spots (did not fit active series).');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await selectChannelAndTime(page, 1, 1);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
});

test('co-dropped ImageJ ROI sidecar imports onto calibrated microscopy TIFF results', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('roi-sidecar-cells.ome.tiff');
  const roiPath = testInfo.outputPath('cell-body.roi');
  const rectRoiPath = testInfo.outputPath('cell-box.roi');
  const freehandRoiPath = testInfo.outputPath('cell-freehand.roi');
  const freehandPoints = [[2, 3], [11, 3], [9, 10], [3, 9]];
  const pointRoiPath = testInfo.outputPath('cell-spots.roi');
  const pointPoints = [[4, 5], [10, 8]];
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 3, top: 4, right: 12, bottom: 13 });
  await writeImageJRectRoi(rectRoiPath, { left: 1, top: 2, right: 8, bottom: 9 });
  await writeImageJPolygonRoi(freehandRoiPath, { type: 7, points: freehandPoints });
  await writeImageJPointRoi(pointRoiPath, { points: pointPoints });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: roiPath, mimeType: 'application/octet-stream' },
    { path: rectRoiPath, mimeType: 'application/octet-stream' },
    { path: freehandRoiPath, mimeType: 'application/octet-stream' },
    { path: pointRoiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await waitForSlicePaint(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(4);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('4');
  const rows = page.locator('[data-roi-result-row]');
  await expect(rows.filter({ hasText: 'cell-body' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'cell-body' })).toContainText('µm²');
  await expect(rows.filter({ hasText: 'cell-box' })).toContainText('polygon');
  await expect(rows.filter({ hasText: 'cell-box' })).toContainText('µm²');
  await expect(rows.filter({ hasText: 'cell-freehand' })).toContainText('polygon');
  await expect(rows.filter({ hasText: 'cell-freehand' })).toContainText('µm²');
  const pointRow = rows.filter({ hasText: 'cell-spots' });
  await expect(pointRow).toContainText('point');
  const pointMetrics = await pointRow.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(pointMetrics.Count).toBe('2');
  expect(pointMetrics.Pixels).toBe('2');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows.map(row => row.label).sort()).toEqual(['cell-body', 'cell-box', 'cell-freehand', 'cell-spots']);
  for (const row of csvRows) {
    expect(row.source_format).toBe('OME-TIFF');
    expect(row.xy_spacing_row_mm).toBe('0.00025');
    expect(row.xy_spacing_col_mm).toBe('0.0005');
    expect(row.calibration_unit).toBe('µm');
    expect(row.calibration_source).toBe('metadata');
    if (row.kind !== 'point') {
      expect(Number(row.area_um2)).toBeGreaterThan(0);
      expect(Number(row.area_mm2)).toBeGreaterThan(0);
    }
    expect(Number(row.pixels)).toBeGreaterThan(0);
  }
  expect(csvRows.find(row => row.label === 'cell-body')?.kind).toBe('ellipse');
  expect(csvRows.find(row => row.label === 'cell-box')?.kind).toBe('polygon');
  expect(csvRows.find(row => row.label === 'cell-freehand')?.kind).toBe('polygon');
  expect(csvRows.find(row => row.label === 'cell-spots')).toMatchObject({ kind: 'point', count: '2', pixels: '2' });

  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  expect(imagejDownload.suggestedFilename()).toMatch(/^voxellab-imagej-rois-.*\.zip$/);
  const imagejZipPath = testInfo.outputPath('exported-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(4);
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('cell-body_z1_c1_t1')?.label).toBe('cell-body');
  expect(exportedByName.get('cell-body_z1_c1_t1')?.['shape']).toBe('ellipse');
  expect(exportedByName.get('cell-body_z1_c1_t1')?.points).toEqual([[3, 4], [12, 13]]);
  expect(exportedByName.get('cell-box_z1_c1_t1')?.label).toBe('cell-box');
  expect(exportedByName.get('cell-box_z1_c1_t1')?.['shape']).toBe('polygon');
  expect(exportedByName.get('cell-box_z1_c1_t1')?.points).toEqual([[1, 2], [8, 2], [8, 9], [1, 9]]);
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.label).toBe('cell-freehand');
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.['shape']).toBe('polygon');
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.points).toEqual(freehandPoints);
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.label).toBe('cell-spots');
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.['shape']).toBe('point');
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.points).toEqual(pointPoints);

  const replayOmeTiffPath = testInfo.outputPath('roi-zip-replay-cells.ome.tiff');
  await writeCalibratedOmeTiff(replayOmeTiffPath);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    { path: replayOmeTiffPath, mimeType: 'image/tiff' },
    { path: imagejZipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#series-name')).toHaveText('roi-zip-replay-cells');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(4);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#roi-results-count')).toHaveText('4');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-body' })).toContainText('ellipse');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-box' })).toContainText('polygon');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-freehand' })).toContainText('polygon');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-spots' })).toContainText('point');
});

test('ImageJ ROI sidecar imports onto the active microscopy series', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 3, top: 4, right: 12, bottom: 13 });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-cells');
  await waitForSlicePaint(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);

  await reopenUploadModal(page);
  await dropOnUploadZone(page, [{ path: roiPath, mimeType: 'application/octet-stream' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'active-sidecar-cell' })).toContainText('µm²');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ImageJ ROI' }))
    .toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');
});

test('ImageJ ROI ZIP sidecar imports onto the active microscopy series', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-zip-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-zip-cell.roi');
  const linePath = testInfo.outputPath('active-sidecar-zip-line.roi');
  const zipPath = testInfo.outputPath('active-sidecar-rois.zip');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'session/active-sidecar-zip-cell.roi', path: roiPath },
    { name: 'session/measurements/active-sidecar-zip-line.roi', path: linePath, dataDescriptor: true },
  ]);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-zip-cells');
  await waitForSlicePaint(page);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [{ path: zipPath, mimeType: 'application/zip' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  await expect(page.getByRole('button', { name: /^Show active-sidecar-zip-cell / })).toContainText('ellipse');
  await expect(page.getByRole('button', { name: /^Show active-sidecar-zip-line / })).toContainText('Calibrated length');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 2 ImageJ ROIs' }))
    .toContainText('Imported 2 ImageJ ROIs onto the active microscopy series.');
});

test('ImageJ ROI ZIP sidecar names unsupported ZIP compression in skipped entries', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-zip-compression-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-zip-compression-cell.roi');
  const unsupportedPath = testInfo.outputPath('active-sidecar-zip-unsupported-compression.roi');
  const zipPath = testInfo.outputPath('active-sidecar-rois-unsupported-compression.zip');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeUnsupportedImageJRoi(unsupportedPath);
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'session/unsupported-compressed.roi', path: unsupportedPath, method: 12, dataDescriptor: true },
    { name: 'session/active-sidecar-zip-compression-cell.roi', path: roiPath },
  ]);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-zip-compression-cells');
  await waitForSlicePaint(page);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [{ path: zipPath, mimeType: 'application/zip' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const skippedNotice = page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 ImageJ ROI entry' });
  await expect(skippedNotice).toContainText('unsupported-compressed.roi (Unsupported ZIP compression; only stored or deflated ImageJ ROI entries are supported)');
  await expect(skippedNotice).not.toContainText('unsupported_compression');
});

test('active microscopy sidecar-only import stays open when nothing matches', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-mismatch-cells.ome.tiff');
  const recipePaths = Array.from({ length: 4 }, (_, index) =>
    testInfo.outputPath(`active-sidecar-mismatch-recipe-${index + 1}.json`)
  );
  await writeCalibratedOmeTiff(omeTiffPath);
  for (const [index, recipePath] of recipePaths.entries()) {
    await writeFile(recipePath, JSON.stringify({
      schema: 'voxellab.microscopyWorkflowRecipe.v1',
      kind: 'microscopy-workflow-recipe',
      target: {
        imageDomain: 'microscopy',
        sourceFormat: 'OME-TIFF',
        geometry: { width: 99 + index, height: 16, slices: 1, sizeZ: 1, sizeC: 1, sizeT: 1 },
      },
      requirements: { calibrationRequired: false, measurementPrerequisite: 'none' },
      view: { sliceIndex: 0 },
      stack: { channelIndex: 0, timeIndex: 0, compositeEnabled: false, compositeChannels: [true] },
      channels: [],
      exportPreferences: {},
    }));
  }

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-mismatch-cells');
  await waitForSlicePaint(page);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, recipePaths.map(path => ({ path, mimeType: 'application/json' })));

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('No sidecars matched the active microscopy series');
  await expect(page.locator('#upload-status')).toContainText('active-sidecar-mismatch-recipe-1.json (Recipe geometry/channel/time dimensions do not match the active microscopy series)');
  await expect(page.locator('#upload-status')).toContainText('plus 1 more file');
  await expect(page.locator('#microscopy-recipe-status'))
    .toContainText('Recipe geometry/channel/time dimensions do not match the active microscopy series.');
});

test('active microscopy unsupported ImageJ ROI sidecar names the rejected ROI reason', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-unsupported-roi-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-unsupported-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeUnsupportedImageJRoi(roiPath);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-unsupported-roi-cells');
  await waitForSlicePaint(page);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [{ path: roiPath, mimeType: 'application/octet-stream' }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText(
    'Unsupported ImageJ ROI sidecar: active-unsupported-cell.roi (Unsupported ImageJ ROI type).',
  );
  await expect(page.locator('#upload-status')).toContainText('rect, oval, straight-line, open PolyLine, angle, polygon/freehand, traced, and point');
});

test('active microscopy unsupported ImageJ ROI sidecar error list is bounded', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-bounded-unsupported-roi-cells.ome.tiff');
  const roiPaths = Array.from({ length: 5 }, (_, index) => (
    testInfo.outputPath(`active-unsupported-cell-${index + 1}.roi`)
  ));
  await writeCalibratedOmeTiff(omeTiffPath);
  await Promise.all(roiPaths.map(writeUnsupportedImageJRoi));

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-bounded-unsupported-roi-cells');
  await waitForSlicePaint(page);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, roiPaths.map(path => ({ path, mimeType: 'application/octet-stream' })));

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Unsupported ImageJ ROI sidecars');
  await expect(status).toContainText('active-unsupported-cell-1.roi (Unsupported ImageJ ROI type)');
  await expect(status).toContainText('active-unsupported-cell-3.roi (Unsupported ImageJ ROI type)');
  await expect(status).toContainText('plus 2 more files');
  await expect(status).not.toContainText('active-unsupported-cell-4.roi');
  await expect(status).not.toContainText('active-unsupported-cell-5.roi');
});

test('active microscopy ROI results sidecar-only import explains calibration mismatch', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-roi-mismatch-cells.ome.tiff');
  const roiResultsPath = testInfo.outputPath('active-sidecar-roi-mismatch-results.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeFile(roiResultsPath, JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'active-sidecar-roi-mismatch-cells', name: 'active-sidecar-roi-mismatch-cells', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy' },
    calibration: { xyKnown: true, rowMm: 0.001, colMm: 0.001, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:active-sidecar-roi-mismatch-cells|0:1',
      sliceIndex: 0,
      kind: 'polygon',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      areaMm2: 0.000021,
    }],
  }));

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-roi-mismatch-cells');
  await waitForSlicePaint(page);
  const persistenceKey = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { seriesPersistenceKey } = await import('/js/core/series-identity.js');
    return seriesPersistenceKey(state.manifest.series[state.seriesIdx], state.manifest);
  });
  const mismatchBundle = JSON.parse(await readFile(roiResultsPath, 'utf8'));
  mismatchBundle.series.persistenceKey = persistenceKey;
  await writeFile(roiResultsPath, `${JSON.stringify(mismatchBundle, null, 2)}\n`);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [{ path: roiResultsPath, mimeType: 'application/json' }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('No sidecars matched the active microscopy series: active-sidecar-roi-mismatch-results.json (ROI bundle calibration does not match this microscopy stack)');
});

test('co-dropped compressed ImageJ ROI Manager ZIP imports supported ROI sidecars', async ({ page }, testInfo) => {
  const omeTiffPath = await isolatedFixturePath(testInfo, 'compressed-roi-cells.ome.tiff');
  const roiPath = await isolatedFixturePath(testInfo, 'compressed-cell.roi');
  const linePath = await isolatedFixturePath(testInfo, 'compressed-line.roi');
  const anglePath = await isolatedFixturePath(testInfo, 'compressed-angle.roi');
  const unsupportedRoiPath = await isolatedFixturePath(testInfo, 'compressed-unsupported.roi');
  const zipPath = await isolatedFixturePath(testInfo, 'compressed-rois.zip');
  const anglePoints = [[6, 4], [2, 4], [6, 8]];
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });
  await writeImageJAngleRoi(anglePath, { points: anglePoints });
  await writeUnsupportedImageJRoi(unsupportedRoiPath);
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'roi-set/session-a/compressed-cell.roi', path: roiPath },
    { name: 'roi-set\\session-a\\measurements\\compressed-line.roi', path: linePath, dataDescriptor: true },
    { name: 'roi-set/session-a/angles/compressed-angle.roi', path: anglePath },
    { name: 'roi-set/session-a/unsupported-cell.roi', path: unsupportedRoiPath },
  ]);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: zipPath, mimeType: 'application/zip' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('compressed-roi-cells');
  await waitForSlicePaint(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  const rows = page.locator('[data-roi-result-row]');
  await expect(rows.filter({ hasText: 'compressed-cell' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'compressed-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'compressed-angle' })).toContainText('Calibrated angle');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('unsupported-cell');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Imported 3 ImageJ ROIs onto the active microscopy series.');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Skipped 1 ImageJ ROI entry: unsupported-cell.roi (Unsupported ImageJ ROI type).');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows.map(row => row.label).sort()).toEqual(['compressed-angle', 'compressed-cell', 'compressed-line']);
  expect(csv).not.toContain('roi-set/');
  expect(csv).not.toContain('roi-set\\');
  for (const row of csvRows) {
    expect(row.source_format).toBe('OME-TIFF');
    expect(row.source_files).toBe('compressed-roi-cells.ome.tiff');
    expect(row.xy_spacing_row_mm).toBe('0.00025');
    expect(row.xy_spacing_col_mm).toBe('0.0005');
    expect(row.calibration_unit).toBe('µm');
    expect(row.calibration_source).toBe('metadata');
  }
  const lineRow = csvRows.find(row => row.label === 'compressed-line');
  expect(lineRow).toMatchObject({ kind: 'line', value_source: 'linear_measurement' });
  expect(Number(lineRow.length_um)).toBeCloseTo(4, 3);
  const angleRow = csvRows.find(row => row.label === 'compressed-angle');
  expect(angleRow).toMatchObject({ kind: 'angle', value_source: 'angular_measurement' });
  expect(Number(angleRow.angle_deg)).toBeCloseTo(26.565, 3);

  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  expect(imagejDownload.suggestedFilename()).toMatch(/^voxellab-imagej-rois-.*\.zip$/);
  const imagejZipPath = testInfo.outputPath('compressed-roundtrip-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(3);
  const exportedNames = exportedRois.map(roi => roi.name).join('\n');
  expect(exportedNames).not.toContain('roi-set/');
  expect(exportedNames).not.toContain('roi-set\\');
  expect(exportedNames).not.toContain('unsupported-cell');
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.label).toBe('compressed-cell');
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.['shape']).toBe('ellipse');
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.points).toEqual([[4, 5], [13, 15]]);
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.label).toBe('compressed-line');
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.['shape']).toBe('line');
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.points).toEqual([[2, 4], [10, 4]]);
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.label).toBe('compressed-angle');
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.['shape']).toBe('angle');
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.points).toEqual(anglePoints);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('compressed-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source).toMatchObject({
    imageDomain: 'microscopy',
    format: 'OME-TIFF',
    sourceFiles: ['compressed-roi-cells.ome.tiff'],
  });
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' });
  expect(bundle.rows.map(row => [row.label, row.kind, row.valueSource || '']).sort()).toEqual([
    ['compressed-angle', 'angle', 'angular_measurement'],
    ['compressed-cell', 'ellipse', 'raw_16bit'],
    ['compressed-line', 'line', 'linear_measurement'],
  ]);
  expect(JSON.stringify(bundle)).not.toContain('roi-set/');
  expect(JSON.stringify(bundle)).not.toContain('roi-set\\');

  await clearSliceDrawings(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 3 result rows');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'compressed-cell' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'compressed-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'compressed-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
});

const POSITIONED_POINT_POINTS = [[4, 5], [10, 8]];
const POSITIONED_ANGLE_POINTS = [[6, 4], [2, 4], [6, 8]];

async function importPositionedRoiZip(page, testInfo) {
  const omeTiffPath = testInfo.outputPath('compressed-positioned-roi-cells.ome.tiff');
  const pointPath = testInfo.outputPath('positioned-spots.roi');
  const linePath = testInfo.outputPath('positioned-line.roi');
  const anglePath = testInfo.outputPath('positioned-angle.roi');
  const outOfRangePath = testInfo.outputPath('positioned-missing-channel.roi');
  const outOfBoundsPath = testInfo.outputPath('positioned-clipped.roi');
  const zipPath = testInfo.outputPath('positioned-compressed-rois.zip');
  const position = { c: 2, z: 1, t: 2 };
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJPointRoi(pointPath, { points: POSITIONED_POINT_POINTS, position });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4, position });
  await writeImageJAngleRoi(anglePath, { points: POSITIONED_ANGLE_POINTS, position });
  await writeImageJPointRoi(outOfRangePath, { points: [[6, 6]], position: { c: 3, z: 1, t: 1 } });
  await writeImageJPointRoi(outOfBoundsPath, { points: [[4, 5], [99, 8]], position });
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'positioned-spots.roi', path: pointPath },
    { name: 'positioned-line.roi', path: linePath },
    { name: 'positioned-angle.roi', path: anglePath },
    { name: 'positioned-missing-channel.roi', path: outOfRangePath },
    { name: 'positioned-clipped.roi', path: outOfBoundsPath },
  ]);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: zipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#series-name')).toHaveText('compressed-positioned-roi-cells');
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  return page.locator('[data-roi-result-row]');
}

async function showPositionedRois(page) {
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await selectChannelAndTime(page, 1, 1);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
}

async function saveDownload(page, trigger, path) {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  await download.saveAs(path);
  return download;
}

test('compressed ImageJ ROI Manager ZIP keeps C/T provenance in results, overlays, and exports', async ({ page }, testInfo) => {
  const rows = await importPositionedRoiZip(page, testInfo);

  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('T2');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('positioned-missing-channel');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('positioned-clipped');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Imported 3 ImageJ ROIs onto the active microscopy series.');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Skipped 2 ImageJ ROI entries: positioned-missing-channel (did not fit active series), positioned-clipped (did not fit active series).');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);

  await showPositionedRois(page);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csv = await readFile(await (await csvDownloadPromise).path(), 'utf8');
  expect(parseCsvRows(csv).map(row => [row.label, row.kind, row.channel, row.channel_index0, row.time, row.time_index0]).sort()).toEqual([
    ['positioned-angle', 'angle', 'GFP', '1', '2', '1'],
    ['positioned-line', 'line', 'GFP', '1', '2', '1'],
    ['positioned-spots', 'point', 'GFP', '1', '2', '1'],
  ]);
  expect(csv).not.toContain('positioned-missing-channel');
  expect(csv).not.toContain('positioned-clipped');

  const imagejZipPath = testInfo.outputPath('positioned-roundtrip-imagej-rois.zip');
  await saveDownload(page, () => page.locator('#roi-results-imagej-export').click(), imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(3);
  expect(exportedRois.map(roi => roi.name).join('\n')).not.toContain('positioned-missing-channel');
  expect(exportedRois.map(roi => roi.name).join('\n')).not.toContain('positioned-clipped');
  for (const roi of exportedRois) {
    expect(roi.zPosition).toBe(1);
    expect(roi.channelPosition).toBe(2);
    expect(roi.timePosition).toBe(2);
  }
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('positioned-spots_z1_c2_t2')?.label).toBe('positioned-spots');
  expect(exportedByName.get('positioned-spots_z1_c2_t2')?.points).toEqual(POSITIONED_POINT_POINTS);
  expect(exportedByName.get('positioned-line_z1_c2_t2')?.label).toBe('positioned-line');
  expect(exportedByName.get('positioned-line_z1_c2_t2')?.points).toEqual([[2, 4], [10, 4]]);
  expect(exportedByName.get('positioned-angle_z1_c2_t2')?.label).toBe('positioned-angle');
  expect(exportedByName.get('positioned-angle_z1_c2_t2')?.points).toEqual(POSITIONED_ANGLE_POINTS);
});

test('positioned ROI JSON bundle round-trips C/T rows and row selection restores their C/T view', async ({ page }, testInfo) => {
  const rows = await importPositionedRoiZip(page, testInfo);
  await showPositionedRois(page);

  const jsonBundlePath = testInfo.outputPath('positioned-roi-results.json');
  await saveDownload(page, () => page.locator('#roi-results-json-export').click(), jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    series: { name: 'compressed-positioned-roi-cells', width: 16, height: 16, slices: 1 },
    source: {
      imageDomain: 'microscopy',
      format: 'OME-TIFF',
      sourceFiles: ['compressed-positioned-roi-cells.ome.tiff'],
    },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.0015, displayUnit: 'µm' },
  });
  expect(bundle.source.dataset.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 2, '', 0, false],
    ['t', 'time', 2, 'index', 1, false],
  ]);
  expect(bundle.rows.map(row => [row.label, row.kind, row.channel, row.channelIndex, row.time, row.timeIndex, row.valueSource || '']).sort()).toEqual([
    ['positioned-angle', 'angle', 'GFP', 1, 2, 1, 'angular_measurement'],
    ['positioned-line', 'line', 'GFP', 1, 2, 1, 'linear_measurement'],
    ['positioned-spots', 'point', 'GFP', 1, 2, 1, 'raw_16bit'],
  ]);
  expect(JSON.stringify(bundle)).not.toContain('positioned-missing-channel');
  expect(JSON.stringify(bundle)).not.toContain('positioned-clipped');
  expect(bundle.rows.find(row => row.label === 'positioned-spots')).toMatchObject({
    slice: 1,
    sliceIndex: 0,
    count: 2,
    points: POSITIONED_POINT_POINTS,
  });
  expect(Number(bundle.rows.find(row => row.label === 'positioned-line')?.lengthMm)).toBeGreaterThan(0);
  expect(Number(bundle.rows.find(row => row.label === 'positioned-angle')?.angleDeg)).toBeCloseTo(26.565, 3);

  await clearSliceDrawings(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);

  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 3 result rows');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);

  await selectChannelAndTime(page, 0, 0);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await rows.filter({ hasText: 'positioned-line' }).click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
});

test('positioned ROI workflow recipe replays on a matching series and fails closed on a mismatch', async ({ page }, testInfo) => {
  const rows = await importPositionedRoiZip(page, testInfo);
  await showPositionedRois(page);

  const recipePath = testInfo.outputPath('positioned-workflow-recipe.json');
  await saveDownload(page, () => page.locator('#microscopy-recipe-export').click(), recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe).toMatchObject({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: { width: 16, height: 16, slices: 1, sizeZ: 1, sizeC: 2, sizeT: 2 },
    },
    requirements: { measurementPrerequisite: 'results-present' },
    stack: { channelIndex: 1, timeIndex: 1 },
    exportPreferences: { embeddedRoiResults: true },
  });
  expect(recipe.roiResults.rows.map(row => [row.label, row.kind, row.channel, row.channelIndex, row.time, row.timeIndex, row.valueSource || '']).sort()).toEqual([
    ['positioned-line', 'line', 'GFP', 1, 2, 1, 'linear_measurement'],
    ['positioned-spots', 'point', 'GFP', 1, 2, 1, 'raw_16bit'],
  ]);
  expect(recipe.angleMeasurements.rows.map(row => [row.label, row.channelName, row.channelIndex, row.timeIndex, Number(row.angleDeg.toFixed(3))])).toEqual([
    ['positioned-angle', 'GFP', 1, 1, 26.565],
  ]);
  expect(JSON.stringify(recipe)).not.toContain('positioned-missing-channel');
  expect(JSON.stringify(recipe)).not.toContain('positioned-clipped');

  await clearSliceDrawings(page);

  const mismatchedRecipeOmeTiffPath = testInfo.outputPath('recipe-mismatch/positioned-recipe-mismatch-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(mismatchedRecipeOmeTiffPath);
  const countBeforeMismatchedRecipeDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    { path: mismatchedRecipeOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeMismatchedRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('positioned-recipe-mismatch-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('0');
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 microscopy workflow recipe' }))
    .toContainText('positioned-workflow-recipe.json (Recipe ROI results do not match the active microscopy series)');

  const recipeReplayOmeTiffPath = testInfo.outputPath('recipe-replay/compressed-positioned-roi-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(recipeReplayOmeTiffPath);
  const countBeforeRecipeDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    { path: recipeReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('compressed-positioned-roi-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await selectChannelAndTime(page, 0, 0);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await rows.filter({ hasText: 'positioned-angle' }).click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
});

test('positioned ROI snapshot exports label the active Z/C/T and keep the overlay pixels', async ({ page }, testInfo) => {
  await importPositionedRoiZip(page, testInfo);
  await showPositionedRois(page);

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.png$/);
  const pngMetrics = await renderedPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
  });
  expect(pngMetrics.roiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(8);
  expect(pngMetrics.angleWhitePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(6);

  const tiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const tiffDownload = await tiffDownloadPromise;
  expect(tiffDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    pixelByteCount: CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=1.5');
  expect(tiffMetrics.description).toContain('label=Z 1 · C2 GFP · T2');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(8);
});

test('co-dropped ImageJ straight-line ROI sidecar imports as calibrated measurement row', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('line-roi-cells.ome.tiff');
  const linePath = testInfo.outputPath('axon-length.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: linePath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('line-roi-cells');
  await waitForSlicePaint(page);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('line');
  await expect(row).toContainText('axon-length');
  await expect(row).toContainText('4.00 µm');

  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('exported-line-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0]['shape']).toBe('line');
  expect(exportedRois[0].label).toBe('axon-length');
  expect(exportedRois[0].points).toEqual([[2, 4], [10, 4]]);
});

test('co-dropped ImageJ angle ROI sidecar imports as calibrated angle measurement overlay', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('angle-roi-cells.ome.tiff');
  const anglePath = testInfo.outputPath('branch-angle.roi');
  const points = [[6, 4], [2, 4], [6, 8]];
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJAngleRoi(anglePath, { points, position: { c: 2, z: 1, t: 2 } });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: anglePath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('angle-roi-cells');
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await selectChannelAndTime(page, 1, 1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { collectMeasurements } = await import('/js/dicom/dicom-sr-collect.js');
    const { angleEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series[state.seriesIdx];
    const angles = angleEntriesForSlice(state, series, state.sliceIdx);
    return {
      angleCount: angles.length,
      stored: angles.map(angle => ({
        label: angle.label,
        deg: Number(angle.deg.toFixed(3)),
        microscopy: angle.microscopy,
        handles: [angle.p1, angle.vertex, angle.p3],
      })),
      collected: collectMeasurements(state).measurements.filter(item => item.kind === 'angle'),
    };
  });
  expect(snapshot.angleCount).toBe(1);
  expect(snapshot.stored[0]).toMatchObject({
    label: 'branch-angle',
    deg: 26.565,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 1 },
    handles: [{ x: 6, y: 4 }, { x: 2, y: 4 }, { x: 6, y: 8 }],
  });
  expect(snapshot.collected).toEqual([{
    kind: 'angle',
    slice: 0,
    angle_deg: expect.closeTo(26.565, 0.001),
    handles: [[6, 4], [2, 4], [6, 8]],
  }]);

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('angle-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe.angleMeasurements.rows).toHaveLength(1);
  expect(recipe.angleMeasurements.rows[0]).toMatchObject({
    label: 'branch-angle',
    sliceIndex: 0,
    angleDeg: expect.closeTo(26.565, 0.001),
    channelIndex: 1,
    channelName: 'GFP',
    timeIndex: 1,
    points: {
      p1: { x: 6, y: 4 },
      vertex: { x: 2, y: 4 },
      p3: { x: 6, y: 8 },
    },
  });

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');

  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('exported-angle-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0]['shape']).toBe('angle');
  expect(exportedRois[0].name).toBe('branch-angle_z1_c2_t2');
  expect(exportedRois[0].label).toBe('branch-angle');
  expect(exportedRois[0].channelPosition).toBe(2);
  expect(exportedRois[0].timePosition).toBe(2);
  expect(exportedRois[0].points).toEqual(points);

  const zipReplayOmeTiffPath = testInfo.outputPath('angle-zip-replay-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(zipReplayOmeTiffPath);
  const countBeforeZipDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    { path: zipReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: imagejZipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeZipDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('angle-zip-replay-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await selectChannelAndTime(page, 1, 1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'branch-angle' }))
    .toContainText('Calibrated angle');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ImageJ ROI' }))
    .toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');
  const zipReplayCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const zipReplayCsvDownload = await zipReplayCsvDownloadPromise;
  const zipReplayCsv = await readFile(await zipReplayCsvDownload.path(), 'utf8');
  const [zipReplayRow] = parseCsvRows(zipReplayCsv);
  expect(zipReplayRow).toMatchObject({
    kind: 'angle',
    label: 'branch-angle',
    slice: '1',
    z_index0: '0',
    channel: 'GFP',
    channel_index0: '1',
    time: '2',
    time_index0: '1',
    value_source: 'angular_measurement',
    source_format: 'OME-TIFF',
    source_files: 'angle-zip-replay-cells.ome.tiff',
    xy_spacing_row_mm: '0.00025',
    xy_spacing_col_mm: '0.0005',
    z_spacing_mm: '0.0015',
    calibration_unit: 'µm',
  });
  expect(Number(zipReplayRow.angle_deg)).toBeCloseTo(26.565, 3);
  const zipReplayJsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const zipReplayJsonDownload = await zipReplayJsonDownloadPromise;
  const zipReplayBundle = JSON.parse(await readFile(await zipReplayJsonDownload.path(), 'utf8'));
  expect(zipReplayBundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    source: {
      imageDomain: 'microscopy',
      format: 'OME-TIFF',
      sourceFiles: ['angle-zip-replay-cells.ome.tiff'],
      warnings: [],
    },
    calibration: {
      xyKnown: true,
      rowMm: 0.00025,
      colMm: 0.0005,
      zKnown: true,
      zMm: 0.0015,
      displayUnit: 'µm',
    },
    rows: [{
      kind: 'angle',
      label: 'branch-angle',
      slice: 1,
      sliceIndex: 0,
      angleDeg: expect.closeTo(26.565, 0.001),
      channel: 'GFP',
      channelIndex: 1,
      time: 2,
      timeIndex: 1,
      valueSource: 'angular_measurement',
      points,
    }],
  });
  const zipReplayPngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const zipReplayPngDownload = await zipReplayPngDownloadPromise;
  expect(zipReplayPngDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.png$/);
  const zipReplayPngMetrics = await renderedPngMetrics(page, await zipReplayPngDownload.path());
  expect(zipReplayPngMetrics).toMatchObject({
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
  });
  expect(zipReplayPngMetrics.roiBluePixels, JSON.stringify(zipReplayPngMetrics)).toBe(0);
  expect(zipReplayPngMetrics.angleWhitePixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(6);
  const zipReplayTiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const zipReplayTiffDownload = await zipReplayTiffDownloadPromise;
  expect(zipReplayTiffDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.tif$/);
  const zipReplayTiffMetrics = await renderedTiffMetrics(await zipReplayTiffDownload.path());
  expect(zipReplayTiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    pixelByteCount: CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height * 3,
  });
  expect(zipReplayTiffMetrics.description).toContain('ImageJ=1.54');
  expect(zipReplayTiffMetrics.description).toContain('pixel_width=0.5');
  expect(zipReplayTiffMetrics.description).toContain('pixel_height=0.25');
  expect(zipReplayTiffMetrics.description).toContain('spacing=1.5');
  expect(zipReplayTiffMetrics.description).toContain('label=Z 1 · C2 GFP · T2');

  const recipeReplayOmeTiffPath = testInfo.outputPath('angle-recipe-replay-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(recipeReplayOmeTiffPath);
  const countBeforeRecipeDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    { path: recipeReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('angle-recipe-replay-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Replayed 1 microscopy workflow recipe' }))
    .toContainText('Replayed 1 microscopy workflow recipe from VoxelLab sidecar.');
});
