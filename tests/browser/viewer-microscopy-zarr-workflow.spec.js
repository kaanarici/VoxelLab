import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { PIXEL, countPixels, readPngImage, readRenderedTiff } from '../helpers/browser/artifacts.mjs';
import { waitForSlicePaint } from '../helpers/browser/canvas.mjs';
import { uint16LeChunk } from '../helpers/browser/fixtures/tiff.mjs';
import { dropOnUploadZone, openLocalUploadModal } from '../helpers/browser/microscopy.mjs';
import { drawEllipseRoi } from '../helpers/browser/panels.mjs';
import { expectScaleBarFits } from '../helpers/browser/scale-bar.mjs';

async function writeChunkedOmeZarrFixture(testInfo) {
  const files = [];
  const zmetadataPath = testInfo.outputPath('zmetadata.json');
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
  const rootAttrs = {
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
  };
  const levelArray = {
    zarr_format: 2,
    'shape': [2, 96, 128],
    chunks: [1, 48, 64],
    dtype: '<u2',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  };
  await writeFile(zmetadataPath, JSON.stringify({
    zarr_consolidated_format: 1,
    metadata: {
      '.zattrs': rootAttrs,
      '0/.zarray': levelArray,
    },
  }));
  const rootJsonPath = testInfo.outputPath('root-zarr.json');
  const levelJsonPath = testInfo.outputPath('level-zarr.json');
  await writeFile(rootJsonPath, JSON.stringify({ zarr_format: 2 }));
  await writeFile(levelJsonPath, JSON.stringify(levelArray));
  return [
    { path: zmetadataPath, relativePath: 'cells.zarr/.zmetadata', mimeType: 'application/json' },
    { path: rootJsonPath, relativePath: 'cells.zarr/zarr.json', mimeType: 'application/json' },
    { path: levelJsonPath, relativePath: 'cells.zarr/0/zarr.json', mimeType: 'application/json' },
    ...files.map(file => ({ ...file, mimeType: 'application/octet-stream' })),
  ];
}

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
  const contextBox = { x0: 8, y0: 8, x1: Math.min(127, image.width), y1: 35 };
  return {
    width: image.width,
    height: image.height,
    contextDarkPixels: countPixels(image, PIXEL.dark, contextBox),
    contextBrightPixels: countPixels(image, PIXEL.chromeBright, contextBox),
    scaleBarBrightPixels: countPixels(image, PIXEL.bright, {
      x0: Math.max(0, image.width - 90),
      y0: Math.max(0, image.height - 18),
      x1: image.width - 6,
      y1: image.height - 4,
    }),
    roiBluePixels: countPixels(image, PIXEL.roiBlue, fractionRect(image, 0.30, 0.30, 0.75, 0.75)),
  };
}

async function renderedTiffMetrics(tiffPath) {
  const image = await readRenderedTiff(tiffPath);
  return { ...image, roiBluePixels: countPixels(image, PIXEL.roiBlue) };
}

