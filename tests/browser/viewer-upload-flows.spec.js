/* global Buffer, DataTransfer, File, URL, document, localStorage, window */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import dcmjs from 'dcmjs';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5WZ1AAAAAASUVORK5CYII=';

async function writeTinyNifti(path, { xyztUnits = 2, pixdim = [1, 1, 1] } = {}) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 70);
  buffer.writeFloatLE(pixdim[0], 76 + 4);
  buffer.writeFloatLE(pixdim[1], 76 + 8);
  buffer.writeFloatLE(pixdim[2], 76 + 12);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(xyztUnits, 123);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeTinyDicom(path, { instanceNumber = 1, z = 0, modality = 'CT', seriesUID = '1.2.826.0.1.3680043.10.543.20' } = {}) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      MediaStorageSOPInstanceUID: `1.2.826.0.1.3680043.10.543.${instanceNumber}`,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    SOPInstanceUID: `1.2.826.0.1.3680043.10.543.${instanceNumber}`,
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: seriesUID,
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: modality,
    SeriesDescription: 'Local DICOM CT',
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
    ImagePositionPatient: [0, 0, z],
    InstanceNumber: instanceNumber,
    PixelData: new Uint16Array([1, 2, 3, 4]).buffer,
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dict.write()));
}

async function writeTinyDicomStack(testInfo, stem, options = {}) {
  const first = testInfo.outputPath(`${stem}-1.dcm`);
  const second = testInfo.outputPath(`${stem}-2.dcm`);
  await writeTinyDicom(first, { ...options, instanceNumber: 1, z: 0 });
  await writeTinyDicom(second, { ...options, instanceNumber: 2, z: 1 });
  return [first, second];
}

async function writeTinySr(path) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
      MediaStorageSOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
    SOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: '1.2.826.0.1.3680043.10.543.88',
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: 'SR',
    SeriesDescription: 'Unsupported SR note',
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dict.write()));
}

function enhancedMetadataInstance() {
  return {
    '00080060': { vr: 'CS', Value: ['CT'] },
    '0020000E': { vr: 'UI', Value: ['1.2.series'] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: ['1.2.sop.1'] },
    '0008103E': { vr: 'LO', Value: ['DICOMweb CT'] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [16] },
    '00280101': { vr: 'US', Value: [16] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '52009229': {
      vr: 'SQ',
      Value: [{
        '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.5] }, '00180050': { vr: 'DS', Value: [1.0] } }] },
        '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] },
      }],
    },
    '52009230': {
      vr: 'SQ',
      Value: [
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] } },
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] } },
      ],
    },
  };
}

function segMetadataInstance() {
  const sharedGroups = [{
    '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.5] }, '00180050': { vr: 'DS', Value: [1.0] } }] },
    '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] },
  }];
  const perFrameGroups = [
    {
      '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] },
      SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
    },
    {
      '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] },
      SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
    },
  ];
  return {
    '00080060': { vr: 'CS', Value: ['SEG'] },
    '0020000E': { vr: 'UI', Value: ['1.2.seg'] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: ['1.2.seg.object'] },
    '0008103E': { vr: 'LO', Value: ['Mask'] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [1] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '52009229': { vr: 'SQ', Value: sharedGroups },
    '52009230': { vr: 'SQ', Value: perFrameGroups },
    '77770001': {
      vr: 'UN',
      Value: [{
        Modality: 'SEG',
        SeriesInstanceUID: '1.2.seg',
        SOPInstanceUID: '1.2.seg.object',
        SeriesDescription: 'Mask',
        Rows: 2,
        Columns: 2,
        BitsAllocated: 1,
        NumberOfFrames: 2,
        FrameOfReferenceUID: '1.2.for',
        ReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2.series' }],
        SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Mask' }],
        SharedFunctionalGroupsSequence: [{
          PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1 }],
          PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
        }],
        PerFrameFunctionalGroupsSequence: [
          {
            PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
            SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
          },
          {
            PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
            SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
          },
        ],
      }],
    },
  };
}

async function routeConfig(page, override = {}) {
  await page.route(/\/config(?:\.local)?\.json$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: {
          enabled: true,
          provider: 'claude',
          ready: true,
          issues: [],
        },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        ...override,
        features: {
          cloudProcessing: true,
          aiAnalysis: true,
          ...(override.features || {}),
        },
      }),
    });
  });
}

async function routeManifest(page, manifest) {
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
}

async function routeTinyPngStack(page, slug, slices = 1) {
  const body = Buffer.from(TINY_PNG_BASE64, 'base64');
  await page.route(`**/data/${slug}/*.png`, async (route) => {
    const file = route.request().url().split('/').pop() || '';
    const index = Number.parseInt(file.replace('.png', ''), 10);
    if (!Number.isFinite(index) || index < 0 || index >= slices) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body,
    });
  });
}

async function openUploadModal(page) {
  await routeManifest(page, { patient: 'anonymous', studyDate: '', series: [] });
  const waitForUploadReady = async (timeout = 10_000) => {
    await expect(page.locator('#btn-upload')).toBeVisible({ timeout });
    await page.waitForFunction(
      () => document.documentElement.dataset.voxellabControlsReady === 'true',
      null,
      { timeout },
    );
  };
  let lastError = null;
  const readinessTimeouts = [5_000, 7_000, 7_000];
  for (let attempt = 0; attempt < readinessTimeouts.length; attempt += 1) {
    const suffix = attempt === 0 ? '' : `?testReload=${Date.now()}-${attempt}`;
    await page.goto(`/${suffix}`, { waitUntil: 'domcontentloaded' });
    try {
      await waitForUploadReady(readinessTimeouts[attempt]);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-modal .ask-title')).toHaveText('Open a study');
}

async function expectUploadModalMatrixFits(page) {
  const metrics = await page.locator('#upload-modal .ask-card').evaluate((card) => {
    const body = card.querySelector('.ask-body-wrap');
    const cardRect = card.getBoundingClientRect();
    const checked = [...card.querySelectorAll('.format-capability-title, .format-capability-head, .format-capability-row')]
      .filter((node) => node.getClientRects().length > 0);
    return {
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
      overflowing: checked.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          className: node.className,
          left: rect.left,
          right: rect.right,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          outside: rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1,
        };
      }).filter(item => item.outside || item.scrollWidth > item.clientWidth + 1),
    };
  });
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  expect(metrics.overflowing, JSON.stringify(metrics)).toEqual([]);
}

