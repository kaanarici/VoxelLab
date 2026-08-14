/* global document */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  writeCalibratedOmeTiff,
  writeCalibratedTimeSeriesOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { createDeflateTiff } from '../fixtures/microscopy/deflate-tiff.mjs';
import { createLzwReferenceTiff } from '../fixtures/microscopy/lzw-tiff.mjs';
import { dropFiles, openUploadModal, routeConfig } from './microscopy-upload-helpers.mjs';

async function writePlaceholderFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'not a proprietary microscopy container\n');
}

function microscopyMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from([
      `--${boundary}`,
      `Content-Type: ${part.contentType || 'image/tiff'}`,
      `Content-Disposition: attachment; filename="${part.fileName}"`,
      `X-VoxelLab-Convert-Part: ${part.partId}`,
      `X-VoxelLab-Convert-Warnings: ${JSON.stringify(part.warnings || [])}`,
      '',
      '',
    ].join('\r\n')));
    chunks.push(part.body);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function openUploadModalWithoutLocalBackend(page) {
  await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.waitForFunction(
    () => document.documentElement.dataset.voxellabControlsReady === 'true',
    null,
    { timeout: 10_000 },
  );
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
}

test('vendor microscopy inputs are presented with local and Electron converter boundaries', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const row = page.locator('.format-capability-row', { hasText: 'CZI / ND2 / LIF / OIB / OIF / LSM bridge' });
  await expect(row.locator('.format-capability-status')).toHaveText('Converted');
  await expect(row).toContainText('Local optional readers can split supported CZI scenes, ND2 positions, and LIF images/positions');
  await expect(row).toContainText('separate bounded OME-TIFF imports');
  await expect(row).toContainText('A configured external converter can return one OME-TIFF for CZI/ND2/LIF/OIB/OIF/LSM');
  await expect(row).toContainText('including Electron');
  await expect(row).toContainText('not native browser import');
  await expect(row).toContainText('first-party Bio-Formats parity');

  // A malformed vendor file must fail closed: the backend conversion rejects it (or reports
  // the readers/backend are unavailable), the modal stays open, and no series is added.
  const initialSeriesCount = await page.locator('#series-list li').count();
  const path = testInfo.outputPath('sample.czi');
  await writePlaceholderFile(path);
  await dropFiles(page, '#upload-zone', [{ path }]);

  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 converter-backed file');
  await expect(page.locator('#notify-container .notify-text')).toContainText('converter-backed files need configured local readers or an OME-TIFF converter: sample.czi.');
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveClass(/error/);
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});

test('native vendor split failures require the optional reader without external fallback', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await page.route('**/api/microscopy/convert?name=missing-reader.czi&mode=split', async (route) => {
    await route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'token=server-secret /private/converter/output',
        reason: 'optional_python_reader_missing',
      }),
    });
  });
  await openUploadModal(page);

  const path = testInfo.outputPath('missing-reader.czi');
  await writePlaceholderFile(path);
  await dropFiles(page, '#upload-zone', [{ path }]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText('Could not convert missing-reader.czi: install the optional microscopy readers; native split-mode does not fall back to an external converter.');
  await expect(status).not.toContainText('server-secret');
  await expect(status).not.toContainText('/private/converter/output');
});

test('classic stripped Deflate TIFF imports through the upload flow', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const path = testInfo.outputPath('deflate-stack.tif');
  const buffer = createDeflateTiff({
    width: 3,
    height: 2,
    pixels: [10, 20, 35, 100, 105, 120],
    predictor: 2,
    rowsPerStrip: 1,
    description: 'ImageJ=1.53\nimages=1\nunit=um',
    xResolution: 4,
    yResolution: 2,
  });
  await writeFile(path, new Uint8Array(buffer));
  await dropFiles(page, '#upload-zone', [{ path, mimeType: 'image/tiff' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li.active')).toContainText('deflate-stack');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Format' })).toContainText('ImageJ-TIFF');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('ImageJ TIFF metadata');
});

test('classic stripped LZW TIFF imports through the upload flow', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const path = testInfo.outputPath('lzw-stack.tif');
  await writeFile(path, new Uint8Array(createLzwReferenceTiff()));
  await dropFiles(page, '#upload-zone', [{ path, mimeType: 'image/tiff' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li.active')).toContainText('lzw-stack');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Format' })).toContainText('TIFF');
});

test('local gzip Zarr v2 import exposes codec storage provenance', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const root = testInfo.outputPath('cells.zarr');
  const attrsPath = `${root}/.zattrs`;
  const arrayPath = `${root}/0/.zarray`;
  const chunkPath = `${root}/0/0.0`;
  await mkdir(dirname(arrayPath), { recursive: true });
  await writeFile(attrsPath, JSON.stringify({
    ome: {
      version: '0.4',
      multiscales: [{
        name: 'cells',
        axes: [
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [0.5, 0.5] }] }],
      }],
    },
  }));
  await writeFile(arrayPath, JSON.stringify({
    zarr_format: 2,
    shape: [2, 2],
    chunks: [2, 2],
    dtype: '|u1',
    compressor: { id: 'gzip' },
    filters: null,
    order: 'C',
    fill_value: 0,
  }));
  await writeFile(chunkPath, gzipSync(Uint8Array.from([0, 64, 128, 255])));

  await dropFiles(page, '#upload-zone', [
    { path: attrsPath, relativePath: 'cells.zarr/.zattrs' },
    { path: arrayPath, relativePath: 'cells.zarr/0/.zarray' },
    { path: chunkPath, relativePath: 'cells.zarr/0/0.0' },
  ]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li.active')).toContainText('cells');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Storage' })).toContainText('Local Zarr v2 · level 1/1 · full resolution · gzip');
});