test('OME-Zarr microscopy ROI results export calibration, replay recipes, and re-import safely', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const files = await writeChunkedOmeZarrFixture(testInfo);
  const notesPath = testInfo.outputPath('zarr-notes.md');
  await writeFile(notesPath, 'not image data');

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    ...files,
    { path: notesPath, relativePath: 'cells.zarr/notes.md', mimeType: 'text/markdown' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('cells');
  const intakeNotice = page.locator('#notify-container .notify-text').filter({ hasText: 'Local intake:' }).last();
  await expect(intakeNotice).toContainText('openable files (OME-Zarr');
  await expect(intakeNotice).toContainText('skipped 1 unsupported file');
  await expect(intakeNotice).not.toContainText('notes.md');
  await expect(intakeNotice).not.toContainText('JSON sidecar');
  await expect(page.locator('#series-desc')).toContainText('OME-Zarr');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-Zarr metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('OMERO transitional metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).not.toContainText('Z spacing missing');
  await waitForSlicePaint(page);
  await expectScaleBarFits(page);
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · LUT linear · range 100-700');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('GFP · LUT linear · range 1000-1700');
  await page.locator('#microscopy-channel-color').fill('#aa00cc');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('C2 GFP');
  await expect(row).toContainText('µm²');
  const roiObjectId = await row.getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('ome-zarr-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe).toMatchObject({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: { sourceFormat: 'OME-Zarr' },
    requirements: { measurementPrerequisite: 'results-present' },
    stack: { channelIndex: 1, timeIndex: 0 },
    calibration: { trust: 'Trusted metadata' },
    exportPreferences: { embeddedRoiResults: true },
  });
  expect(recipe.channels[1].color).toBe('#AA00CC');
  expect(recipe.roiResults.rows).toHaveLength(1);
  expect(recipe.roiResults.rows[0]).toMatchObject({
    roiObjectId,
    kind: 'ellipse',
    channel: 'GFP',
    channelIndex: 1,
    time: 1,
    timeIndex: 0,
  });

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = line.split(',');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells');
  expect(cells[6]).toBe('ellipse');
  expect(cells[14]).toBe('');
  expect(cells[15]).toBe('GFP');
  expect(cells[16]).toBe('1');
  const pixels = Number(cells[21]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(Number(cells[19]) - pixels * 0.125)).toBeLessThan(1e-6);
  expect(Math.abs(Number(cells[20]) - pixels * 0.00025 * 0.0005)).toBeLessThan(1e-12);
  expect(cells[29]).toBe('OME-Zarr');
  expect(cells[31]).toBe('OMERO transitional metadata');
  expect(cells[32]).toBe('0.00025');
  expect(cells[33]).toBe('0.0005');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('metadata');
  expect(cells[37]).toBe('Trusted metadata');
  expect(Number(cells[38])).toBeGreaterThan(0);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('ome-zarr-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source.format).toBe('OME-Zarr');
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm', trust: 'Trusted metadata' });
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
    channel: 'GFP',
    channelIndex: 1,
    time: 1,
    timeIndex: 0,
    areaUnit: 'µm²',
  });

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z1_c2_t1\.png$/);
  const pngMetrics = await screenshotPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({ width: 128, height: 96 });
  expect(pngMetrics.contextDarkPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(600);
  expect(pngMetrics.contextBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(20);
  expect(pngMetrics.scaleBarBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(35);
  expect(pngMetrics.roiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(8);

  const tiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const tiffDownload = await tiffDownloadPromise;
  expect(tiffDownload.suggestedFilename()).toMatch(/_z1_c2_t1\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: 128,
    height: 96,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    xResolution: 2,
    yResolution: 4,
    resolutionUnit: 1,
    pixelByteCount: 128 * 96 * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('unit=um');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('source_warnings=OMERO transitional metadata');
  expect(tiffMetrics.description).toContain('label=Z 1 · C2 GFP · T1');
  expect(tiffMetrics.description).not.toContain('spacing=');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(8);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-channel-color').fill('#0000ff');
  const mismatchedRecipePath = testInfo.outputPath('ome-zarr-workflow-recipe-mismatched-roi-results.json');
  await writeFile(mismatchedRecipePath, `${JSON.stringify({
    ...recipe,
    roiResults: {
      ...recipe.roiResults,
      calibration: { ...recipe.roiResults.calibration, rowMm: 0.001 },
    },
  }, null, 2)}\n`);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(mismatchedRecipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Recipe ROI results calibration does not match this microscopy stack.');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#0000ff');
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toHaveAttribute('data-roi-object-id', roiObjectId);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
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

  const countBeforeSidecarDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropOnUploadZone(page, [
    ...files,
    { path: jsonBundlePath, mimeType: 'application/json' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeSidecarDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-channel-color')).toHaveValue('#aa00cc');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toHaveAttribute('data-roi-object-id', roiObjectId);
  await expect(page.locator('[data-roi-result-row]')).toContainText('C2 GFP');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
});

test('OME-Zarr zarr.json-only selections explain missing OME metadata precisely', async ({ page }, testInfo) => {
  const zarrJsonPath = testInfo.outputPath('plain-zarr-json.json');
  await writeFile(zarrJsonPath, JSON.stringify({ zarr_format: 2 }));

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [
    { path: zarrJsonPath, relativePath: 'plain.zarr/zarr.json', mimeType: 'application/json' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('OME-Zarr metadata was not found in the selected .zattrs, .zarray, .zmetadata, or zarr.json files.');
  await expect(status).toContainText('Selected file: plain.zarr/zarr.json.');
  await expect(status).toContainText('selected 1 openable file (OME-Zarr)');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('OME-Zarr metadata-only boundaries show a warning instead of success', async ({ page }, testInfo) => {
  const zmetadataPath = testInfo.outputPath('compressed-zmetadata.json');
  await writeFile(zmetadataPath, JSON.stringify({
    zarr_consolidated_format: 1,
    metadata: {
      '.zattrs': {
        ome: {
          multiscales: [{
            version: '0.4',
            axes: [
              { name: 'y', type: 'space', unit: 'micrometer' },
              { name: 'x', type: 'space', unit: 'micrometer' },
            ],
            datasets: [{
              path: '0',
              coordinateTransformations: [{ type: 'scale', scale: [0.25, 0.5] }],
            }],
          }],
        },
      },
      '0/.zarray': {
        zarr_format: 2,
        'shape': [16, 16],
        chunks: [16, 16],
        dtype: '<u2',
        compressor: { id: 'gzip' },
        order: 'C',
        filters: null,
        fill_value: null,
      },
    },
  }));

  await openLocalUploadModal(page);
  const countBefore = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [
    { path: zmetadataPath, relativePath: 'cells.zarr/.zmetadata', mimeType: 'application/json' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-warning/);
  await expect(status).not.toHaveClass(/is-success/);
  await expect(status).toContainText('OME-Zarr metadata recognized');
  await expect(status).toContainText('Image loading is unavailable for this selection.');
  await expect(status).toContainText('No image series was added.');
  await expect(status).toContainText('OME-Zarr chunk is missing and the array has no concrete fill_value');
  await expect(page.locator('#series-list li')).toHaveCount(countBefore);
  await expect(page.locator('#upload-modal')).toBeVisible();
});