test('command palette opens cloud GPU processing as a native action', async ({ page }) => {
  await routeManifest(page, { patient: 'anonymous', studyDate: '', series: [] });
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: true },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-cmdk-open')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.voxellabControlsReady === 'true',
    null,
    { timeout: 10_000 },
  );
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('cloud gpu processing');
  await page.getByRole('button', { name: /Cloud GPU processing/ }).click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is ready.');
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Needs source');
  await expect(page.locator('#upload-cloud-actions')).not.toContainText('Source ready');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Loaded study: no CT/MR source volume candidate.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Next: load one DICOM CT/MR volume stack before launching Process CT/MR on cloud GPU.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud reconstruction');
  await expect(page.locator('#upload-cloud-actions')).toContainText('single-frame projection DICOM files plus voxellab.source.json');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud registration/alignment');
  await expect(page.locator('#upload-cloud-actions')).toContainText('fixedSeriesUID and movingSeriesUID');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud ultrasound scan conversion');

  await page.keyboard.press('Escape');
  await expect(page.locator('#upload-modal')).toBeHidden();
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('ultrasound scan conversion');
  await page.getByRole('button', { name: /Cloud ultrasound scan conversion/ }).click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-context-hint')).toContainText('Cloud ultrasound scan conversion');
  await expect(page.locator('#upload-context-hint')).toContainText('Input: ultrasound DICOM files plus voxellab.source.json.');
  await expect(page.locator('#upload-context-hint')).toContainText('Upload study must select files and run preflight before any cloud job starts.');
});

test('upload modal lists imported cloud results and can reopen one', async ({ page }) => {
  const baseSeries = {
    description: 'fixture volume',
    modality: 'CT',
    slices: 1,
    width: 1,
    height: 1,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    renderability: 'volume',
  };
  await routeManifest(page, {
    patient: 'anonymous',
    studyDate: '',
    series: [
      { ...baseSeries, slug: 'local_ct', name: 'Local CT' },
      {
        ...baseSeries,
        slug: 'cloud_seg',
        name: 'Cloud Segmentation Result',
        hasSeg: true,
        hasStats: true,
        sourceJobId: 'job_history_123',
        cloudAction: {
          id: 'cloud-volume-segmentation',
          label: 'Cloud CT/MR segmentation',
          provider: 'modal',
          jobId: 'job_history_123',
          processingMode: 'standard',
          inputKind: 'dicom_volume_stack',
          resultSlug: 'cloud_seg',
        },
      },
    ],
  });
  await routeTinyPngStack(page, 'local_ct', 1);
  await routeTinyPngStack(page, 'cloud_seg', 1);
  await page.route('**/data/cloud_seg_stats.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ slug: 'cloud_seg' }),
    });
  });
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: true },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-name')).toHaveText('Local CT');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-cloud-history')).toContainText('Cloud results in this study');
  await expect(page.locator('#upload-cloud-history')).toContainText('Cloud Segmentation Result');
  await expect(page.locator('#upload-cloud-history')).toContainText('job job_history_123');
  await expect(page.locator('#upload-cloud-history')).toContainText('outputs tissue, stats');
  await expect(page.locator('#upload-cloud-history')).toContainText('provider modal · mode standard · input dicom_volume_stack');

  await page.locator('[data-cloud-result-slug="cloud_seg"]').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('Cloud Segmentation Result');
});

async function acceleratePolling(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 10), ...args);
  });
}

