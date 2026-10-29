import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { parseImageJRoiZip } from '../../js/microscopy/imagej-roi.js';
import { reopenUploadModal } from '../helpers/browser/app.mjs';
import { PIXEL, countPixels, parseCsvRows, readRenderedTiff } from '../helpers/browser/artifacts.mjs';
import { setSliderValue, settleFrames, waitForSlicePaint } from '../helpers/browser/canvas.mjs';
import { sequencePlane, writeTinySequenceTiff } from '../helpers/browser/fixtures/tiff.mjs';
import {
  assertNoRoiResultsOverflow,
  openDetailsPanelForViewport,
} from '../helpers/browser/layout.mjs';
import {
  applyManualCalibration,
  dropOnUploadZone,
  openLocalUploadModal,
} from '../helpers/browser/microscopy.mjs';
import {
  clearSliceDrawings,
  drawAngleMeasurement,
  drawEllipseRoi,
  ensurePanelOpen,
} from '../helpers/browser/panels.mjs';
import { expectScaleBarFits } from '../helpers/browser/scale-bar.mjs';

async function renderedTiffMetrics(tiffPath) {
  const image = await readRenderedTiff(tiffPath);
  return {
    ...image,
    roiBluePixels: countPixels(image, PIXEL.roiBlue),
    scaleBarBrightPixels: countPixels(image, PIXEL.bright, {
      x0: Math.max(0, image.width - 84),
      y0: Math.max(0, image.height - 18),
      x1: image.width - 6,
      y1: image.height - 4,
    }),
  };
}

test('uncalibrated microscopy ROI sidecar imports geometry without trusting physical metrics', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const width = 32;
  const height = 24;
  const sequencePaths = [
    testInfo.outputPath('untrusted_roi_z001.tif'),
    testInfo.outputPath('untrusted_roi_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], sequencePlane(width, height, 20), { width, height });
  await writeTinySequenceTiff(sequencePaths[1], sequencePlane(width, height, 80), { width, height });

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('untrusted_roi_z');
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-calibration');
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 2 warnings');
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-json-import');

  const target = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { seriesPersistenceKey } = await import('/js/core/series-identity.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      slug: series.slug,
      name: series.name,
      width: series.width,
      height: series.height,
      slices: series.slices,
      persistenceKey: seriesPersistenceKey(series, state.manifest),
    };
  });
  const bundlePath = testInfo.outputPath('untrusted-roi-results.json');
  await writeFile(bundlePath, `${JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: target,
    calibration: { xyKnown: false, displayUnit: 'µm' },
    rows: [{
      roiObjectId: `roi:${target.slug}|0:5`,
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Imported geometry only',
      points: [[2, 2], [14, 2], [14, 10], [2, 10]],
      pixels: 96,
      mean: 34.5,
      rawIntDen: 3312,
      intDen: 888,
      intDenMm2: 0.000888,
      areaMm2: 0.000024,
      perimeterMm: 0.024,
    }, {
      roiObjectId: `measure:${target.slug}|0:6`,
      sliceIndex: 0,
      kind: 'line',
      label: 'Untrusted calibrated length',
      points: [[2, 12], [18, 12]],
      lengthMm: 0.008,
    }],
  }, null, 2)}\n`);

  await page.locator('#roi-results-json-import-input').setInputFiles(bundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row; skipped incompatible rows');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  const rowSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { roiResultRows } = await import('/js/roi/roi-results.js');
    const row = roiResultRows(state)[0];
    return {
      label: row.label,
      areaMm2: row.areaMm2,
      perimeterMm: row.perimeterMm,
      intDen: row.intDen,
      intDenMm2: row.intDenMm2,
      rawIntDen: row.rawIntDen,
      lengthMm: row.lengthMm,
    };
  });
  expect(rowSnapshot).toEqual({
    label: 'Imported geometry only',
    areaMm2: null,
    perimeterMm: null,
    intDen: null,
    intDenMm2: null,
    rawIntDen: 3312,
    lengthMm: null,
  });
  await expect(page.locator('[data-roi-result-row]')).toContainText('Imported geometry only');
  await expect(page.locator('[data-roi-result-row]')).not.toContainText('Untrusted calibrated length');
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csvRows = parseCsvRows(await readFile(await csvDownload.path(), 'utf8'));
  expect(csvRows).toHaveLength(1);
  expect(csvRows[0]).toMatchObject({
    label: 'Imported geometry only',
    pixels: '96',
    raw_int_den: '3312',
    area_mm2: '',
    perimeter_mm: '',
    int_den: '',
    int_den_mm2: '',
  });
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const bundle = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(bundle.calibration.xyKnown).toBe(false);
  expect(bundle.rows[0]).toMatchObject({
    label: 'Imported geometry only',
    pixels: 96,
    rawIntDen: 3312,
    areaMm2: null,
    perimeterMm: null,
    intDen: null,
    intDenMm2: null,
  });
});

