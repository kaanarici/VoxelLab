/* global Buffer */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import { dropFiles, openUploadModal, routeConfig } from './microscopy-upload-helpers.mjs';

async function writeTiny4dNifti(path) {
  const buffer = Buffer.alloc(352 + 16);
  buffer.writeInt32LE(348, 0);
  buffer.write('n+1\0', 344, 'ascii');
  buffer.writeInt16LE(4, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 48);
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  buffer.writeFloatLE(1, 76 + 4);
  buffer.writeFloatLE(1, 76 + 8);
  buffer.writeFloatLE(1, 76 + 12);
  buffer.writeFloatLE(2, 76 + 16);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(10, 123); // millimeters + seconds
  buffer.writeFloatLE(0.5, 136);
  for (let index = 0; index < 16; index += 1) buffer[352 + index] = index * 8;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeTiny3dNifti(path) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.write('n+1\0', 344, 'ascii');
  buffer.writeInt16LE(3, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  buffer.writeFloatLE(1, 76 + 4);
  buffer.writeFloatLE(1, 76 + 8);
  buffer.writeFloatLE(1, 76 + 12);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(2, 123);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

test('upload modal imports 4D NIfTI as independently selectable calibrated timepoint series', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('fmri-timeseries.nii');
  await writeTiny4dNifti(niftiPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: niftiPath }]);

  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 2);
  await expect(page.locator('#series-name')).toHaveText('fmri-timeseries · time 1/2');
  await expect(page.locator('#meta')).toContainText('NIfTI timepoint1 / 2 (index 0)');
  await expect(page.locator('#meta')).toContainText('Temporal spacing2 second');
  await expect(page.locator('#meta')).toContainText('Time origin0.5 second');
  const localThumbnailRequests = [];
  page.on('request', (request) => {
    if (/\/data\/nifti_.*\.png$/.test(new URL(request.url()).pathname)) {
      localThumbnailRequests.push(request.url());
    }
  });
  const secondTimepoint = page.locator('#series-list li').filter({ hasText: 'fmri-timeseries · time 2/2' });
  await secondTimepoint.click();
  await expect(page.locator('#meta')).toContainText('NIfTI timepoint2 / 2 (index 1)');
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    const stack = state._localStacks[series.slug] || [];
    return stack.length === 2 && stack.every(image => image.naturalWidth === 2 && image.naturalHeight === 2);
  })).toBe(true);
  await secondTimepoint.hover();
  await expect(page.locator('#series-thumb-tip')).toHaveClass(/visible/);
  await expect(page.locator('#series-thumb-tip .thumb-label')).toHaveText('Slice 2 / 2');
  await expect.poll(() => page.locator('#series-thumb-tip img').evaluate(image => image.naturalWidth)).toBe(2);
  expect(localThumbnailRequests).toEqual([]);
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