async function routeDerivedDcmjsStub(page) {
  await page.route('https://cdn.jsdelivr.net/npm/dcmjs@0.33.0/build/dcmjs.es.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        const data = {
          DicomMetaDictionary: {
            naturalizeDataset(instance) {
              const embedded = instance?.['77770001']?.Value?.[0];
              if (embedded && typeof embedded === 'object') return embedded;
              const modality = instance?.['00080060']?.Value?.[0] || '';
              if (modality === 'RTDOSE') {
                return {
                  Modality: 'RTDOSE',
                  SeriesInstanceUID: instance?.['0020000E']?.Value?.[0] || '',
                  SOPInstanceUID: instance?.['00080018']?.Value?.[0] || '',
                  SeriesDescription: instance?.['0008103E']?.Value?.[0] || '',
                  Rows: instance?.['00280010']?.Value?.[0] || 0,
                  Columns: instance?.['00280011']?.Value?.[0] || 0,
                  NumberOfFrames: instance?.['00280008']?.Value?.[0] || 1,
                  DoseGridScaling: instance?.['3004000E']?.Value?.[0] || 0,
                  DoseUnits: instance?.['30040002']?.Value?.[0] || '',
                  DoseType: instance?.['30040004']?.Value?.[0] || '',
                  DoseSummationType: instance?.['3004000A']?.Value?.[0] || '',
                  FrameOfReferenceUID: instance?.['00200052']?.Value?.[0] || '',
                  ReferencedSeriesSequence: [{
                    SeriesInstanceUID: instance?.['00081115']?.Value?.[0]?.['0020000E']?.Value?.[0] || '',
                  }],
                };
              }
              return {};
            },
          },
        };
        export { data };
        export default { data };
      `,
    });
  });
}

async function routeDcmjsModule(page) {
  const dcmjsModule = await readFile('node_modules/dcmjs/build/dcmjs.es.js', 'utf8');
  await page.route('https://cdn.jsdelivr.net/npm/dcmjs@0.33.0/build/dcmjs.es.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: dcmjsModule,
    });
  });
}

async function waitForCanvasPaint(page, selector) {
  await expect.poll(async () => {
    return await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { width: canvas.width, height: canvas.height, nonBlackPixels: 0, maxChannel: 0 };
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      let maxChannel = 0;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        maxChannel = Math.max(maxChannel, r, g, b);
        if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels += 1;
      }
      return { width: canvas.width, height: canvas.height, nonBlackPixels, maxChannel };
    });
  }, { timeout: 10_000 }).toMatchObject({ nonBlackPixels: expect.any(Number), maxChannel: expect.any(Number) });
  await expect.poll(async () => {
    return await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) nonBlackPixels += 1;
      }
      return nonBlackPixels;
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);
}

async function waitForThreeSurface(page) {
  // Shape: { active: true, mounted: true, width: 448, height: 630, clientWidth: 448, clientHeight: 630 }
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const container = document.getElementById('three-container');
      const canvas = container?.querySelector('canvas');
      return {
        active: container?.classList.contains('active') || false,
        mounted: Boolean(canvas),
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        clientWidth: canvas?.clientWidth || 0,
        clientHeight: canvas?.clientHeight || 0,
      };
    });
  }, { timeout: 10_000 }).toEqual({
    active: true,
    mounted: true,
    width: expect.any(Number),
    height: expect.any(Number),
    clientWidth: expect.any(Number),
    clientHeight: expect.any(Number),
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const canvas = document.querySelector('#three-container canvas');
      return {
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        clientWidth: canvas?.clientWidth || 0,
        clientHeight: canvas?.clientHeight || 0,
      };
    });
  }, { timeout: 10_000 }).toMatchObject({
    width: expect.any(Number),
    height: expect.any(Number),
    clientWidth: expect.any(Number),
    clientHeight: expect.any(Number),
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const canvas = document.querySelector('#three-container canvas');
      return Math.min(
        canvas?.width || 0,
        canvas?.height || 0,
        canvas?.clientWidth || 0,
        canvas?.clientHeight || 0,
      );
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);
}

async function expectThreeCanvasFitsContainer(page) {
  await expect.poll(async () => page.evaluate(() => {
    const container = document.getElementById('three-container');
    const canvas = container?.querySelector('canvas');
    const cr = container?.getBoundingClientRect();
    const vr = canvas?.getBoundingClientRect();
    if (!cr || !vr) return false;
    return Math.abs(cr.width - vr.width) <= 2 && Math.abs(cr.height - vr.height) <= 2;
  }), { timeout: 10_000 }).toBe(true);
}

async function dropFile(page, selector, path, mimeType = 'application/octet-stream') {
  const bytes = Array.from(await readFile(path));
  const name = path.split('/').pop();
  const dataTransfer = await page.evaluateHandle(({ fileBytes, fileName, fileType }) => {
    const dt = new DataTransfer();
    const file = new File([new Uint8Array(fileBytes)], fileName, { type: fileType });
    dt.items.add(file);
    return dt;
  }, { fileBytes: bytes, fileName: name, fileType: mimeType });
  await page.locator(selector).dispatchEvent('drop', { dataTransfer });
}

async function dropSyntheticFolderEntries(page) {
  await page.locator('#upload-zone').evaluate((target) => {
    const readableFile = new File([new Uint8Array([1, 2, 3, 4])], 'scan.dcm', { type: 'application/dicom' });
    const noteFile = new File(['not image data'], 'notes.md', { type: 'text/markdown' });
    const fileEntry = (name, file) => ({
      name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(file);
      },
    });
    const unreadableFileEntry = (name) => ({
      name,
      isFile: true,
      isDirectory: false,
      file(_resolve, reject) {
        reject(new Error('not readable'));
      },
    });
    const unreadableDirectoryEntry = (name) => ({
      name,
      isFile: false,
      isDirectory: true,
      createReader() {
        return {
          readEntries(_resolve, reject) {
            reject(new Error('not readable'));
          },
        };
      },
    });
    const root = {
      name: 'study',
      fullPath: '/study',
      isFile: false,
      isDirectory: true,
      createReader() {
        let done = false;
        return {
          readEntries(resolve) {
            if (done) {
              resolve([]);
              return;
            }
            done = true;
            resolve([
              fileEntry('scan.dcm', readableFile),
              unreadableFileEntry('missing.ome.tif'),
              unreadableDirectoryEntry('private'),
              fileEntry('notes.md', noteFile),
            ]);
          },
        };
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        items: [{ webkitGetAsEntry: () => root }],
        files: [],
      },
    });
    target.dispatchEvent(event);
  });
}

test('upload modal advertises supported local image formats in the picker', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const accept = await page.locator('#upload-file-input').getAttribute('accept');
  expect(accept || '').toContain('.dcm');
  expect(accept || '').toContain('.sr');
  expect(accept || '').toContain('.nii');
  expect(accept || '').toContain('.nii.gz');
  expect(accept || '').toContain('.tif');
  expect(accept || '').toContain('.ome.tiff');
  expect(accept || '').toContain('.czi');
  expect(accept || '').toContain('.nd2');
  expect(accept || '').toContain('.lif');
  expect(accept || '').toContain('.oib');
  expect(accept || '').toContain('.oif');
  expect(accept || '').toContain('.lsm');
  expect(accept || '').toContain('.roi');
  expect(accept || '').toContain('.zip');
  expect(accept || '').not.toContain('.csv');
  expect(accept || '').toContain('application/dicom');
  await expect(page.locator('#upload-folder-btn')).toBeVisible();
  await expect(page.locator('#upload-folder-input')).toHaveAttribute('webkitdirectory', '');
  await expect(page.locator('.upload-zone-title')).toHaveText('Drop a study folder, images, or sidecars here');
});

test('upload modal can browse a local folder into the same local import path', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('nifti-folder');
  const niftiPath = `${folderPath}/tiny-folder.nii`;
  await writeTinyNifti(niftiPath);
  await writeFile(`${folderPath}/.DS_Store`, 'junk');
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#series-name')).toHaveText('tiny-folder');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (NIfTI) selected after checking 4 files; skipped 3 unsupported files');
  await expect(page.locator('#notify-container .notify-text')).toContainText('checking 4 files');
  await expect(page.locator('#notify-container .notify-text')).toContainText('metadata.json (unrecognized JSON sidecar)');
  await expect(page.locator('#notify-container .notify-text')).toContainText('notes.md');
  await expect(page.locator('#notify-container .notify-text')).toContainText('results.csv');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await waitForCanvasPaint(page, '#view');
});

test('upload modal summarizes mixed folder triage before import action', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('mixed-folder');
  await writeTinyNifti(`${folderPath}/tiny-folder.nii`);
  await writeFile(`${folderPath}/cells.czi`, 'converter backed');
  await writeFile(`${folderPath}/workflow.json`, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/broken.json`, '{not json');
  await writeFile(`${folderPath}/notes.md`, 'not image data');

  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    features: { cloudProcessing: true },
  });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-active/);
  // Triage list rows replace the old run-on status sentence.
  await expect(status).toContainText('Opened (NIfTI)');
  await expect(status).toContainText('Converter-backed (CZI)');
  await expect(status).toContainText('Needs configured local readers or an OME-TIFF converter; open separately.');
  await expect(status).toContainText('Sidecars (Workflow recipe)');
  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('notes.md');
  await expect(status).toContainText('cells.czi');
  await expect(status).toContainText('metadata.json (unrecognized JSON sidecar)');
  await expect(status).toContainText('broken.json (invalid JSON sidecar)');
  // Checked-count and full sentence stay in the SR-accessible name and the toast.
  await expect(status).toHaveAttribute('aria-label', /after checking 6 files/);
  await expect(status).toHaveAttribute('aria-label', /1 openable file \(NIfTI\), 1 converter-backed file \(CZI\) and 1 sidecar \(Workflow recipe\) selected/);
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (NIfTI), 1 converter-backed file (CZI) and 1 sidecar (Workflow recipe) selected');
  await expect(page.locator('#notify-container .notify-text')).toContainText('cells.czi');
  await expect(page.locator('#notify-container .notify-text')).toContainText('checking 6 files');
  await expect(page.locator('#notify-container .notify-text')).toContainText('notes.md');
  await expect(page.locator('#notify-container .notify-text')).toContainText('metadata.json (unrecognized JSON sidecar)');
  await expect(page.locator('#notify-container .notify-text')).toContainText('broken.json (invalid JSON sidecar)');
});

