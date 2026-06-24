/* global document, Event, getComputedStyle */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertShellFits,
  closeApp,
  launchVoxelLab,
  writeTinySequenceTiff,
} from './fixtures/electron-runtime-smoke-helpers.mjs';

async function ensurePanelOpen(page, panelSelector, visibleSelector) {
  const panel = page.locator(panelSelector);
  if (await panel.evaluate(element => element.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await page.locator(visibleSelector).waitFor({ state: 'visible', timeout: 10_000 });
}

test('Electron runtime opens local TIFF sequence with provenance and manual calibration', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-electron-tiff-sequence-'));
  const sequencePaths = [
    path.join(tempDir, 'seq_z003.tif'),
    path.join(tempDir, 'seq_z001.tif'),
    path.join(tempDir, 'seq_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], [240, 250, 255]);
  await writeTinySequenceTiff(sequencePaths[1], [20, 30, 40]);
  await writeTinySequenceTiff(sequencePaths[2], [120, 130, 140]);

  const { app, page, pageErrors } = await launchVoxelLab(sequencePaths);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'seq_z', null, { timeout: 20_000 });
    await page.waitForFunction(() => document.getElementById('slice-tot')?.textContent === '3', null, { timeout: 10_000 });
    const beforeCalibration = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      return {
        description: document.getElementById('series-desc')?.textContent || '',
        meta: document.getElementById('meta')?.textContent || '',
        calibration: document.getElementById('microscopy-calibration')?.textContent || '',
        scaleBarHidden: getComputedStyle(document.getElementById('scale-bar')).display === 'none',
        mprVisible: getComputedStyle(document.getElementById('btn-mpr')).display !== 'none',
        threeDVisible: getComputedStyle(document.getElementById('btn-3d')).display !== 'none',
        sourceFiles: series.microscopy?.sourceFiles || [],
        sourceFormat: series.microscopyDataset?.source?.originalFormat,
        orderStrategy: series.microscopy?.sequenceProvenance?.orderStrategy,
        sourceWarnings: series.microscopyDataset?.source?.warnings || [],
        pixelSpacing: series.pixelSpacing,
        sliceThickness: series.sliceThickness,
      };
    });

    assert.match(beforeCalibration.description, /TIFF sequence/);
    assert.match(beforeCalibration.meta, /Source files.*seq_z001\.tif, seq_z002\.tif, plus 1 more/);
    assert.match(beforeCalibration.meta, /Sequence order.*Numeric filename suffix/);
    assert.match(beforeCalibration.meta, /Calibration.*Uncalibrated/);
    assert.match(beforeCalibration.meta, /Spacing trust.*Unknown · XY spacing missing/);
    assert.equal(beforeCalibration.calibration, 'XY uncalibrated · 2 warnings');
    assert.equal(beforeCalibration.scaleBarHidden, true);
    assert.equal(beforeCalibration.mprVisible, false);
    assert.equal(beforeCalibration.threeDVisible, false);
    assert.deepEqual(beforeCalibration.sourceFiles, ['seq_z001.tif', 'seq_z002.tif', 'seq_z003.tif']);
    assert.equal(beforeCalibration.sourceFormat, 'TIFF sequence');
    assert.equal(beforeCalibration.orderStrategy, 'numeric-suffix');
    assert.deepEqual(beforeCalibration.sourceWarnings, ['missing_xy_physical_size', 'missing_z_physical_size']);
    assert.deepEqual(beforeCalibration.pixelSpacing, [0, 0]);
    assert.equal(beforeCalibration.sliceThickness, 0);

    await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-calibration-apply');
    await page.locator('#microscopy-calibration-x').fill('0.5');
    await page.locator('#microscopy-calibration-y').fill('0.25');
    await page.locator('#microscopy-calibration-z').fill('1.5');
    await page.locator('#microscopy-calibration-apply').click();
    await page.waitForFunction(() => document.getElementById('microscopy-calibration')?.textContent === 'X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm', null, { timeout: 10_000 });
    await page.locator('#scrub').evaluate((input) => {
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('slice-cur')?.textContent === '3', null, { timeout: 10_000 });

    const afterCalibration = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      return {
        meta: document.getElementById('meta')?.textContent || '',
        pixelSpacing: series.pixelSpacing,
        sliceSpacing: series.sliceSpacing,
        sliceThickness: series.sliceThickness,
        calibrationSource: series.microscopy?.calibrationSource,
        axesCalibration: series.microscopyDataset?.axes
          .filter(axis => ['x', 'y', 'z'].includes(axis.name))
          .map(axis => [axis.name, axis.scale, axis.unit, axis.known]),
        currentSlice: state.sliceIdx,
      };
    });
    assert.match(afterCalibration.meta, /Calibration.*Manual calibration/);
    assert.match(afterCalibration.meta, /Spacing trust.*Manual calibration/);
    assert.match(afterCalibration.meta, /Pixel spacing.*0\.250 µm × 0\.500 µm/);
    assert.match(afterCalibration.meta, /Source warnings.*None/);
    assert.deepEqual(afterCalibration.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(afterCalibration.sliceSpacing, 0.0015);
    assert.equal(afterCalibration.sliceThickness, 0.0015);
    assert.equal(afterCalibration.calibrationSource, 'manual');
    assert.deepEqual(afterCalibration.axesCalibration, [['x', 0.5, 'µm', true], ['y', 0.25, 'µm', true], ['z', 1.5, 'µm', true]]);
    assert.equal(afterCalibration.currentSlice, 2);
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.path, sequencePaths[0]);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});
