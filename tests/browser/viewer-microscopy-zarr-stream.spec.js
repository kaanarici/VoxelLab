import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { openUploadModal as openUploadModalBase, routeConfig, waitForCanvasPaint } from './microscopy-upload-helpers.mjs';

async function openUploadModal(page) {
  await openUploadModalBase(page);
  await page.locator('#upload-advanced-options > summary').click();
}

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/zarr/idr0062A-6001240-L0-c0z0.blosc', import.meta.url));

const ZARR_HOST = 'https://idr.example.test';
const ZARR_BASE = `${ZARR_HOST}/idr0062A/6001240.zarr`;
const PLANE_WIDTH = 271;
const PLANE_HEIGHT = 275;
const BLOSC = { id: 'blosc', cname: 'lz4', shuffle: 1, clevel: 5, blocksize: 0 };

const CZYX_AXES = [
  { name: 'c', type: 'channel' },
  { name: 'z', type: 'space', unit: 'micrometer' },
  { name: 'y', type: 'space', unit: 'micrometer' },
  { name: 'x', type: 'space', unit: 'micrometer' },
];

function arrayMeta({ width, height, 'shape': dimensions = [1, 1, height, width], compressor = BLOSC }) {
  return {
    zarr_format: 2,
    'shape': dimensions,
    chunks: [1, 1, height, width],
    dtype: '<u2',
    compressor,
    filters: null,
    order: 'C',
    dimension_separator: '/',
    fill_value: 0,
  };
}

function rootAttrs() {
  return {
    ome: {
      version: '0.4',
      multiscales: [{
        name: '6001240',
        axes: CZYX_AXES,
        datasets: [
          { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 0.5, 0.5] }] },
          { path: '1', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 1] }] },
          { path: '2', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 2, 2] }] },
        ],
      }],
      omero: {
        channels: [{ label: 'DAPI', color: '0000FF', family: 'linear', window: { min: 0, max: 4095, start: 6, end: 132 } }],
      },
    },
  };
}

function zarrRouteBody(relPath, { coarsestDimensions, coarsestCompressor = BLOSC, fixtureBytes }) {
  if (relPath === '.zattrs') return { json: rootAttrs() };
  if (relPath === '.zgroup') return { json: { zarr_format: 2 } };
  if (relPath === '0/.zarray') return { json: arrayMeta({ width: PLANE_WIDTH * 4, height: PLANE_HEIGHT * 4 }) };
  if (relPath === '1/.zarray') return { json: arrayMeta({ width: PLANE_WIDTH * 2, height: PLANE_HEIGHT * 2 }) };
  if (relPath === '2/.zarray') return { json: arrayMeta({ width: PLANE_WIDTH, height: PLANE_HEIGHT, 'shape': coarsestDimensions, compressor: coarsestCompressor }) };
  if (relPath === '2/0/0/0/0') return { bytes: fixtureBytes };
  return null;
}

async function mockZarrProxy(page, { coarsestDimensions, coarsestCompressor = BLOSC, requestedPaths = [] } = {}) {
  const fixtureBytes = await readFile(FIXTURE_PATH);

  await page.route(`${ZARR_HOST}/**`, async (route) => {
    const target = route.request().url();
    if (!target.startsWith(ZARR_BASE)) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    const relPath = target.slice(ZARR_BASE.length).replace(/^\/+/, '');
    requestedPaths.push(relPath);
    const body = zarrRouteBody(relPath, { coarsestDimensions, coarsestCompressor, fixtureBytes });
    if (!body) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    const cors = { 'access-control-allow-origin': '*' };
    if (body.bytes) {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors, body: body.bytes });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body.json) });
  });
}

test('streams a downsampled OME-Zarr pyramid level by URL with honest provenance', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    consoleErrors.push(msg.text());
  });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await mockZarrProxy(page);
  await openUploadModal(page);

  await page.locator('#ome-zarr-url').fill(ZARR_BASE);
  await page.locator('#upload-ome-zarr-btn').click();

  await expect(page.locator('#upload-modal')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#series-name')).toHaveText('6001240');
  await expect(page.locator('#series-desc')).toContainText('OME-Zarr');

  const streamingRow = page.locator('#meta .meta-row').filter({ hasText: 'Streaming' });
  await expect(streamingRow).toContainText('OME-Zarr v2 streamed · level 3/3 · ×4 downsample');
  await expect(streamingRow).toContainText('blosc(lz4, byte-shuffle)');

  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Pixel spacing' })).toContainText('2.00 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-Zarr metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Dimensions' })).toContainText(`${PLANE_WIDTH} × ${PLANE_HEIGHT}`);

  await waitForCanvasPaint(page, '#view');

  const successShot = testInfo.outputPath('ome-zarr-stream-success.png');
  await page.screenshot({ path: successShot, fullPage: false });
  await testInfo.attach('ome-zarr-stream-success', { path: successShot, contentType: 'image/png' });

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('fails closed with a named reason on an unsupported OME-Zarr codec', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await mockZarrProxy(page, { coarsestCompressor: { id: 'blosc', cname: 'snappy', shuffle: 1 } });
  await openUploadModal(page);

  await page.locator('#ome-zarr-url').fill(ZARR_BASE);
  await page.locator('#upload-ome-zarr-btn').click();

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/, { timeout: 15_000 });
  await expect(status).toContainText('OME-Zarr stream unavailable');
  await expect(status).toContainText("Blosc cname 'snappy'");
  await expect(page.locator('#upload-modal')).toBeVisible();

  const errorShot = testInfo.outputPath('ome-zarr-stream-fail-closed.png');
  await page.screenshot({ path: errorShot, fullPage: false });
  await testInfo.attach('ome-zarr-stream-fail-closed', { path: errorShot, contentType: 'image/png' });
});

test('fails closed before chunk fetches when streamed planes exceed the allocation budget', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  const requestedPaths = [];
  await mockZarrProxy(page, {
    coarsestDimensions: [1, 300, PLANE_HEIGHT, PLANE_WIDTH],
    requestedPaths,
  });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();

  await page.locator('#ome-zarr-url').fill(ZARR_BASE);
  await page.locator('#upload-ome-zarr-btn').click();

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/, { timeout: 15_000 });
  await expect(status).toContainText('OME-Zarr resource limit');
  await expect(status).toContainText('aggregate plane pixels');
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
  expect(requestedPaths).not.toContain('2/0/0/0/0');
});
