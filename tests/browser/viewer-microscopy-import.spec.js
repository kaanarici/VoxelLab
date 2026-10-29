import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { canvasImageData, canvasPixel, settleFrames, waitForSlicePaint } from '../helpers/browser/canvas.mjs';
import { dropDirectory } from '../helpers/browser/drag-drop.mjs';
import {
  contrastingHyperstackPlaneValue,
  uint16LeChunk,
  writeHyperstackImageJTiff,
  writeHyperstackOmeTiff,
  writeTinySequenceTiff,
} from '../helpers/browser/fixtures/tiff.mjs';
import {
  applyManualCalibration,
  dropOnUploadZone,
  openLocalUploadModal,
} from '../helpers/browser/microscopy.mjs';
import { ensurePanelOpen } from '../helpers/browser/panels.mjs';
import { expectScaleBarFits } from '../helpers/browser/scale-bar.mjs';

const HYPERSTACK_PLANES = { planeValue: contrastingHyperstackPlaneValue };

test('upload modal can drag-and-drop a local OME-TIFF microscopy image with micron metadata', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Slice thickness' })).toContainText('1.50 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-TIFF metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('cells.ome.tiff');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('None');
  await waitForSlicePaint(page);
  await expectScaleBarFits(page);

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
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

test('upload modal keeps OME-TIFF with unsupported physical units uncalibrated', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('bad-unit-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { physicalUnit: 'furlong' });

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('bad-unit-cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Pixel spacing' }) })).toContainText('—');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Calibration' }) })).toContainText('Uncalibrated');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Spacing trust' }) })).toContainText('Unknown · XY unit unsupported');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Source warnings' }) })).toContainText('Unsupported X unit');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Source warnings' }) })).toContainText('Unsupported Y unit');
  await waitForSlicePaint(page);
  await expect(page.locator('#scale-bar')).toBeHidden();
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 3 warnings');

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      spacingKnown: series._spacingKnown,
      pixelSpacing: series.pixelSpacing,
      sourceWarnings: series.microscopyDataset?.source.warnings,
    };
  });
  expect(stateSnapshot).toMatchObject({
    spacingKnown: false,
    pixelSpacing: [0, 0],
    sourceWarnings: [
      'missing_xy_physical_size',
      'unsupported_x_physical_unit',
      'unsupported_y_physical_unit',
    ],
  });
});