test('upload modal separates browser drag folder read failures from unsupported skips', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    features: { cloudProcessing: true },
  });
  await openUploadModal(page);

  await dropSyntheticFolderEntries(page);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-active/);
  // Triage rows separate the skip, file-read failure, and folder-read failure.
  await expect(status).toContainText('Opened (DICOM)');
  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('study/notes.md');
  await expect(status).toContainText('File read failed');
  await expect(status).toContainText('study/missing.ome.tif (not found or unreadable)');
  await expect(status).toContainText('Folder read failed');
  await expect(status).toContainText('Could not read folder: private');
  await expect(status).toHaveAttribute('aria-label', /after checking 4 files/);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'openable file' })).toContainText('file read failed');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'openable file' })).toContainText('folder read failed');
});

test('local-only mixed folders open supported files and defer converter-backed files', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('mixed-local-folder');
  await writeTinyNifti(`${folderPath}/tiny-folder.nii`);
  await writeFile(`${folderPath}/cells-a.czi`, 'converter backed');
  await writeFile(`${folderPath}/cells-b.nd2`, 'converter backed');
  await writeFile(`${folderPath}/cells-c.lif`, 'converter backed');
  await writeFile(`${folderPath}/cells-d.oib`, 'converter backed');
  await writeFile(`${folderPath}/notes.md`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('tiny-folder');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Local intake:' }))
    .toContainText(/1 openable file \(NIfTI\) and 4 converter-backed files/);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Local intake:' }))
    .toContainText('plus 1 more file');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 4 converter-backed files' }))
    .toContainText('open them separately with configured local readers or an OME-TIFF converter after loading supported files');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 4 converter-backed files' }))
    .toContainText('plus 1 more file');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal names unsupported folder samples when nothing can open', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('unsupported-folder');
  await mkdir(folderPath, { recursive: true });
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');
  await writeFile(`${folderPath}/summary.txt`, 'not image data');
  await writeFile(`${folderPath}/readme.log`, 'not image data');
  await writeFile(`${folderPath}/table.tsv`, 'not image data');
  await writeFile(`${folderPath}/analysis.out`, 'not image data');
  await writeFile(`${folderPath}/figure.svg`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  // Nothing actionable: red Skipped row plus the restored supported-format guidance.
  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('unsupported-folder/');
  await expect(status).toContainText('+2 more files');
  await expect(status.locator('.upload-triage-advice')).toContainText('Try DICOM, NIfTI');
  // Full "no supported files... after checking 7 files" sentence stays SR-accessible.
  await expect(status).toHaveAttribute('aria-label', /No supported image, sidecar, or converter-backed files selected/);
  await expect(status).toHaveAttribute('aria-label', /after checking 7 files/);
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal explains standalone DICOM SR files before parsing', async ({ page }, testInfo) => {
  const srPath = testInfo.outputPath('sr-only/measurements.sr');
  await mkdir(dirname(srPath), { recursive: true });
  await writeFile(srPath, 'not a standalone image');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(srPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('DICOM SR files are derived objects, not standalone images.');
  await expect(status).toContainText('Open the matching source DICOM series first, then open the SR file again.');
  await expect(status).toContainText('Selected file: measurements.sr.');
  await expect(status).toContainText('checked 1 file');
  await expect(status).toContainText('selected 1 sidecar (DICOM SR)');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal explains standalone microscopy workflow recipes before image load', async ({ page }, testInfo) => {
  const recipePath = testInfo.outputPath('microscopy-sidecar-only/workflow.json');
  await mkdir(dirname(recipePath), { recursive: true });
  await writeFile(recipePath, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(recipePath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Sidecar files are not standalone images.');
  await expect(status).toContainText('Open the matching microscopy image first, then open the sidecar again.');
  await expect(status).toContainText('Selected sidecar: workflow.json.');
  await expect(status).toContainText('Selected file: workflow.json.');
  await expect(status).toContainText('checked 1 file');
  await expect(status).toContainText('selected 1 sidecar (Workflow recipe)');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal bounds standalone microscopy sidecar names before image load', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('microscopy-many-sidecars');
  await mkdir(folderPath, { recursive: true });
  const sidecarPaths = [
    `${folderPath}/workflow.json`,
    `${folderPath}/results.json`,
    `${folderPath}/cells.roi`,
    `${folderPath}/angles.roi`,
    `${folderPath}/points.roi`,
    `${folderPath}/extra.roi`,
  ];
  await writeFile(sidecarPaths[0], JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await writeFile(sidecarPaths[1], JSON.stringify({ schema: 'voxellab.roiResults.v1' }));
  for (const path of sidecarPaths.slice(2)) {
    await writeFile(path, 'not a standalone image');
  }

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(sidecarPaths);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Sidecar files are not standalone images.');
  await expect(status).toContainText('Open the matching microscopy image first, then open the sidecar again.');
  await expect(status).toContainText('Selected sidecars: results.json, workflow.json, cells.roi, angles.roi, points.roi, plus 1 more file.');
  await expect(status).toContainText('checked 6 files');
  await expect(status).toContainText('selected 6 sidecars');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal names supported-looking files that fail local parsing with folder triage context', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('broken-supported-folder');
  const dicomPath = `${folderPath}/broken-supported.dcm`;
  await mkdir(dirname(dicomPath), { recursive: true });
  await writeFile(dicomPath, 'not a valid dicom object');
  await writeFile(`${folderPath}/cells.czi`, 'converter backed');
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('broken-supported.dcm');
  await expect(status).toContainText('Failed 1 attempted file: broken-supported-folder/broken-supported.dcm');
  await expect(status).not.toContainText('Selected files: broken-supported-folder/broken-supported.dcm');
  await expect(status).toContainText('checked 4 files');
  await expect(status).toContainText('selected 1 openable file (DICOM) and 1 converter-backed file (CZI)');
  await expect(status).toContainText('converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: broken-supported-folder/cells.czi');
  await expect(status).toContainText('skipped 2 unsupported files');
  await expect(status).toContainText('notes.md');
  await expect(status).toContainText('results.csv');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal shows honest format support boundaries without layout overflow', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const matrix = page.locator('.format-capability-matrix');
  await expect(matrix).toBeVisible();
  await expect(matrix.locator('.format-capability-row')).toHaveCount(11);
  await expect(matrix).toContainText('Native');
  await expect(matrix).toContainText('Converted');
  await expect(matrix).toContainText('Unsupported');
  await expect(matrix).toContainText('OME-TIFF / ImageJ TIFF');
  await expect(matrix).toContainText('signed/unsigned 8/16-bit grayscale');
  await expect(matrix).toContainText('composite, split-preview, workflow recipe save/replay');
  await expect(matrix).toContainText('calibrated ROI measurements when spacing metadata is present');
  await expect(matrix).toContainText('ImageJ ROI .roi');
  await expect(matrix).toContainText('Limited ImageJ ROI Manager sidecar import');
  await expect(matrix).toContainText('opened onto the active microscopy series');
  await expect(matrix).toContainText('straight-line');
  await expect(matrix).toContainText('ImageJ ROI .zip');
  await expect(matrix).toContainText('stored/deflated supported ROI sidecars');
  await expect(matrix).toContainText('VoxelLab-authored uncompressed ZIP export');
  await expect(matrix).toContainText('straight-line and angle measurements');
  await expect(matrix).toContainText('SEG / RTSTRUCT / SR / RT Dose');
  await expect(matrix).toContainText('SR re-import is limited to VoxelLab-exported measurement notes');
  await expect(matrix).toContainText('TIFF image sequences');
  await expect(page.locator('.upload-copy', {
    hasText: 'generic TIFF sequences stay uncalibrated',
  })).toBeVisible();
  await expect(matrix).toContainText('OME-Zarr (limited)');
  await expect(matrix).toContainText('OME-NGFF 0.4-style');
  await expect(matrix).toContainText('uncompressed level-0 local chunks only');
  await expect(matrix).toContainText('metadata-only fallback for compressed, remote, pyramid, or broader OME-Zarr');
  await expect(matrix).toContainText('Compressed TIFF / BigTIFF / tiled pyramids');
  await expect(matrix).toContainText('browser import fails closed');
  await expect(matrix).toContainText('CZI / ND2 / LIF / OIB / OIF / LSM bridge');
  await expect(matrix).toContainText('Local backend can convert CZI/ND2/LIF with optional readers');
  await expect(matrix).toContainText('CZI/ND2/LIF/OIB/OIF/LSM through a configured external OME-TIFF converter');
  await expect(matrix).toContainText('Electron uses the same external-converter boundary');
  await expect(matrix).toContainText('not native browser import');
  await expect(matrix).toContainText('first-party Bio-Formats parity');
  await expectUploadModalMatrixFits(page);

  await page.setViewportSize({ width: 390, height: 720 });
  await expect(matrix).toBeVisible();
  await expect(matrix.locator('.format-capability-head')).toBeHidden();
  await expectUploadModalMatrixFits(page);
});

test('upload modal respects cloudProcessing=false even when endpoints are configured', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: false },
  });
  await openUploadModal(page);

  await expect(page.locator('#upload-cloud-btn')).toHaveCount(0);
  await expect(page.locator('#upload-body')).toContainText('Nothing is uploaded');
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is disabled.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Disabled');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud reconstruction');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Next: resolve the Cloud GPU runtime blocker before selecting source files.');
});

