import { expect, test } from '@playwright/test';

import {
  openAdvancedOptions,
  openEmptyStudyUploadModal as openUploadModal,
  routeConfig,
} from '../helpers/browser/app.mjs';
import { waitForCanvasPaint } from '../helpers/browser/canvas.mjs';
import { enhancedMetadataInstance, segMetadataInstance } from '../helpers/browser/fixtures/dicom.mjs';

async function routeDerivedDcmjsStub(page) {
  await page.route('**/node_modules/dcmjs/build/dcmjs.es.js', async (route) => {
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
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.dose');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container')).toContainText('Imported RTDOSE onto');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'RT Dose attachments' })).toContainText('1');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'RT Dose metadata' }))
    .toContainText('dimensions 32 × 16 × 4 · scaling 0.001 · units GY · type PHYSICAL · summation PLAN');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'RT Dose boundary' }))
    .toContainText('metadata only, dose grid is not decoded or rendered');
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
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.series.comparison/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([enhancedMetadataInstance({
          seriesUID: '1.2.series.comparison',
          sopInstanceUID: '1.2.sop.comparison',
          description: 'DICOMweb comparison',
        })]),
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
    if (requestUrl.pathname === '/studies/1.2.study/series/1.2.seg.fractional/metadata') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([segMetadataInstance({
          seriesUID: '1.2.seg.fractional',
          sopInstanceUID: '1.2.seg.fractional.object',
          segmentationType: 'FRACTIONAL',
        })]),
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
    if (requestUrl.pathname.includes('/series/1.2.seg.fractional/instances/1.2.seg.fractional.object/frames/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(new Uint8Array([0])),
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
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series.comparison');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb comparison');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 2);
  const beforeRejectedSeg = await page.evaluate(async (loadedSourceSlug) => {
    const { state } = await import('/js/core/state.js');
    const registry = JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}');
    return {
      activeSlug: state.manifest.series[state.seriesIdx]?.slug || '',
      derivedEntries: Object.keys(registry.entries || {}).length,
      seriesCount: state.manifest.series.length,
      sourceHasRegions: Boolean(state.manifest.series.find((series) => series.slug === loadedSourceSlug)?.hasRegions),
    };
  }, sourceSlug);
  expect(beforeRejectedSeg.activeSlug).not.toBe(sourceSlug);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.seg.fractional');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('segmentation_type_unsupported');
  await expect.poll(async () => page.evaluate(async (loadedSourceSlug) => {
    const { state } = await import('/js/core/state.js');
    const registry = JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}');
    return {
      activeSlug: state.manifest.series[state.seriesIdx]?.slug || '',
      derivedEntries: Object.keys(registry.entries || {}).length,
      seriesCount: state.manifest.series.length,
      sourceHasRegions: Boolean(state.manifest.series.find((series) => series.slug === loadedSourceSlug)?.hasRegions),
    };
  }, sourceSlug)).toEqual(beforeRejectedSeg);

  await page.locator('#dicomweb-series').fill('1.2.seg');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 2);
  await expect(page.locator('#notify-container')).toContainText(`Imported SEG onto ${sourceSlug}.`);
  expect(segMetadataCalls).toBe(1);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.rtstruct');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 2);
  await expect.poll(async () => page.evaluate(async (slug) => {
    const { state } = await import('/js/core/state.js');
    const { roiEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series.find((entry) => entry.slug === slug);
    return roiEntriesForSlice(state, series, 0)[0] || null;
  }, sourceSlug)).toMatchObject({
    "shape": 'polygon',
    text: 'Lesion',
  });

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.sr');
  await page.locator('#upload-dicomweb-btn').click();

  await expect(page.locator('#series-name')).toHaveText('DICOMweb CT');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 2);
  await expect(page.locator('#notify-container')).toContainText(`Imported SR onto ${sourceSlug}.`);
  await expect.poll(async () => page.evaluate(async (slug) => {
    const { state } = await import('/js/core/state.js');
    const { noteEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series.find((entry) => entry.slug === slug);
    return noteEntriesForSlice(state, series, 1)[0]?.text || '';
  }, sourceSlug)).toContain('Length: 12.5');
  await expect.poll(async () => page.evaluate(async (slug) => {
    const { state } = await import('/js/core/state.js');
    const { noteEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series.find((entry) => entry.slug === slug);
    return noteEntriesForSlice(state, series, 1)[0]?.text || '';
  }, sourceSlug)).toContain('Comment: Follow-up target');
  const derivedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/derived-objects/v1') || '{"entries":{}}'));
  const derivedKinds = Object.values(derivedRegistry.entries || {}).map((entry) => entry?.binding?.derivedKind).sort();
  expect(derivedKinds).toEqual(expect.arrayContaining(['rtstruct', 'seg', 'sr']));
});