test('upload modal opens OME-TIFF microscopy folders with ordinary lab metadata JSON skipped', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('ome-tiff-folder-with-json');
  const omeTiffPath = `${folderPath}/cells.ome.tiff`;
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/broken.json`, '{not json');

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-TIFF metadata');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (OME-TIFF) selected after checking 3 files; skipped 2 unsupported files');
  await waitForSlicePaint(page);
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
  await openLocalUploadModal(page);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);

  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('public-empty-cells');
  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#canvas-wrap')).not.toHaveClass(/no-series/);
  await expect(page.locator('#empty-state')).toBeHidden();
  await waitForSlicePaint(page);
  await expect(page.locator('#view')).toBeVisible();
  await expectScaleBarFits(page);
});

test('upload modal can open signed grayscale OME-TIFF microscopy planes', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('signed-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { width: 2, height: 1, pixels: [-128, 127], sampleFormat: 2 });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('signed-cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await waitForSlicePaint(page);
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
        const values = [];
        for (let y = 0; y < 2; y += 1) {
          for (let x = 0; x < 5; x += 1) {
            values.push(yStart + y < 4 && xStart + x < 8
              ? (c * 1000) + ((yStart + y) * 100) + ((xStart + x) * 10)
              : 0);
          }
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
    'shape': [2, 4, 8],
    chunks: [1, 2, 5],
    dtype: '<u2',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));

  await openLocalUploadModal(page);
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
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-Zarr metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('OMERO transitional metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).not.toContainText('Z spacing missing');
  await waitForSlicePaint(page);
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
  const beforeRangePixel = await canvasPixel(page, 3, 1);
  await page.locator('#microscopy-display-range-min').evaluate((input) => {
    input.value = '0';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#microscopy-display-range-max').evaluate((input) => {
    input.value = '370';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settleFrames(page);
  await expect(page.locator('#microscopy-display-range-min')).toHaveValue('0');
  await expect(page.locator('#microscopy-display-range-max')).toHaveValue('370');
  const afterRangePixel = await canvasPixel(page, 3, 1);
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
    const { state } = await import('/js/core/state.js');
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

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: dicomPath, mimeType: 'application/dicom' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Mixed native image families need separate imports for now');
  await expect(status).toContainText('1 microscopy TIFF file (mixed-cells.ome.tiff)');
  await expect(status).toContainText('1 DICOM or derived-object file (mixed-source.dcm)');
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

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_z');
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await expect(page.locator('#slice-tot')).toHaveText('3');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('Uncalibrated');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Unknown · XY spacing missing');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('3 files');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('seq_z001.tif, seq_z002.tif, plus 1 more');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Sequence order' })).toContainText('Numeric filename suffix');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('XY spacing missing');
  await waitForSlicePaint(page);
  await expect(page.locator('#scale-bar')).toBeHidden();
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  await ensurePanelOpen(page, '#microscopy-stack-panel');
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 2 warnings');
  await applyManualCalibration(page, { x: 0.5, y: 0.25, z: 1.5 });
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Calibration' }) })).toContainText('Manual calibration');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Spacing trust' }) })).toContainText('Manual calibration');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Pixel spacing' }) })).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Sequence order' })).toContainText('Numeric filename suffix');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('None');
  await expect(page.locator('#microscopy-recipe-export')).toBeVisible();
  await expect(page.locator('#microscopy-recipe-import')).toBeVisible();

  await page.locator('#scrub').evaluate((input) => {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('3');
  await waitForSlicePaint(page);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
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

test('OME microscopy hyperstack import stays one series and switches channels without losing Z', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-hyper.ome.tiff');
  await writeHyperstackOmeTiff(omeTiffPath, HYPERSTACK_PLANES);

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-hyper');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForSlicePaint(page);

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
  const before = await canvasImageData(page);

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
  const compositePixel = await canvasPixel(page);
  expect(compositePixel[1]).toBeGreaterThan(0);
  expect(compositePixel[2]).toBeGreaterThan(0);
  expect(compositePixel[0]).toBe(0);
  await page.locator('#microscopy-composite-c1').uncheck();
  const dapiOnlyPixel = await canvasPixel(page);
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
  const after = await canvasImageData(page);
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
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
    mprHidden: false,
    threeHidden: false,
  });
});

test('ImageJ microscopy hyperstack import uses channel-fast order in the same C/T controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const imageJPath = testInfo.outputPath('cells-imagej.tif');
  await writeHyperstackImageJTiff(imageJPath, HYPERSTACK_PLANES);

  await openLocalUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropOnUploadZone(page, [{ path: imageJPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-desc')).toContainText('ImageJ-TIFF');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForSlicePaint(page);

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#microscopy-stack-panel .sec-title').click();
  const before = await canvasImageData(page);

  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 2/2 · T 1/1');
  const after = await canvasImageData(page);
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
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

test('a TIFF sequence without numeric plane indices reports lexical sequence order', async ({ page }, testInfo) => {
  const sequencePaths = [
    testInfo.outputPath('plate_c.tif'),
    testInfo.outputPath('plate_a.tif'),
    testInfo.outputPath('plate_b.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], [240, 250, 255]);
  await writeTinySequenceTiff(sequencePaths[1], [20, 30, 40]);
  await writeTinySequenceTiff(sequencePaths[2], [120, 130, 140]);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));

  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await expect(page.locator('#slice-tot')).toHaveText('3');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Sequence order' }))
    .toContainText('Lexical filename order');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' }))
    .toContainText('plate_a.tif, plate_b.tif, plus 1 more');
  await waitForSlicePaint(page);

  expect(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      orderStrategy: series.microscopy?.sequenceProvenance?.orderStrategy,
      planeNames: series.microscopyDataset?.source.provenance?.planes.map(plane => plane.name),
      sourceFiles: series.microscopy?.sourceFiles,
    };
  })).toEqual({
    orderStrategy: 'lexical',
    planeNames: ['plate_a.tif', 'plate_b.tif', 'plate_c.tif'],
    sourceFiles: ['plate_a.tif', 'plate_b.tif', 'plate_c.tif'],
  });
});