test('local vendor microscopy sidecars do not mask the converter boundary message', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const cziPath = testInfo.outputPath('sample-with-sidecar.czi');
  const recipePath = testInfo.outputPath('sample-with-sidecar-recipe.json');
  await writePlaceholderFile(cziPath);
  await writeFile(recipePath, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));

  await dropFiles(page, '#upload-zone', [
    { path: cziPath },
    { path: recipePath, mimeType: 'application/json' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText('Could not convert sample-with-sidecar.czi');
  await expect(status).not.toContainText('Import CZI/ND2/LIF files on their own');
});

test('multi-scene CZI conversion imports every scene as an independent series', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  const cziPath = testInfo.outputPath('multi-scene.czi');
  const firstTiffPath = testInfo.outputPath('multi-scene-1.ome.tiff');
  const secondTiffPath = testInfo.outputPath('multi-scene-2.ome.tiff');
  await writePlaceholderFile(cziPath);
  await writeCalibratedOmeTiff(firstTiffPath);
  await writeCalibratedOmeTiff(secondTiffPath);
  const boundary = 'voxellab-test-scenes';
  const body = microscopyMultipart(boundary, [
    {
      fileName: 'multi-scene--scene-001.ome.tiff',
      partId: 'czi-scene-0',
      warnings: ['Converted from CZI with the native reader · Scene 1 of 2 · Left well.'],
      body: await readFile(firstTiffPath),
    },
    {
      fileName: 'multi-scene--scene-002.ome.tiff',
      partId: 'czi-scene-1',
      warnings: ['Converted from CZI with the native reader · Scene 2 of 2 · Right well.'],
      body: await readFile(secondTiffPath),
    },
  ]);
  await page.route('**/api/microscopy/convert?name=multi-scene.czi&mode=split', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
        'X-VoxelLab-Convert-Parts': '2',
      },
      body,
    });
  });
  await openUploadModal(page);

  await dropFiles(page, '#upload-zone', [{ path: cziPath }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  const firstScene = page.locator('#series-list li', { hasText: 'multi-scene--scene-001' });
  const secondScene = page.locator('#series-list li', { hasText: 'multi-scene--scene-002' });
  await expect(firstScene).toHaveCount(1);
  await expect(secondScene).toHaveCount(1);
  await expect(firstScene).toHaveClass(/active/);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('Scene 1 of 2');
  await secondScene.click();
  await expect(secondScene).toHaveClass(/active/);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('Scene 2 of 2');
});

test('malformed later vendor multipart part leaves the manifest unchanged', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  const cziPath = testInfo.outputPath('malformed-multipart.czi');
  const validTiffPath = testInfo.outputPath('valid-first-part.ome.tiff');
  await writePlaceholderFile(cziPath);
  await writeCalibratedOmeTiff(validTiffPath);
  const boundary = 'voxellab-test-malformed-scenes';
  const body = microscopyMultipart(boundary, [
    {
      fileName: 'malformed-multipart--scene-001.ome.tiff',
      partId: 'czi-scene-0',
      body: await readFile(validTiffPath),
    },
    {
      contentType: 'text/plain',
      fileName: 'malformed-multipart--scene-002.ome.tiff',
      partId: 'czi-scene-1',
      body: Buffer.from('not an OME-TIFF'),
    },
  ]);
  await page.route('**/api/microscopy/convert?name=malformed-multipart.czi&mode=split', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
        'X-VoxelLab-Convert-Parts': '2',
      },
      body,
    });
  });
  await openUploadModal(page);
  const initialSeriesCount = await page.locator('#series-list li').count();

  await dropFiles(page, '#upload-zone', [{ path: cziPath }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveClass(/error/);
  await expect(page.locator('#upload-status')).toContainText('Converter multipart part is not an OME-TIFF.');
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
  await expect(page.locator('#series-list li', { hasText: 'malformed-multipart--scene-' })).toHaveCount(0);
});

