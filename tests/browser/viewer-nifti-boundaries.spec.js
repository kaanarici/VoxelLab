/* global Buffer */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import { dropFiles, openUploadModal, routeConfig } from './microscopy-upload-helpers.mjs';

async function writeTiny4dNifti(path) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(4, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 48);
  buffer.writeInt16LE(2, 70);
  buffer.writeFloatLE(1, 76 + 4);
  buffer.writeFloatLE(1, 76 + 8);
  buffer.writeFloatLE(1, 76 + 12);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(2, 123);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeTiny3dNifti(path) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 70);
  buffer.writeFloatLE(1, 76 + 4);
  buffer.writeFloatLE(1, 76 + 8);
  buffer.writeFloatLE(1, 76 + 12);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(2, 123);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

test('upload modal reports unsupported 4D NIfTI without importing a series', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('fmri-timeseries.nii');
  await writeTiny4dNifti(niftiPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: niftiPath }]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('4D/time-series or higher-dimensional NIfTI files are not supported yet');
  await expect(status).toContainText('fmri-timeseries.nii');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
});

test('upload modal explains mixed native medical and microscopy folders by family', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('mixed-native/brain.nii');
  const microscopyPath = testInfo.outputPath('mixed-native/cells.ome.tiff');
  await writeTiny3dNifti(niftiPath);
  await mkdir(dirname(microscopyPath), { recursive: true });
  await writeFile(microscopyPath, 'not parsed because mixed native families fail before import');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [
    { path: niftiPath, relativePath: 'mixed-native/brain.nii' },
    { path: microscopyPath, mimeType: 'image/tiff', relativePath: 'mixed-native/cells.ome.tiff' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Mixed native image families need separate imports for now');
  await expect(status).toContainText('1 NIfTI file (mixed-native/brain.nii)');
  await expect(status).toContainText('1 microscopy TIFF file (mixed-native/cells.ome.tiff)');
  await expect(status).toContainText('Open one family at a time so calibration, sidecars, and geometry stay tied to the right source data');
  await expect(status).toContainText('selected 2 openable files (NIfTI, OME-TIFF)');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
});