test('static upload modal does not advertise writable Cloud settings', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: '',
    r2PublicUrl: '',
    features: { cloudProcessing: false },
  });

  await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();

  await expect(page.locator('#upload-cloud-settings-btn')).toHaveCount(0);
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is disabled.');
  await expect(page.locator('#upload-body')).toContainText('Open the desktop app or run npm start to configure Modal GPU');
  await expect(page.locator('#upload-body')).not.toContainText('Use Cloud settings to enable Modal GPU');
});

test('upload modal can drag-and-drop a local NIfTI file through 2D, MPR, and 3D rendering', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('tiny-upload.nii');
  await writeTinyNifti(niftiPath, { pixdim: [0.5, 0.75, 1] });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFile(page, '#upload-zone', niftiPath);

  await expect(page.locator('#series-name')).toHaveText('tiny-upload');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('NIfTI metadata (mm)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted voxel metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Pixel spacing' })).toContainText('0.750 mm × 0.500 mm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('tiny-upload.nii');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-co')).toBeVisible();
  await expect(page.locator('#mpr-sa')).toBeVisible();
  await waitForCanvasPaint(page, '#mpr-ax');
  await waitForCanvasPaint(page, '#mpr-co');
  await waitForCanvasPaint(page, '#mpr-sa');

  await page.locator('#btn-3d').click();
  await expect(page.locator('#btn-3d')).toHaveClass(/active/);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/mpr3d/);
  await waitForThreeSurface(page);
  await expectThreeCanvasFitsContainer(page);

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#canvas-wrap')).toHaveClass(/threeD/);
  await waitForThreeSurface(page);
  await expectThreeCanvasFitsContainer(page);
});

