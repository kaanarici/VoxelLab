/* global Buffer, URL, window */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import dcmjs from 'dcmjs';
import { openUploadModal as openUploadModalBase, routeConfig } from './microscopy-upload-helpers.mjs';

async function openUploadModal(page) {
  await openUploadModalBase(page);
  await page.locator('#upload-advanced-options > summary').click();
}

async function writeTinyDicom(path, { modality = 'CT', seriesUID, instanceNumber = 1 } = {}) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const uidRoot = `1.2.826.0.1.3680043.10.543.${modality === 'XA' ? '77' : modality === 'US' ? '99' : '88'}`;
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      MediaStorageSOPInstanceUID: `${uidRoot}.${instanceNumber}`,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    SOPInstanceUID: `${uidRoot}.${instanceNumber}`,
    StudyInstanceUID: `${uidRoot}.10`,
    SeriesInstanceUID: seriesUID || `${uidRoot}.20`,
    FrameOfReferenceUID: `${uidRoot}.30`,
    Modality: modality,
    SeriesDescription: modality === 'XA' ? 'Projection source' : modality === 'US' ? 'Ultrasound source' : 'Local DICOM CT',
    Rows: 2,
    Columns: 2,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    PixelSpacing: [0.5, 0.5],
    SliceThickness: 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, 0],
    InstanceNumber: instanceNumber,
    PixelData: new Uint16Array([1, 2, 3, 4]).buffer,
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dict.write()));
}

function projectionSourceManifest(seriesUID) {
  return {
    sourceRecordVersion: 2,
    sourceKind: 'projection',
    seriesUID,
    projection: {
      geometryModel: 'parallel-beam-stack',
      anglesDeg: [0],
      outputShape: [4, 4, 2],
      outputSpacingMm: [1, 1, 1],
      firstIPP: [0, 0, 0],
      orientation: [1, 0, 0, 0, 1, 0],
      frameOfReferenceUID: '1.2.826.0.1.3680043.10.543.77.30',
    },
  };
}

function ultrasoundSourceManifest(seriesUID, ultrasound = {}) {
  return {
    sourceRecordVersion: 2,
    sourceKind: 'ultrasound',
    seriesUID,
    ultrasound: {
      mode: 'stacked-sector',
      probeGeometry: 'sector',
      thetaRangeDeg: [-30, 30],
      radiusRangeMm: [0, 50],
      outputShape: [4, 4, 2],
      outputSpacingMm: [1, 1, 1],
      firstIPP: [0, 0, 0],
      orientation: [1, 0, 0, 0, 1, 0],
      frameOfReferenceUID: '1.2.826.0.1.3680043.10.543.99.30',
      ...ultrasound,
    },
  };
}

function registrationSourceManifest(fixedSeriesUID, movingSeriesUID) {
  return {
    sourceRecordVersion: 2,
    sourceKind: 'registration',
    registration: {
      fixedSeriesUID,
      movingSeriesUID,
      transform: 'rigid',
    },
  };
}

async function acceleratePolling(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 10), ...args);
  });
}

async function routeMockCloudAction(page, completePayload) {
  const startBodies = [];
  const uploadContentTypes = [];
  let releaseCloudComplete = () => {};
  const cloudCompleteReady = new Promise(resolve => { releaseCloudComplete = resolve; });
  let statusChecks = 0;
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        urls: Object.fromEntries((body.items || []).map((item) => [item.upload_id, `https://upload.example/${item.filename}`])),
      }),
    });
  });
  await page.route('**/api/cloud/start_processing', async (route) => {
    startBodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    statusChecks += 1;
    if (statusChecks === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running' }) });
      return;
    }
    await cloudCompleteReady;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(completePayload) });
  });
  await page.route('https://upload.example/**', async (route) => {
    const url = new URL(route.request().url());
    uploadContentTypes.push([url.pathname.split('/').pop(), route.request().headers()['content-type']]);
    await route.fulfill({ status: 200, body: '' });
  });
  return { releaseCloudComplete, startBodies, uploadContentTypes };
}

