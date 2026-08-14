/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertShellFits,
  closeApp,
  launchVoxelLab,
  writeTinyNifti,
} from './fixtures/electron-runtime-smoke-helpers.mjs';

test('Electron runtime opens local NIfTI with calibration and source provenance', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-electron-nifti-'));
  const niftiPath = path.join(tempDir, 'calibrated-brain.nii');
  await writeTinyNifti(niftiPath, { pixdim: [0.5, 0.75, 1] });

  const { app, page, pageErrors } = await launchVoxelLab([niftiPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'calibrated-brain', null, { timeout: 20_000 });
    const imported = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      const mprButton = document.getElementById('btn-mpr');
      const threeDButton = document.getElementById('btn-3d');
      return {
        description: document.getElementById('series-desc')?.textContent || '',
        meta: document.getElementById('meta')?.textContent || '',
        pixelSpacing: series?.pixelSpacing,
        sliceThickness: series?.sliceThickness,
        spacingKnown: series?._spacingKnown,
        niftiSpatialUnit: series?._niftiSpatialUnit,
        sourceFiles: series?.sourceFiles || [],
        mprVisible: !!mprButton && getComputedStyle(mprButton).display !== 'none',
        threeDVisible: !!threeDButton && getComputedStyle(threeDButton).display !== 'none',
      };
    });
    assert.match(imported.description, /NIfTI import/);
    assert.match(imported.meta, /Pixel spacing0\.750 mm × 0\.500 mm/);
    assert.match(imported.meta, /CalibrationNIfTI metadata \(mm\)/);
    assert.match(imported.meta, /Spacing trustTrusted voxel metadata/);
    assert.match(imported.meta, /Source file.*calibrated-brain\.nii/);
    assert.deepEqual(imported.pixelSpacing, [0.75, 0.5]);
    assert.equal(imported.sliceThickness, 1);
    assert.equal(imported.spacingKnown, true);
    assert.equal(imported.niftiSpatialUnit, 'mm');
    assert.deepEqual(imported.sourceFiles, ['calibrated-brain.nii']);
    assert.equal(imported.mprVisible, true);
    assert.equal(imported.threeDVisible, true);
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.path, niftiPath);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});