test('upload modal keeps unknown-unit NIfTI uncalibrated in metadata', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('unknown-unit.nii');
  await writeTinyNifti(niftiPath, { xyztUnits: 0 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFile(page, '#upload-zone', niftiPath);

  await expect(page.locator('#series-name')).toHaveText('unknown-unit');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Pixel spacing' })).toContainText('—');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('Uncalibrated (NIfTI unit unknown)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Unknown · NIfTI spatial unit unknown');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('unknown-unit.nii');
  await expect(page.locator('#meta .meta-row').filter({ hasText: '3D reason' })).toContainText('spatial unit is unknown');
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
});

test('upload modal shows local DICOM source provenance in metadata', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('local-source.dcm');
  await writeTinyDicom(dicomPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFile(page, '#upload-zone', dicomPath, 'application/dicom');

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('DICOM metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted XY metadata · 2D only');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source file' })).toContainText('local-source.dcm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Import single-image');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Study 1.2.826.0.1.3680043.10.543.10');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Series 1.2.826.0.1.3680043.10.543.20');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Frame of reference' })).toContainText('1.2.826.0.1.3680043.10.543.30');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal reports skipped local derived objects after loading their source series', async ({ page }, testInfo) => {
  const dicomPath = testInfo.outputPath('local-dicom-with-skipped-sr/source.dcm');
  const srPath = testInfo.outputPath('local-dicom-with-skipped-sr/clinical-note.sr');
  await writeTinyDicom(dicomPath);
  await writeTinySr(srPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([dicomPath, srPath]);

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 derived object' }))
    .toContainText('SR: SR import contains no measurement groups');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal labels multi-file DICOM source provenance in metadata', async ({ page }, testInfo) => {
  const firstPath = testInfo.outputPath('local-dicom-volume/IM0001.dcm');
  const secondPath = testInfo.outputPath('local-dicom-volume/IM0002.dcm');
  await writeTinyDicom(firstPath, { instanceNumber: 1, z: 0 });
  await writeTinyDicom(secondPath, { instanceNumber: 2, z: 1 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeDcmjsModule(page);
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles([firstPath, secondPath]);

  await expect(page.locator('#series-name')).toHaveText('Local DICOM CT');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' }))
    .toContainText('2 files (IM0001.dcm, IM0002.dcm)');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Import volume-stack');
  await waitForCanvasPaint(page, '#view');
});

test('persisted SEG overlays hydrate on the first series selection after reload', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeManifest(page, {
    patient: 'anonymous',
    studyDate: '',
    series: [{
      slug: 'ct_chest_1',
      name: 'CT Chest 1',
      description: '1 slice',
      modality: 'CT',
      slices: 1,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
    }],
  });
  await routeTinyPngStack(page, 'ct_chest_1', 1);
  await page.addInitScript(() => {
    // Shape: localStorage registry entry for a persisted SEG-derived labels overlay.
    localStorage.setItem('mri-viewer/derived-objects/v1', JSON.stringify({
      version: 1,
      entries: {
        'slug:ct_chest_1|obj:seg-test': {
          id: 'slug:ct_chest_1|obj:seg-test',
          objectUID: 'seg-test',
          name: 'Imported SEG',
          modality: 'SEG',
          importedAt: 1,
          binding: {
            derivedKind: 'seg',
            frameOfReferenceUID: '',
            sourceSeriesSlug: 'ct_chest_1',
            requiresRegistration: false,
            affineCompatibility: 'exact',
          },
          payload: {
            format: 'seg-overlay-v1',
            sparseSlices: [[0, 1]],
            regionMeta: {
              regions: { 1: { name: 'Imported SEG', voxels: 1, mL: 0.25, source: 'dicom-seg' } },
              colors: { 1: [255, 0, 0] },
            },
          },
        },
      },
    }));
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-list li.active')).toBeVisible();
  await expect(page.locator('#series-name')).not.toHaveText('—');
  await expect(page.locator('#slice-cur')).not.toHaveText('');
  const sourceSeries = page.locator('#series-list li').filter({ hasText: 'CT Chest 1' });
  await expect(sourceSeries).toBeVisible();
  await sourceSeries.click();
  await expect(page.locator('#series-name')).toHaveText('CT Chest 1');
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series.find((item) => item.slug === 'ct_chest_1');
    const button = document.getElementById('btn-regions');
    return {
      hasRegions: !!series?.hasRegions,
      hasRegionMeta: !!state.regionMeta?.regions?.[1],
      buttonHidden: button?.classList.contains('hidden') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    hasRegions: true,
    hasRegionMeta: true,
    buttonHidden: false,
  });
  await page.evaluate(() => document.getElementById('btn-regions')?.click());

  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      useRegions: !!state.useRegions,
      hasRegionMeta: !!state.regionMeta?.regions?.[1],
      regionImageCount: state.regionImgs?.length || 0,
      firstRegionReady: !!state.regionImgs?.[0]?.complete,
      buttonActive: document.getElementById('btn-regions')?.classList.contains('active') || false,
    };
  }), { timeout: 10_000 }).toEqual({
    useRegions: true,
    hasRegionMeta: true,
    regionImageCount: 1,
    firstRegionReady: true,
    buttonActive: true,
  });

  const volumesPanel = page.locator('[data-panel="region-volumes"]');
  if (await volumesPanel.evaluate(panel => panel.classList.contains('collapsed'))) {
    await volumesPanel.locator('.sec-title').click();
  }
  await expect(page.locator('#regional-volumes-export-csv')).toBeVisible();
  const regionalCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#regional-volumes-export-csv').click();
  const regionalCsvDownload = await regionalCsvDownloadPromise;
  expect(regionalCsvDownload.suggestedFilename()).toBe('voxellab-regional-volumes-ct_chest_1.csv');
  const regionalCsv = await readFile(await regionalCsvDownload.path(), 'utf8');
  expect(regionalCsv.split('\n')[0]).toBe('series_slug,series_name,label_id,label_name,value,unit,percent_of_reported_total,source,provenance,note');
  expect(regionalCsv).toContain('ct_chest_1,CT Chest 1,1,Imported SEG,0.25,mL,100.0,dicom-seg,label voxel count x calibrated voxel spacing,Research measurement; not clinical output.');
});

test('upload modal can discover and import a DICOMweb series through the real UI flow', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '0020000D': { vr: 'UI', Value: ['1.2.study'] },
          '00100010': { vr: 'PN', Value: [{ Alphabetic: 'DOE^JANE' }] },
          '00080020': { vr: 'DA', Value: ['20260101'] },
          '00201206': { vr: 'IS', Value: [1] },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '0020000D': { vr: 'UI', Value: ['1.2.study'] },
          '0020000E': { vr: 'UI', Value: ['1.2.series'] },
          '00200011': { vr: 'IS', Value: [7] },
          '0008103E': { vr: 'LO', Value: ['DICOMweb CT'] },
          '00080060': { vr: 'CS', Value: ['CT'] },
          '00201209': { vr: 'IS', Value: [2] },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-query').fill('DOE*');
  await page.locator('#dicomweb-find-studies-btn').click();
  await expect(page.locator('#dicomweb-study')).toHaveValue('1.2.study');
  await page.locator('#dicomweb-find-series-btn').click();
  await expect(page.locator('#dicomweb-series')).toHaveValue('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#btn-mpr')).toBeVisible();
  await expect(page.locator('#btn-3d')).toBeVisible();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('DICOMweb CT');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('DICOM metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Import volume-stack');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Study 1.2.study');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'DICOM source' })).toContainText('Series 1.2.series');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Frame of reference' })).toContainText('1.2.for');
  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-co')).toBeVisible();
  await expect(page.locator('#mpr-sa')).toBeVisible();
  await waitForCanvasPaint(page, '#mpr-ax');
  await waitForCanvasPaint(page, '#mpr-co');
  await waitForCanvasPaint(page, '#mpr-sa');
});

test('upload modal can bind a DICOMweb RT Dose series onto an already loaded source study', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeDerivedDcmjsStub(page);
  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.dose/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['RTDOSE'] },
          '0020000E': { vr: 'UI', Value: ['1.2.dose'] },
          '00080018': { vr: 'UI', Value: ['1.2.dose.object'] },
          '0008103E': { vr: 'LO', Value: ['Dose Summary'] },
          '00280010': { vr: 'US', Value: [32] },
          '00280011': { vr: 'US', Value: [16] },
          '00280008': { vr: 'IS', Value: [4] },
          '00200052': { vr: 'UI', Value: ['1.2.for'] },
          '3004000E': { vr: 'DS', Value: ['0.001'] },
          '30040002': { vr: 'CS', Value: ['GY'] },
          '30040004': { vr: 'CS', Value: ['PHYSICAL'] },
          '3004000A': { vr: 'CS', Value: ['PLAN'] },
          '00081115': {
            vr: 'SQ',
            Value: [{ '0020000E': { vr: 'UI', Value: ['1.2.series'] } }],
          },
        }]),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.dose');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText('Imported RTDOSE onto');
  const derivedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}'));
  const doseEntry = Object.values(derivedRegistry.entries || {}).find((entry) => entry?.binding?.derivedKind === 'rtdose');
  expect(doseEntry).toMatchObject({
    modality: 'RTDOSE',
    payload: {
      format: 'rtdose-summary-v1',
      rows: 32,
      cols: 16,
      frames: 4,
      doseUnits: 'GY',
      doseType: 'PHYSICAL',
      doseSummationType: 'PLAN',
    },
  });
});