const SEQUENCE_WIDTH = 96;
const SEQUENCE_HEIGHT = 64;
const MANUAL_CALIBRATION = { x: 0.5, y: 0.25, z: 2 };
const CALIBRATION_LABEL = 'X 0.500 µm/px · Y 0.250 µm/px · Z 2.00 µm';

async function writeSequence(testInfo, stem, bases) {
  const paths = ['003', '001', '002'].map(suffix => testInfo.outputPath(`${stem}_z${suffix}.tif`));
  for (const [index, path] of paths.entries()) {
    await writeTinySequenceTiff(path, sequencePlane(SEQUENCE_WIDTH, SEQUENCE_HEIGHT, bases[index]), {
      width: SEQUENCE_WIDTH,
      height: SEQUENCE_HEIGHT,
    });
  }
  return paths;
}

async function openManualCalibratedSequence(page, testInfo, stem, bases) {
  await page.setViewportSize({ width: 1280, height: 840 });
  const paths = await writeSequence(testInfo, stem, bases);
  await openLocalUploadModal(page);
  await dropOnUploadZone(page, paths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await waitForSlicePaint(page);
  await expect(page.locator('#scale-bar')).toBeHidden();

  await ensurePanelOpen(page, '#microscopy-stack-panel');
  await applyManualCalibration(page, MANUAL_CALIBRATION);
  await expect(page.locator('#microscopy-calibration')).toHaveText(CALIBRATION_LABEL);
  await expectScaleBarFits(page);

  await setSliderValue(page, '#scrub', 1);
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await waitForSlicePaint(page);
  return paths;
}

async function triggerDownload(page, trigger) {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  return downloadPromise;
}

async function downloadJson(page, trigger) {
  const download = await triggerDownload(page, trigger);
  const path = await download.path();
  return { path, download, value: JSON.parse(await readFile(path, 'utf8')) };
}

async function drawCalibratedRoi(page) {
  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('Z 2');
  await expect(row).toContainText('µm²');
  return row;
}

test('manual sequence calibration exports a recipe that replays onto another uncalibrated sequence', async ({ page }, testInfo) => {
  await openManualCalibratedSequence(page, testInfo, 'seq_workflow', [180, 20, 90]);

  const recipe = await downloadJson(page, () => page.locator('#microscopy-recipe-export').click());
  expect(recipe.value.target.sourceFormat).toBe('TIFF sequence');
  expect(recipe.value.requirements).toMatchObject({ calibrationRequired: true, measurementPrerequisite: 'none' });
  expect(recipe.value.calibration).toMatchObject({
    xyKnown: true,
    rowMm: 0.00025,
    colMm: 0.0005,
    zKnown: true,
    zMm: 0.002,
    displayUnit: 'µm',
    trust: 'Manual calibration',
  });
  expect(recipe.value.view.sliceIndex).toBe(1);

  const replaySequencePaths = await writeSequence(testInfo, 'seq_replay', [210, 40, 120]);
  await reopenUploadModal(page);
  await dropOnUploadZone(page, replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_replay_z');
  await expect(page.locator('#scale-bar')).toBeHidden();
  await ensurePanelOpen(page, '#microscopy-stack-panel');

  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipe.path);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#microscopy-calibration')).toHaveText(CALIBRATION_LABEL);
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expectScaleBarFits(page);
});

test('a ROI on a manually calibrated sequence exports trusted CSV, JSON, and rendered snapshots', async ({ page }, testInfo) => {
  await openManualCalibratedSequence(page, testInfo, 'seq_replay', [210, 40, 120]);
  await drawCalibratedRoi(page);

  const csvDownload = await triggerDownload(page, () => page.locator('#roi-results-export').click());
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = line.split(',');
  expect(cells[4]).toBe('2');
  expect(cells[5]).toBe('1');
  expect(cells[6]).toBe('ellipse');
  expect(Number(cells[19])).toBeGreaterThan(0);
  expect(Number(cells[20])).toBeGreaterThan(0);
  expect(Number(cells[21])).toBeGreaterThan(0);
  expect(cells[29]).toBe('TIFF sequence');
  expect(cells[30]).toContain('seq_replay_z001.tif');
  expect(cells[31]).toBe('');
  expect(cells[32]).toBe('0.00025');
  expect(cells[33]).toBe('0.0005');
  expect(cells[34]).toBe('0.002');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('manual');
  expect(cells[37]).toBe('Manual calibration');

  const bundle = await downloadJson(page, () => page.locator('#roi-results-json-export').click());
  expect(bundle.value.source.format).toBe('TIFF sequence');
  expect(bundle.value.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.002, trust: 'Manual calibration' });
  expect(bundle.value.rows[0]).toMatchObject({ slice: 2, sliceIndex: 1, kind: 'ellipse', areaUnit: 'µm²' });
  expect(bundle.value.source.dataset.axes.filter(axis => ['x', 'y', 'z'].includes(axis.name)).map(axis => [axis.name, axis.scale, axis.unit, axis.known])).toEqual([
    ['x', 0.5, 'µm', true],
    ['y', 0.25, 'µm', true],
    ['z', 2, 'µm', true],
  ]);

  const pngDownload = await triggerDownload(page, () => page.locator('#btn-shot').click());
  expect(pngDownload.suggestedFilename()).toMatch(/_z2_c1_t1\.png$/);
  expect((await readFile(await pngDownload.path())).length).toBeGreaterThan(50);

  const tiffDownload = await triggerDownload(page, async () => {
    await page.locator('#btn-cmdk-open').click();
    await page.locator('#cmdk-input').fill('tiff snapshot');
    await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  });
  expect(tiffDownload.suggestedFilename()).toMatch(/_z2_c1_t1\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: SEQUENCE_WIDTH,
    height: SEQUENCE_HEIGHT,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    xResolution: 2,
    yResolution: 4,
    resolutionUnit: 1,
    pixelByteCount: SEQUENCE_WIDTH * SEQUENCE_HEIGHT * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('unit=um');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=2');
  expect(tiffMetrics.description).toContain('label=Z 2 · C1 Channel 1 · T1');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(8);
  expect(tiffMetrics.scaleBarBrightPixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(35);
});

test('a measured workflow recipe replays its embedded ROI row and rejects rows that do not fit', async ({ page }, testInfo) => {
  const replaySequencePaths = await openManualCalibratedSequence(page, testInfo, 'seq_replay', [210, 40, 120]);
  const row = await drawCalibratedRoi(page);
  const roiObjectId = await row.getAttribute('data-roi-object-id');

  const measuredRecipe = await downloadJson(page, () => page.locator('#microscopy-recipe-export').click());
  expect(measuredRecipe.value.target.sourceFormat).toBe('TIFF sequence');
  expect(measuredRecipe.value.requirements).toMatchObject({ calibrationRequired: true, measurementPrerequisite: 'results-present' });
  expect(measuredRecipe.value.exportPreferences).toMatchObject({ embeddedRoiResults: true });
  expect(measuredRecipe.value.view.sliceIndex).toBe(1);
  expect(measuredRecipe.value.roiResults.rows).toHaveLength(1);
  expect(measuredRecipe.value.roiResults.rows[0]).toMatchObject({
    roiObjectId,
    slice: 2,
    sliceIndex: 1,
    kind: 'ellipse',
    areaUnit: 'µm²',
  });

  await clearSliceDrawings(page);
  const clippedRecipePath = testInfo.outputPath('clipped-embedded-roi-recipe.json');
  await writeFile(clippedRecipePath, `${JSON.stringify({
    ...measuredRecipe.value,
    view: { ...measuredRecipe.value.view, sliceIndex: 0 },
    roiResults: {
      ...measuredRecipe.value.roiResults,
      rows: [{
        ...measuredRecipe.value.roiResults.rows[0],
      }, {
        ...measuredRecipe.value.roiResults.rows[0],
        roiObjectId: `${roiObjectId}:clipped`,
        label: 'Clipped embedded ROI',
        points: [[1, 1], [SEQUENCE_WIDTH + 10, 1], [1, 4]],
      }],
    },
  }, null, 2)}\n`);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(clippedRecipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Recipe ROI results include rows that do not fit this microscopy stack.');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('0');

  const countBeforeClippedRecipeDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    ...replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })),
    { path: clippedRecipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeClippedRecipeDrop + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 microscopy workflow recipe' }))
    .toContainText('clipped-embedded-roi-recipe.json (Recipe ROI results include rows that do not fit this microscopy stack)');
  await expect(page.locator('#roi-results-count')).toHaveText('0');

  await page.locator('#microscopy-recipe-import-input').setInputFiles(measuredRecipe.path);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const recipeRow = page.locator('[data-roi-result-row]');
  await expect(recipeRow).toHaveAttribute('data-roi-object-id', roiObjectId);
  await expect(recipeRow).toContainText('Z 2');
  await expect(recipeRow).toContainText('µm²');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
});

test('ROI result bundles import only the rows that fit the calibrated stack', async ({ page }, testInfo) => {
  const replaySequencePaths = await openManualCalibratedSequence(page, testInfo, 'seq_replay', [210, 40, 120]);
  const calibrationRecipe = await downloadJson(page, () => page.locator('#microscopy-recipe-export').click());
  const calibrationRecipePath = testInfo.outputPath('calibration-recipe.json');
  await writeFile(calibrationRecipePath, `${JSON.stringify(calibrationRecipe.value, null, 2)}\n`);

  await drawCalibratedRoi(page);
  const bundle = await downloadJson(page, () => page.locator('#roi-results-json-export').click());

  const mismatchedBundlePath = testInfo.outputPath('mismatched-roi-results.json');
  await writeFile(mismatchedBundlePath, `${JSON.stringify({
    ...bundle.value,
    calibration: { ...bundle.value.calibration, rowMm: 0.001 },
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(mismatchedBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('ROI bundle calibration does not match this microscopy stack');
  await expect(page.locator('#roi-results-count')).toHaveText('1');

  await clearSliceDrawings(page);
  await page.locator('#roi-results-json-import-input').setInputFiles(bundle.path);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const importedRow = page.locator('[data-roi-result-row]');
  await expect(importedRow).toHaveAttribute('data-roi-object-id', bundle.value.rows[0].roiObjectId);
  await expect(importedRow).toContainText('Z 2');
  await expect(importedRow).toContainText('µm²');
  await expect(importedRow).toContainText('Display-domain 8-bit intensity');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);

  await clearSliceDrawings(page);
  const clippedBundlePath = testInfo.outputPath('clipped-roi-results.json');
  await writeFile(clippedBundlePath, `${JSON.stringify({
    ...bundle.value,
    rows: [{
      ...bundle.value.rows[0],
      roiObjectId: `${bundle.value.rows[0].roiObjectId}:bounded`,
      label: 'Accepted bounded ROI',
    }, {
      ...bundle.value.rows[0],
      roiObjectId: `${bundle.value.rows[0].roiObjectId}:clipped-polygon`,
      label: 'Clipped polygon',
      points: [[1, 1], [SEQUENCE_WIDTH + 10, 1], [1, 4]],
    }, {
      roiObjectId: `measure:${bundle.value.series.slug}|${bundle.value.rows[0].sliceIndex}:clipped-line`,
      sliceIndex: bundle.value.rows[0].sliceIndex,
      kind: 'line',
      label: 'Clipped line',
      points: [[2, 2], [-1, 2]],
      lengthMm: 0.001,
    }, {
      roiObjectId: `angle:${bundle.value.series.slug}|${bundle.value.rows[0].sliceIndex}:clipped-angle`,
      sliceIndex: bundle.value.rows[0].sliceIndex,
      kind: 'angle',
      label: 'Clipped angle',
      points: [[2, 2], [4, 4], [4, SEQUENCE_HEIGHT + 5]],
      angleDeg: 45,
    }],
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(clippedBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row; skipped incompatible rows');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Accepted bounded ROI');
  await expect(page.locator('[data-roi-result-row]')).not.toContainText('Clipped');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);

  await clearSliceDrawings(page);
  const countBeforeClippedBundleDrop = await page.locator('#series-list li').count();
  await reopenUploadModal(page);
  await dropOnUploadZone(page, [
    ...replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })),
    { path: calibrationRecipePath, mimeType: 'application/json' },
    { path: clippedBundlePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeClippedBundleDrop + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Replayed 1 microscopy workflow recipe' }))
    .toContainText('from VoxelLab sidecar');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ROI result row' }))
    .toContainText('skipped incompatible rows from VoxelLab sidecar.');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Accepted bounded ROI');

  await clearSliceDrawings(page);
  const sparseBundlePath = testInfo.outputPath('sparse-density-roi-results.json');
  await writeFile(sparseBundlePath, `${JSON.stringify({
    ...bundle.value,
    rows: [{
      roiObjectId: bundle.value.rows[0].roiObjectId,
      sliceIndex: bundle.value.rows[0].sliceIndex,
      kind: bundle.value.rows[0].kind,
      label: 'Sparse density',
      points: bundle.value.rows[0].points,
      rawIntDen: 1234,
      intDen: 56.75,
      intDenMm2: 0.00005675,
    }],
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(sparseBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const sparseCsvDownload = await triggerDownload(page, () => page.locator('#roi-results-export').click());
  const sparseCsv = await readFile(await sparseCsvDownload.path(), 'utf8');
  const [sparseHeader, sparseLine] = sparseCsv.trim().split('\n');
  const sparseHeaders = sparseHeader.split(',');
  const sparseCells = sparseLine.split(',');
  expect(sparseCells[sparseHeaders.indexOf('raw_int_den')]).toBe('1234');
  expect(sparseCells[sparseHeaders.indexOf('int_den')]).toBe('56.75');
  expect(sparseCells[sparseHeaders.indexOf('int_den_mm2')]).toBe('0.00005675');
});

test('microscopy ROI results render calibrated rows and export CSV without layout overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-roi.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForSlicePaint(page);

  await page.locator('#roi-results-panel .sec-title').click();
  await expect(page.locator('#roi-results')).toContainText('No ROI results');
  await expect(page.locator('#roi-results-export')).toBeDisabled();
  await expect(page.locator('#roi-results-json-export')).toBeDisabled();

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('ROI 1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('µm²');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Raw intensity (16-bit measurement)');
  const roiObjectId = await page.locator('[data-roi-result-row]').getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csvPath = await download.path();
  const csv = await readFile(csvPath, 'utf8');
  const csvLines = csv.trim().split('\n');
  expect(csvLines[0]).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = csvLines[1].split(',');
  expect(cells[0]).toBe('1');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells-roi');
  expect(cells[4]).toBe('1');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('ellipse');
  expect(cells[7]).toBe('ROI 1');
  expect(cells[14]).toBe('');
  expect(cells[15]).toBe('DAPI');
  expect(cells[16]).toBe('0');
  const areaUm2 = Number(cells[19]);
  const areaMm2 = Number(cells[20]);
  const pixels = Number(cells[21]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(areaUm2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(cells[26]).toBe('raw');
  expect(cells[27]).toBe('raw_16bit');
  expect(cells[29]).toBe('OME-TIFF');
  expect(cells[30]).toBe('cells-roi.ome.tiff');
  expect(cells[31]).toBe('');
  expect(cells[32]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[0]));
  expect(cells[33]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[1]));
  expect(cells[34]).toBe('0.0015');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('metadata');
  expect(cells[37]).toBe('Trusted metadata');
  expect(Number(cells[38])).toBeGreaterThan(0);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 820, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await settleFrames(page);
    await openDetailsPanelForViewport(page, viewport);
    await assertNoRoiResultsOverflow(page);
  }
});

test('manual microscopy angle measurement enables ImageJ ROI ZIP export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const omeTiffPath = testInfo.outputPath('manual-angle-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await openLocalUploadModal(page);
  await dropOnUploadZone(page, [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForSlicePaint(page);
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#roi-results-imagej-export')).toBeDisabled();

  await drawAngleMeasurement(page);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const angleRow = page.locator('[data-roi-result-row]').filter({ hasText: 'Angle 1' });
  await expect(angleRow).toContainText('angle');
  await expect(angleRow).toContainText('Calibrated angle');
  await expect(angleRow).toContainText('°');
  await expect(page.locator('#roi-results-export')).toBeEnabled();
  await expect(page.locator('#roi-results-json-export')).toBeEnabled();
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [csvRow] = parseCsvRows(csv);
  expect(csvRow.kind).toBe('angle');
  expect(csvRow.label).toBe('Angle 1');
  expect(Number(csvRow.angle_deg)).toBeGreaterThan(0);
  expect(csvRow.value_source).toBe('angular_measurement');
  expect(csvRow.source_format).toBe('OME-TIFF');
  expect(csvRow.xy_spacing_row_mm).toBe('0.00025');
  expect(csvRow.xy_spacing_col_mm).toBe('0.0005');
  expect(csvRow.channel_index0).toBe('0');
  expect(csvRow.time_index0).toBe('0');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const json = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(json.rows).toHaveLength(1);
  expect(json.rows[0]).toMatchObject({
    kind: 'angle',
    label: 'Angle 1',
    channelIndex: 0,
    timeIndex: 0,
    valueSource: 'angular_measurement',
  });
  expect(json.rows[0].angleDeg).toBeCloseTo(Number(csvRow.angle_deg), 6);
  expect(json.rows[0].points).toHaveLength(3);

  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('manual-angle-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0]['shape']).toBe('angle');
  expect(exportedRois[0].name).toBe('Angle-1_z1_c1_t1');
  expect(exportedRois[0].label).toBe('Angle 1');
  expect(exportedRois[0].points).toHaveLength(3);
});