test('upload modal can start calibrated projection reconstruction as a cloud action', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('projection-1.dcm');
  const sourcePath = testInfo.outputPath('voxellab.source.json');
  const seriesUID = '1.2.826.0.1.3680043.10.543.77.20';
  await writeTinyDicom(dicomPath, { modality: 'XA', seriesUID });
  await writeFile(sourcePath, JSON.stringify(projectionSourceManifest(seriesUID)));

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloud = await routeMockCloudAction(page, {
    status: 'complete',
    slug: 'cloud_projection_job123',
    projection_set_entry: {
      id: 'projection_set_1',
      name: 'Projection Source',
      modality: 'XA',
      projectionKind: 'parallel-beam',
      projectionCount: 1,
      reconstructionStatus: 'reconstructed',
    },
    series_entry: {
      slug: 'cloud_projection_job123',
      name: 'Cloud Projection Result',
      description: 'Derived projection volume',
      slices: 2,
      width: 4,
      height: 4,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
      hasRaw: true,
      geometryKind: 'derivedVolume',
      sourceProjectionSetId: 'projection_set_1',
      sliceUrlBase: 'https://r2.example/data/cloud_projection_job123',
      rawUrl: 'https://r2.example/cloud_projection_job123.raw.zst',
      engineReport: {
        backend: 'parallel-fbp',
        geometryModel: 'parallel-beam-stack',
        validation: 'prototype',
        normalization: {
          previewPng: {
            method: 'fixed-ct-window',
            inputUnit: 'HU',
            window: [-160, 240],
            output: 'uint8 grayscale PNG slices',
            knownLosses: ['clipped outside display window', 'rescaled to 8-bit preview'],
          },
          rawVolume: {
            method: 'fixed-ct-window',
            inputUnit: 'HU',
            window: [-1024, 2048],
            output: 'uint16 raw volume zstd',
            knownLosses: ['clipped outside raw window', 'rescaled to unsigned 16-bit'],
          },
        },
      },
    },
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([dicomPath, sourcePath]);
  await expect(page.locator('#upload-cloud-btn')).toHaveText('Reconstruct projection set on cloud GPU');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('projection reconstruction');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('voxellab.source.json');
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Running cloud projection reconstruction on GPU');
  cloud.releaseCloudComplete();

  await expect(page.locator('#series-name')).toHaveText('Cloud Projection Result');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud action' })).toContainText('Cloud reconstruction');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud engine' })).toContainText('backend parallel-fbp');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud engine' })).toContainText('geometry parallel-beam-stack');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud source' })).toContainText('projection set projection_set_1');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud normalization' })).toContainText('fixed CT window');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud normalization' })).toContainText('clipped outside display window');
  const provenanceDownloadPromise = page.waitForEvent('download');
  await page.locator('#cloud-provenance-export-json').click();
  const provenanceDownload = await provenanceDownloadPromise;
  const provenance = JSON.parse(await readFile(await provenanceDownload.path(), 'utf8'));
  expect(provenance.series.sourceProjectionSetId).toBe('projection_set_1');
  expect(provenance.sourceProjectionSet).toMatchObject({
    id: 'projection_set_1',
    projectionKind: 'parallel-beam',
    projectionCount: 1,
    reconstructionStatus: 'reconstructed',
  });
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  expect(cloud.startBodies[0]?.processing_mode).toBe('projection_set_reconstruction');
  expect(cloud.startBodies[0]?.input_kind).toBe('calibrated_projection_set');
  expect(cloud.uploadContentTypes).toEqual(expect.arrayContaining([
    ['projection-1.dcm', 'application/dicom'],
    ['voxellab.source.json', 'application/json'],
  ]));
});