test('upload modal can bind DICOMweb SEG, RTSTRUCT, and SR objects onto an already loaded source study', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '' });
  await routeDerivedDcmjsStub(page);
  let sourceSlug = '';
  let segMetadataCalls = 0;

  await page.route('https://pacs.example/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance()]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.seg/metadata') {
      segMetadataCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([segMetadataInstance()]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.seg/instances/1.2.seg.object/frames/1') {
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(new Uint8Array([0b00001111])),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.seg/instances/1.2.seg.object/frames/2') {
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(new Uint8Array([0b00000010])),
      });
    }
    if (requestUrl.pathname.endsWith('/frames/1') || requestUrl.pathname.endsWith('/frames/2')) {
      const frame = requestUrl.pathname.endsWith('/frames/1') ? new Uint16Array([1, 2, 3, 4]) : new Uint16Array([5, 6, 7, 8]);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(frame.buffer),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.rtstruct/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['RTSTRUCT'] },
          '77770001': {
            vr: 'UN',
            Value: [{
              Modality: 'RTSTRUCT',
              SeriesInstanceUID: '1.2.rtstruct',
              SOPInstanceUID: '1.2.rtstruct.object',
              SeriesDescription: 'Contours',
              ReferencedFrameOfReferenceSequence: [{
                RTReferencedStudySequence: [{
                  RTReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2.series' }],
                }],
              }],
              StructureSetROISequence: [{ ROINumber: 1, ROIName: 'Lesion' }],
              ROIContourSequence: [{
                ReferencedROINumber: 1,
                ContourSequence: [{
                  ContourGeometricType: 'CLOSED_PLANAR',
                  ContourData: [
                    0, 0, 0,
                    1, 0, 0,
                    1, 1, 0,
                    0, 1, 0,
                  ],
                }],
              }],
            }],
          },
        }]),
      });
    }
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.sr/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          '00080060': { vr: 'CS', Value: ['SR'] },
          '77770001': {
            vr: 'UN',
            Value: [{
              Modality: 'SR',
              SeriesInstanceUID: '1.2.sr',
              SOPInstanceUID: '1.2.sr.object',
              SeriesDescription: 'Measurements',
              ContentSequence: [{
                ValueType: 'CONTAINER',
                ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
                ContentSequence: [
                  {
                    ValueType: 'TEXT',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
                    TextValue: `${sourceSlug} slice 2`,
                  },
                  {
                    ValueType: 'NUM',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
                    MeasuredValueSequence: [{ NumericValue: '12.5' }],
                  },
                  {
                    ValueType: 'TEXT',
                    ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
                    TextValue: 'Follow-up target',
                  },
                ],
              }],
            }],
          },
        }]),
      });
    }
    throw new Error(`Unhandled DICOMweb request: ${requestUrl.toString()}`);
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  sourceSlug = await page.locator('#series-list li.active').getAttribute('data-series-slug') || '';
  expect(sourceSlug).toBeTruthy();

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.seg');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText(`Imported SEG onto ${sourceSlug}.`);
  expect(segMetadataCalls).toBe(1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.rtstruct');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect.poll(async () => page.evaluate((slug) => {
    const rois = JSON.parse(localStorage.getItem('mri-viewer/rois/v1') || '{}');
    return rois[`${slug}|0`]?.[0] || null;
  }, sourceSlug)).toMatchObject({
    shape: 'polygon',
    text: 'Lesion',
  });

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.sr');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText(`Imported SR onto ${sourceSlug}.`);
  await expect.poll(async () => page.evaluate((slug) => {
    const annotations = JSON.parse(localStorage.getItem('mri-viewer/annotations/v1') || '{}');
    return annotations[`${slug}|1`]?.[0]?.text || '';
  }, sourceSlug)).toContain('Length: 12.5');
  await expect.poll(async () => page.evaluate((slug) => {
    const annotations = JSON.parse(localStorage.getItem('mri-viewer/annotations/v1') || '{}');
    return annotations[`${slug}|1`]?.[0]?.text || '';
  }, sourceSlug)).toContain('Comment: Follow-up target');
  const derivedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}'));
  const derivedKinds = Object.values(derivedRegistry.entries || {}).map((entry) => entry?.binding?.derivedKind).sort();
  expect(derivedKinds).toEqual(expect.arrayContaining(['rtstruct', 'seg', 'sr']));
});

test('upload modal can start cloud processing through the local proxy path', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  const seenProxyHeaders = [];
  const seenUploadHeaders = [];
  const startBodies = [];
  let statusChecks = 0;
  let releaseCloudComplete = () => {};
  const cloudCompleteReady = new Promise(resolve => { releaseCloudComplete = resolve; });
  await page.route('**/api/cloud/get_upload_urls', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
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
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    startBodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    seenProxyHeaders.push(route.request().headers()['x-voxellab-local-token']);
    statusChecks += 1;
    if (statusChecks === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'running' }),
      });
      return;
    }
    await cloudCompleteReady;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: 'Cloud CT',
          description: '2 slices',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          hasStats: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    seenUploadHeaders.push(route.request().headers()['x-voxellab-local-token']);
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/proxy-asset?url=*cloud_job123*', async (route) => {
    const proxiedUrl = new URL(route.request().url()).searchParams.get('url') || '';
    if (decodeURIComponent(proxiedUrl).endsWith('/data/cloud_job123_stats.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          slug: 'cloud_job123',
          source: 'modal:totalsegmentator',
          sourceRegions: 'data/cloud_job123_regions.json',
          regionVolumes: [{ id: '1', name: 'Heart', volumeMl: 12.25, voxels: 12250 }],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
  });
  await page.route('**/data/cloud_job123.raw', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.alloc(4 * 4 * 2 * 2),
    });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Cloud action ready');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('2 DICOM files');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Expected result: derived volume overlays, labels, stats, or raw volume when returned by Modal.');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('Modal/R2 account may incur');
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Running cloud segmentation on GPU');
  await expect(page.locator('#upload-cloud-job-card')).toBeVisible();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText(/job_/);
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Running');
  releaseCloudComplete();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud action' })).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud job' })).toContainText('job_');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('modal');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('raw volume');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toContainText('stats');
  await expect(page.locator('#quantification-panel')).toBeVisible();
  await expect(page.locator('#quantification')).toContainText('Region Heart');
  await expect(page.locator('#quantification')).toContainText('12.3 mL');
  await expect(page.locator('#quantification')).toContainText('https://r2.example/data/cloud_job123_stats.json');
  await expect(page.locator('#cloud-provenance-export-json')).toBeVisible();
  const provenanceDownloadPromise = page.waitForEvent('download');
  await page.locator('#cloud-provenance-export-json').click();
  const provenanceDownload = await provenanceDownloadPromise;
  expect(provenanceDownload.suggestedFilename()).toBe('voxellab-cloud-provenance-cloud_job123.json');
  const provenance = JSON.parse(await readFile(await provenanceDownload.path(), 'utf8'));
  expect(provenance.schema).toBe('voxellab.cloud-provenance.v1');
  expect(provenance.disclaimer).toContain('not clinical output');
  expect(provenance.series.slug).toBe('cloud_job123');
  expect(provenance.action.label).toBe('Cloud CT/MR segmentation');
  expect(provenance.action.inputKind).toBe('dicom_volume_stack');
  expect(provenance.action.jobId).toMatch(/^job_/);
  expect(provenance.outputs.previewStack.urlBase).toBe('https://r2.example/data/cloud_job123');
  expect(provenance.outputs.rawVolume.url).toBe('https://r2.example/cloud_job123.raw.zst');
  expect(provenance.outputs.sidecars.stats).toBe('https://r2.example/data/cloud_job123_stats.json');
  expect(JSON.stringify(provenance)).not.toContain('local-token-123');
  await expect(page.locator('#cloud-result-package-json')).toBeVisible();
  const packageDownloadPromise = page.waitForEvent('download');
  await page.locator('#cloud-result-package-json').click();
  const packageDownload = await packageDownloadPromise;
  expect(packageDownload.suggestedFilename()).toBe('voxellab-cloud-package-cloud_job123.json');
  const resultPackage = JSON.parse(await readFile(await packageDownload.path(), 'utf8'));
  expect(resultPackage.schema).toBe('voxellab.cloud-result-package.v1');
  expect(resultPackage.packageType).toBe('manifest-only');
  expect(resultPackage.assets).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'preview-stack', urlBase: 'https://r2.example/data/cloud_job123', slices: 2 }),
    expect.objectContaining({ kind: 'raw-volume', url: 'https://r2.example/cloud_job123.raw.zst' }),
    expect.objectContaining({ kind: 'sidecar-stats', url: 'https://r2.example/data/cloud_job123_stats.json' }),
  ]));
  expect(resultPackage.provenance.action.jobId).toMatch(/^job_/);
  expect(JSON.stringify(resultPackage)).not.toContain('local-token-123');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT');
  expect(startBodies[0]?.input_kind).toBe('dicom_volume_stack');
  expect(seenProxyHeaders).toEqual(['local-token-123', 'local-token-123', 'local-token-123', 'local-token-123']);
  expect(seenUploadHeaders).toEqual([undefined, undefined]);
});