test('vendor response acquisition caps absent and understated lengths while streaming', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });

  const messages = await page.evaluate(async () => {
    const { readBoundedVendorResponseBlob } = await import('/js/projects/vendor-microscopy-convert.js');
    const accepted = await readBoundedVendorResponseBlob(new Response(
      Uint8Array.from([1, 2, 3, 4, 5]),
      { headers: { 'Content-Length': '5' } },
    ), 5, 'stream limit reached');
    const rejectionMessage = async (headers) => {
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
          controller.enqueue(Uint8Array.from([4, 5, 6]));
          controller.close();
        },
      }), { headers });
      try {
        await readBoundedVendorResponseBlob(response, 5, 'stream limit reached');
        return '';
      } catch (error) {
        return error.message;
      }
    };
    return {
      atLimit: accepted.size,
      absent: await rejectionMessage({}),
      understated: await rejectionMessage({ 'Content-Length': '1' }),
    };
  });

  expect(messages).toEqual({
    atLimit: 5,
    absent: 'stream limit reached',
    understated: 'stream limit reached',
  });
});

test('vendor multipart parser keeps the 512 MiB contract and scans across window edges', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });

  const parsed = await page.evaluate(async () => {
    const {
      MAX_VENDOR_CONVERT_TOTAL_BYTES,
      parseVendorMultipartBlob,
    } = await import('/js/projects/vendor-microscopy-convert.js');
    const boundary = 'voxellab-window-edge';
    const encoder = new TextEncoder();
    const preamble = (name, partId) => encoder.encode([
      `--${boundary}`,
      'Content-Type: image/tiff',
      `Content-Disposition: attachment; filename="${name}"`,
      `X-VoxelLab-Convert-Part: ${partId}`,
      '',
      '',
    ].join('\r\n'));
    const firstBody = new Uint8Array((1024 * 1024) - 3);
    const secondBody = Uint8Array.from([73, 73, 42, 0]);
    const payload = new Blob([
      preamble('edge-1.ome.tiff', 'part-1'),
      firstBody,
      '\r\n',
      preamble('edge-2.ome.tiff', 'part-2'),
      secondBody,
      `\r\n--${boundary}--\r\n`,
    ]);
    let aggregateReads = 0;
    Object.defineProperty(payload, 'arrayBuffer', {
      value() {
        aggregateReads += 1;
        throw new Error('aggregate Blob must not be materialized');
      },
    });

    const files = await parseVendorMultipartBlob(
      payload,
      `multipart/mixed; boundary="${boundary}"`,
      2,
    );
    return {
      aggregateReads,
      limit: MAX_VENDOR_CONVERT_TOTAL_BYTES,
      names: files.map(file => file.name),
      sizes: files.map(file => file.size),
    };
  });

  expect(parsed).toEqual({
    aggregateReads: 0,
    limit: 512 * 1024 * 1024,
    names: ['edge-1.ome.tiff', 'edge-2.ome.tiff'],
    sizes: [(1024 * 1024) - 3, 4],
  });
});

test('OME-TIFF import rejects overlapping IFD mappings', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialSeriesCount = await page.locator('#series-list li').count();
  const path = testInfo.outputPath('overlapping-ifd.ome.tiff');
  await writeCalibratedTimeSeriesOmeTiff(path, {
    tiffData: '<TiffData/><TiffData IFD="1" FirstT="0"/>',
  });
  await dropFiles(page, '#upload-zone', [{ path }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveClass(/error/);
  await expect(page.locator('#upload-status')).toContainText('OME-TIFF metadata maps IFD 1 more than once');
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});

test('vendor microscopy files explain reader or converter setup when local backend is unavailable', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModalWithoutLocalBackend(page);

  const path = testInfo.outputPath('needs-backend.czi');
  await writePlaceholderFile(path);
  await dropFiles(page, '#upload-zone', [{ path }]);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText('Converter-backed CZI/ND2/LIF/OIB/OIF/LSM need the local VoxelLab backend');
  await expect(status).toContainText('optional microscopy readers or VOXELLAB_BFCONVERT');
  await expect(status).toContainText('OME-TIFF converter');
});

test('ImageJ ROI Manager ZIP boundary stays limited to sidecar archives', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const roiRow = page.locator('.format-capability-row', { hasText: 'ImageJ ROI .roi' });
  await expect(roiRow.locator('.format-capability-status')).toHaveText('Native');
  await expect(roiRow).toContainText('Limited ImageJ ROI Manager sidecar import');
  await expect(roiRow).toContainText('opened onto the active microscopy series');
  await expect(roiRow).toContainText('straight-line');
  await expect(roiRow).toContainText('angle');

  const zipRow = page.locator('.format-capability-row', { hasText: 'ImageJ ROI .zip' });
  await expect(zipRow.locator('.format-capability-status')).toHaveText('Native');
  await expect(zipRow).toContainText('stored/deflated supported ROI sidecars');
  await expect(zipRow).toContainText('opened onto the active microscopy series');
  await expect(zipRow).toContainText('VoxelLab can export uncompressed ZIP sidecars');
  await expect(zipRow).toContainText('straight-line measurements, and angle measurements');
  await expect(zipRow).toContainText('broader ROI Manager type parity are not supported');

  const initialSeriesCount = await page.locator('#series-list li').count();
  const path = testInfo.outputPath('cells-rois.zip');
  await writePlaceholderFile(path);

  await dropFiles(page, '#upload-zone', [{ path }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('Sidecar files are not standalone images');
  await expect(page.locator('#upload-status')).toContainText('Selected sidecar: cells-rois.zip.');
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});