test('upload modal blocks projection reconstruction before upload for non-projection DICOM', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('ct-with-projection-manifest.dcm');
  const sourcePath = testInfo.outputPath('voxellab.source.json');
  const seriesUID = '1.2.826.0.1.3680043.10.543.88.20';
  await writeTinyDicom(dicomPath, { modality: 'CT', seriesUID });
  await writeFile(sourcePath, JSON.stringify(projectionSourceManifest(seriesUID)));

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloudCalls = [];
  await page.route('**/api/cloud/**', async (route) => {
    cloudCalls.push(route.request().url());
    await route.fulfill({ status: 500, body: 'unexpected cloud call' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles([dicomPath, sourcePath]);

  await expect(page.locator('#upload-cloud-btn')).toHaveText('Reconstruct projection set on cloud GPU');
  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('projection X-ray DICOM');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('CT');
  expect(cloudCalls).toEqual([]);
});

test('upload modal can start rigid registration as a cloud action', async ({ page }, testInfo) => {
  const fixedUID = '1.2.826.0.1.3680043.10.543.88.20.1';
  const movingUID = '1.2.826.0.1.3680043.10.543.88.20.2';
  const fixedOne = testInfo.outputPath('fixed-1.dcm');
  const fixedTwo = testInfo.outputPath('fixed-2.dcm');
  const movingOne = testInfo.outputPath('moving-1.dcm');
  const movingTwo = testInfo.outputPath('moving-2.dcm');
  const sourcePath = testInfo.outputPath('voxellab.source.json');
  await writeTinyDicom(fixedOne, { modality: 'MR', seriesUID: fixedUID, instanceNumber: 1 });
  await writeTinyDicom(fixedTwo, { modality: 'MR', seriesUID: fixedUID, instanceNumber: 2 });
  await writeTinyDicom(movingOne, { modality: 'MR', seriesUID: movingUID, instanceNumber: 3 });
  await writeTinyDicom(movingTwo, { modality: 'MR', seriesUID: movingUID, instanceNumber: 4 });
  await writeFile(sourcePath, JSON.stringify(registrationSourceManifest(fixedUID, movingUID)));

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloud = await routeMockCloudAction(page, {
    status: 'complete',
    slug: 'cloud_reg_job123',
    series_entry: {
      slug: 'cloud_reg_job123',
      name: 'Registered Moving',
      description: 'Derived registration volume',
      modality: 'MR',
      slices: 2,
      width: 4,
      height: 4,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
      hasRaw: true,
      geometryKind: 'derivedVolume',
      sliceUrlBase: 'https://r2.example/data/cloud_reg_job123',
      rawUrl: 'https://r2.example/cloud_reg_job123.raw.zst',
      registration: {
        source: 'modal:rigid_registration',
        referenceSlug: fixedUID,
        movingSlug: movingUID,
        method: "ANTsPy ants.registration type_of_transform='Rigid'",
        transform: {
          type: 'rigid',
          translationMm: [0.2, 0.1, 1.5],
          translationMagnitudeMm: 1.52,
          rotationDeg: 0.3,
          rotationMagnitudeMm: 0.42,
        },
        metrics: { dice: 0.94, mseNormalized: 0.02, mutualInformation: 0.5, runtimeSeconds: 2.5 },
        verdict: 'aligned',
      },
    },
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  const uploadFiles = await Promise.all([
    [fixedOne, 'fixed-1.dcm', 'application/dicom'],
    [fixedTwo, 'fixed-2.dcm', 'application/dicom'],
    [movingOne, 'moving-1.dcm', 'application/dicom'],
    [movingTwo, 'moving-2.dcm', 'application/dicom'],
    [sourcePath, 'voxellab.source.json', 'application/json'],
  ].map(async ([path, name, mimeType]) => ({
    name,
    mimeType,
    buffer: await readFile(path),
  })));
  await page.locator('#upload-file-input').setInputFiles(uploadFiles);
  await expect(page.locator('#upload-cloud-btn')).toHaveText('Register DICOM pair on cloud GPU');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('registration alignment');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('voxellab.source.json');
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Running cloud registration alignment on GPU');
  cloud.releaseCloudComplete();

  await expect(page.locator('#series-name')).toHaveText('Registered Moving');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud action' })).toContainText('Cloud registration/alignment');
  const registrationRow = page.locator('#meta .meta-row').filter({
    has: page.locator('.mk', { hasText: /^Registration$/ }),
  });
  await expect(registrationRow).toContainText('modal:rigid_registration');
  await expect(registrationRow).toContainText('aligned');
  await expect(page.locator('#registration-evidence-export-json')).toBeVisible();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  expect(cloud.startBodies[0]?.processing_mode).toBe('rigid_registration');
  expect(cloud.startBodies[0]?.input_kind).toBe('dicom_registration_pair');
  expect(cloud.uploadContentTypes).toEqual(expect.arrayContaining([
    ['fixed-1.dcm', 'application/dicom'],
    ['moving-1.dcm', 'application/dicom'],
    ['voxellab.source.json', 'application/json'],
  ]));
});

test('upload modal can start calibrated ultrasound scan conversion as a cloud action', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('ultrasound-1.dcm');
  const sourcePath = testInfo.outputPath('voxellab.source.json');
  const seriesUID = '1.2.826.0.1.3680043.10.543.99.20';
  await writeTinyDicom(dicomPath, { modality: 'US', seriesUID });
  await writeFile(sourcePath, JSON.stringify(ultrasoundSourceManifest(seriesUID)));

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloud = await routeMockCloudAction(page, {
    status: 'complete',
    slug: 'cloud_us_job123',
    series_entry: {
      slug: 'cloud_us_job123',
      name: 'Cloud Ultrasound Result',
      description: 'Derived ultrasound volume',
      modality: 'US',
      slices: 2,
      width: 4,
      height: 4,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
      hasRaw: true,
      geometryKind: 'derivedVolume',
      ultrasoundCalibration: {
        status: 'calibrated',
        mode: 'stacked-sector',
        probeGeometry: 'sector',
        source: 'external-json',
      },
      sliceUrlBase: 'https://r2.example/data/cloud_us_job123',
      rawUrl: 'https://r2.example/cloud_us_job123.raw.zst',
      engineReport: {
        backend: 'sector-scan-conversion',
        profileId: 'fixture-ultrasound-profile',
        mode: 'stacked-sector',
        probeGeometry: 'sector',
        validation: 'prototype',
        normalization: {
          previewPng: {
            method: 'nonzero-voxel-percentile-window',
            inputUnit: 'source intensity',
            window: [2, 98],
            percentiles: [1, 99],
            output: 'uint8 grayscale PNG slices',
            knownLosses: ['clipped outside percentile window', 'rescaled to 8-bit preview'],
          },
          rawVolume: {
            method: 'nonzero-voxel-percentile-window',
            inputUnit: 'source intensity',
            window: [1, 100],
            percentiles: [0.1, 99.9],
            output: 'uint16 raw volume zstd',
            knownLosses: ['clipped outside percentile window', 'rescaled to unsigned 16-bit'],
          },
        },
      },
    },
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([dicomPath, sourcePath]);
  await expect(page.locator('#upload-cloud-btn')).toHaveText('Scan-convert ultrasound on cloud GPU');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('ultrasound scan conversion');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('voxellab.source.json');
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Running cloud ultrasound scan conversion on GPU');
  cloud.releaseCloudComplete();

  await expect(page.locator('#series-name')).toHaveText('Cloud Ultrasound Result');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud action' })).toContainText('Cloud ultrasound scan conversion');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud engine' })).toContainText('sector-scan-conversion');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud engine' })).toContainText('probe sector');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud source' })).toContainText('calibrated ultrasound source');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud source' })).toContainText('source external-json');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud normalization' })).toContainText('nonzero percentile window');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud normalization' })).toContainText('source intensity');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  expect(cloud.startBodies[0]?.processing_mode).toBe('ultrasound_scan_conversion');
  expect(cloud.startBodies[0]?.input_kind).toBe('calibrated_ultrasound_source');
  expect(cloud.uploadContentTypes).toEqual(expect.arrayContaining([
    ['ultrasound-1.dcm', 'application/dicom'],
    ['voxellab.source.json', 'application/json'],
  ]));
});

test('upload modal blocks ultrasound scan conversion before upload for malformed calibration manifest', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('ultrasound-bad-manifest.dcm');
  const sourcePath = testInfo.outputPath('voxellab.source.json');
  const seriesUID = '1.2.826.0.1.3680043.10.543.99.20';
  await writeTinyDicom(dicomPath, { modality: 'US', seriesUID });
  const manifest = ultrasoundSourceManifest(seriesUID);
  delete manifest.ultrasound.thetaRangeDeg;
  await writeFile(sourcePath, JSON.stringify(manifest));

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const cloudCalls = [];
  await page.route('**/api/cloud/**', async (route) => {
    cloudCalls.push(route.request().url());
    await route.fulfill({ status: 500, body: 'unexpected cloud call' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles([dicomPath, sourcePath]);

  await expect(page.locator('#upload-cloud-btn')).toHaveText('Scan-convert ultrasound on cloud GPU');
  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('thetaRangeDeg');
  expect(cloudCalls).toEqual([]);
});
