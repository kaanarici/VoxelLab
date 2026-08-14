/* global document */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import { writeCalibratedChannelTimeOmeTiff } from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  dropFiles,
  openUploadModal,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function ensurePanelOpen(page, panelSelector) {
  const panel = page.locator(panelSelector);
  await expect(panel).toBeVisible();
  if (await panel.evaluate((el) => el.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await expect(panel).not.toHaveClass(/collapsed/);
}

function storedZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    expect(method).toBe(0);
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function zipJson(entries, name) {
  return JSON.parse(new TextDecoder().decode(entries.get(name)));
}

test('first useful workflow exports calibrated microscopy particle evidence', async ({ page }, testInfo) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const omeTiffPath = testInfo.outputPath('cells-channel-time.ome.tiff');
  await mkdir(dirname(omeTiffPath), { recursive: true });
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  // Wait for the uploaded microscopy series to become active (the auto-loaded default study
  // would otherwise satisfy waitForCanvasPaint before the upload switches series).
  await expect(page.locator('#series-name')).toHaveText('cells-channel-time');
  await waitForCanvasPaint(page, '#view');

  await ensurePanelOpen(page, '#microscopy-stack-panel');
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');

  // The Analyze panel appears for microscopy series with retained raw planes.
  await ensurePanelOpen(page, '#microscopy-analysis-panel');
  await expect(page.locator('#analyze-run')).toBeEnabled();

  // Deterministic: a manual threshold of 0 (dark background) selects every pixel, so the
  // whole image is one connected component → exactly one particle row.
  await page.locator('#analyze-threshold-method').selectOption('manual');
  await page.locator('#analyze-threshold-value').fill('0');
  await page.locator('#analyze-run').click();

  await expect(page.locator('#analyze-status')).toContainText('particle');

  await ensurePanelOpen(page, '#roi-results-panel');
  await expect(page.locator('#roi-results-count')).toHaveText('1');

  // The particle row is a raw-domain polygon (Fiji "Mean gray value" parity).
  const row = await page.locator('#roi-results .roi-result-foot').first().textContent();
  expect(row).toContain('Raw intensity');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const evidencePath = testInfo.outputPath('particle-evidence.json');
  await jsonDownload.saveAs(evidencePath);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

  expect(jsonDownload.suggestedFilename()).toMatch(/^voxellab-roi-results-micro_.*\.json$/);
  expect(evidence).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    series: { name: 'cells-channel-time', width: 16, height: 16, slices: 1 },
    source: {
      imageDomain: 'microscopy',
      format: 'OME-TIFF',
      sourceFiles: ['cells-channel-time.ome.tiff'],
      warnings: [],
    },
    calibration: {
      xyKnown: true,
      rowMm: 0.00025,
      colMm: 0.0005,
      zKnown: true,
      zMm: 0.0015,
      displayUnit: 'µm',
      source: 'metadata',
      trust: 'Trusted metadata',
    },
    rows: [{
      kind: 'polygon',
      label: 'Particle 1',
      channel: 'DAPI',
      channelIndex: 0,
      time: 1,
      timeIndex: 0,
      valueUnit: 'raw',
      valueSource: 'raw_16bit',
    }],
  });
  expect(evidence.series.slug).toMatch(/^micro_/);
  expect(evidence.rows).toHaveLength(1);
  expect(evidence.rows[0].roiObjectId).toMatch(/^particles:/);
  expect(Number(evidence.rows[0].rawIntDen)).toBeGreaterThan(0);
  expect(Number(evidence.rows[0].areaMm2)).toBeGreaterThan(0);
  expect(evidence.source.dataset.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 2, '', 0, false],
    ['t', 'time', 2, 'index', 1, false],
  ]);
  expect(JSON.stringify(evidence)).not.toContain('modalAuthToken');

  await expect(page.locator('#roi-results-evidence-export')).toBeEnabled();
  const packageDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-evidence-export').click();
  const packageDownload = await packageDownloadPromise;
  expect(packageDownload.suggestedFilename()).toMatch(/^voxellab-microscopy-evidence-micro_.*\.zip$/);
  const packagePath = testInfo.outputPath('microscopy-evidence.zip');
  await packageDownload.saveAs(packagePath);
  const entries = storedZipEntries(await readFile(packagePath));
  expect([...entries.keys()]).toEqual([
    'manifest.json',
    'roi-results.json',
    'roi-results.csv',
    expect.stringMatching(/^annotated-snapshot-micro_.*\.png$/),
    'analysis-descriptor.json',
    'LIMITATIONS.txt',
  ]);
  expect([...entries.keys()].some(name => /\.(ome\.)?tiff?$/i.test(name))).toBe(false);
  const snapshotEntry = [...entries.keys()].find(name => name.startsWith('annotated-snapshot-'));
  expect([...entries.get(snapshotEntry).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  const packageManifest = zipJson(entries, 'manifest.json');
  expect(packageManifest).toMatchObject({
    schema: 'voxellab.microscopyEvidencePackage.v1',
    packageKind: 'microscopy-evidence-package',
    series: { name: 'cells-channel-time', imageDomain: 'microscopy', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy', format: 'OME-TIFF', sourceFiles: ['cells-channel-time.ome.tiff'], warnings: [] },
    calibration: {
      xyKnown: true,
      rowMm: 0.00025,
      colMm: 0.0005,
      zKnown: true,
      zMm: 0.0015,
      displayUnit: 'µm',
      source: 'metadata',
      trust: 'Trusted metadata',
    },
    evidence: {
      roiRowCount: 1,
      analysisOperationCount: 1,
      sourceImageDataIncluded: false,
    },
  });
  expect(packageManifest.evidence.intensityDomains).toEqual([{
    valueSource: 'raw_16bit',
    valueUnit: 'raw',
    rows: 1,
    meaning: 'raw retained microscopy plane intensity',
  }]);
  expect(packageManifest.limitations.join('\n')).toContain('not clinical');
  expect(packageManifest.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 2, '', 0, false],
    ['t', 'time', 2, 'index', 1, false],
  ]);

  const packageRoiJson = zipJson(entries, 'roi-results.json');
  expect(packageRoiJson.rows[0]).toMatchObject({
    roiObjectId: evidence.rows[0].roiObjectId,
    valueUnit: 'raw',
    valueSource: 'raw_16bit',
  });
  const descriptor = zipJson(entries, 'analysis-descriptor.json');
  expect(descriptor).toMatchObject({
    schema: 'voxellab.microscopyAnalysisDescriptor.v1',
    operationCount: 1,
    measurementDomains: ['raw_16bit'],
  });
  expect(descriptor.operations[0].params.threshold).toMatchObject({
    method: 'manual',
    resolvedValue: 0,
    darkBackground: true,
  });
  expect(new TextDecoder().decode(entries.get('roi-results.csv'))).toContain('raw_16bit');
  expect(new TextDecoder().decode(entries.get('LIMITATIONS.txt'))).toContain('source image pixels');
});