test('upload modal blocks cloud processing for non-DICOM medical inputs', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('cloud-blocked.nii');
  await writeTinyNifti(niftiPath);

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
  await page.locator('#upload-file-input').setInputFiles(niftiPath);

  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('DICOM CT/MR volume stacks only');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('cloud-blocked.nii');
  expect(cloudCalls).toEqual([]);
});

test('upload modal blocks default cloud segmentation for mixed CT/MR series', async ({ page }, testInfo) => {
  const first = testInfo.outputPath('cloud-mixed-series-a.dcm');
  const second = testInfo.outputPath('cloud-mixed-series-b.dcm');
  await writeTinyDicom(first, { seriesUID: '1.2.826.0.1.3680043.10.543.20.1', instanceNumber: 1, z: 0 });
  await writeTinyDicom(second, { seriesUID: '1.2.826.0.1.3680043.10.543.20.2', instanceNumber: 2, z: 1 });

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
  await page.locator('#upload-file-input').setInputFiles([first, second]);

  await expect(page.locator('#upload-cloud-btn')).toBeDisabled();
  await expect(page.locator('#upload-cloud-action-state')).toContainText('one coherent DICOM series');
  await expect(page.locator('#upload-cloud-action-state')).toContainText('voxellab.source.json for registration/alignment');
  expect(cloudCalls).toEqual([]);
});

test('upload modal updates an existing cloud series instead of duplicating it', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-repeat-input');

  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

  let cloudRun = 0;
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
    cloudRun += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'complete',
        slug: 'cloud_job123',
        series_entry: {
          slug: 'cloud_job123',
          name: cloudRun === 1 ? 'Cloud CT' : 'Cloud CT Updated',
          description: cloudRun === 1 ? '2 slices' : '2 slices updated',
          slices: 2,
          width: 4,
          height: 4,
          pixelSpacing: [1, 1],
          sliceThickness: 1,
          hasRaw: true,
          sliceUrlBase: 'https://r2.example/data/cloud_job123',
          rawUrl: 'https://r2.example/cloud_job123.raw.zst',
        },
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#series-name')).toHaveText('Cloud CT Updated');
  await expect(page.locator('#series-desc')).toHaveText('2 slices updated');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-list')).toContainText('Cloud CT Updated');
});

test('upload modal keeps cloud job failures visible instead of pretending success', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-error-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        error: 'GPU pipeline failed',
      }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('GPU pipeline failed');
  await expect(page.locator('#upload-cloud-job-card')).toBeVisible();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Failed');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText(/job_/);
  await expect(page.locator('#upload-cloud-job-card')).toContainText('GPU pipeline failed');
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
});

test('upload modal fails completed cloud jobs that do not return importable results', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-missing-result-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: '',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'complete', slug: 'cloud_missing_result' }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await expect(page.locator('#upload-cloud-btn')).toBeVisible();
  await page.locator('#upload-cloud-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('did not return an importable series entry');
  await expect(page.locator('#upload-status')).toContainText('Configure an R2 public URL');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Failed');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Cloud CT/MR segmentation');
  await expect(page.locator('#upload-cloud-job-card')).toContainText('did not return an importable series entry');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
});

test('upload modal can stop waiting for a running cloud job', async ({ page }, testInfo) => {
  const dicomPaths = await writeTinyDicomStack(testInfo, 'cloud-stop-input');

  await acceleratePolling(page);
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    localApiToken: 'local-token-123',
    features: { cloudProcessing: true },
  });

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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'started' }) });
  });
  await page.route('**/api/cloud/check_status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'running' }),
    });
  });
  await page.route('https://upload.example/**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await openUploadModal(page);
  await page.locator('#upload-file-input').setInputFiles(dicomPaths);
  await page.locator('#upload-cloud-btn').click();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Running');
  await expect(page.locator('[data-cloud-job-stop]')).toHaveText('Stop waiting');
  await expect.poll(async () => page.locator('#upload-modal').evaluate((el) => el.dataset.closeBlocked)).toBe('true');

  await page.keyboard.press('Escape');
  await expect(page.locator('#upload-modal')).toBeVisible();

  await page.locator('[data-cloud-job-stop]').click();
  await expect(page.locator('#upload-cloud-job-card')).toContainText('Stopped');
  await expect(page.locator('#upload-status')).toContainText('Stopped waiting for cloud job');
  await expect(page.locator('#upload-cloud-btn')).toBeEnabled();
  await page.locator('#upload-close').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
});
