import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { ASK_EVENT_PROTOCOL, ASK_EVENT_VERSION } from '../../js/ask-event-stream.js';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

const askEvent = event => ({ protocol: ASK_EVENT_PROTOCOL, version: ASK_EVENT_VERSION, ...event });

test('Ask sends active cloud action provenance as hidden request context', async ({ page }) => {
  const cloudSeries = {
    ...localVolumeSeries('cloud_seg_result', 'Cloud Segmentation Result', { modality: 'CT', slices: 4 }),
    hasSeg: true,
    sourceJobId: 'job_fixture_cloud_123',
    cloudAction: {
      id: 'cloud-volume-segmentation',
      label: 'Cloud CT/MR segmentation',
      provider: 'modal',
      jobId: 'job_fixture_cloud_123',
      resultStatus: 'partial',
      processingMode: 'total_segmentator',
      inputKind: 'dicom_volume_stack',
      resultSlug: 'cloud_seg_result',
    },
  };
  const reconstructionSeries = {
    ...localVolumeSeries('cloud_recon_result', 'Cloud Reconstruction Result', { modality: 'XA', slices: 4 }),
    hasRaw: true,
    sourceJobId: 'job_fixture_recon_456',
    cloudAction: {
      id: 'cloud-projection-reconstruction',
      label: 'Cloud reconstruction',
      provider: 'modal',
      jobId: 'job_fixture_recon_456',
      processingMode: 'projection_set_reconstruction',
      inputKind: 'calibrated_projection_set',
      resultSlug: 'cloud_recon_result',
    },
    registration: {
      source: 'modal:rigid_registration',
      referenceSlug: 'cloud_seg_result',
      movingSlug: 'cloud_recon_result',
      verdict: 'slightly off',
      transform: {
        type: 'rigid',
        translationMagnitudeMm: 3.25,
        rotationDeg: 1.2,
      },
      metrics: {
        dice: 0.86,
      },
      quality: {
        mm: 3.25,
        dice: 0.86,
        rotationDeg: 1.2,
        verdict: 'slightly off',
      },
    },
  };
  await routeLocalVolumeStudy(page, [cloudSeries, reconstructionSeries]);

  let postedPayload = {};
  await page.route('**/api/ask/stream', async (route) => {
    postedPayload = route.request().postDataJSON() || {};
    const result = {
      cached: false,
      key: '0:study:cloudctx',
      slice: 0,
      x: 0,
      y: 0,
      question: 'What cloud work has already been done?',
      answer: 'Cloud context received.',
      crop: 'data/cloud_seg_result_asks/0000_study_cloudctx.png',
      actions: [
        {
          id: 'open-cloud-results',
          label: 'Open Cloud Results',
          detail: 'Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial.',
        },
        {
          id: 'open-cloud-workflow',
          label: 'Open Cloud GPU',
          detail: 'Select source files for segmentation, registration/alignment, reconstruction, or ultrasound scan conversion.',
        },
      ],
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(askEvent({ type: 'result', result }))}\n\n`,
    });
  });

  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);

  await expect(page.locator('#series-list li')).toHaveCount(2);
  await expect(page.locator('#series-list .series-cloud-mark')).toHaveCount(2);
  await expect(page.locator('#series-list li').first().locator('.series-cloud-mark')).toHaveAttribute(
    'title',
    'Cloud CT/MR segmentation · job job_fixture_cloud_123 · status partial',
  );
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#series-name')).toHaveText('Cloud Segmentation Result');
  const cloudPanel = page.locator('#cloud-results-panel');
  await expect(cloudPanel).toBeVisible();
  await expect(cloudPanel.locator('#cloud-results-count')).toHaveText('2');
  await cloudPanel.locator('.sec-title').click();
  const cloudRows = cloudPanel.locator('.cloud-result-row');
  await expect(cloudRows).toHaveCount(2);
  await expect(cloudRows.first()).toContainText('Cloud Reconstruction Result');
  await expect(cloudRows.first()).toContainText('Cloud reconstruction · job job_fixture_recon_456 · outputs raw');
  await expect(cloudRows.first()).toContainText('provider modal · mode projection_set_reconstruction · input calibrated_projection_set');
  await expect(cloudRows.nth(1)).toContainText('Cloud Segmentation Result');
  await expect(cloudRows.nth(1)).toContainText('provider modal · status partial · mode total_segmentator · input dicom_volume_stack');
  await expect(cloudRows.nth(1)).toHaveAttribute('aria-current', 'true');
  await cloudRows.first().click();
  await expect(page.locator('#series-name')).toHaveText('Cloud Reconstruction Result');
  await expect(cloudPanel.locator('.cloud-result-row').first()).toHaveAttribute('aria-current', 'true');
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#series-name')).toHaveText('Cloud Segmentation Result');
  await expect(page.locator('#btn-ask')).toBeVisible();

  await page.locator('#btn-ask').click();
  await expect(page.locator('#ask-composer')).toBeVisible();
  await expect(page.locator('#ask-open-cloud-workflow')).toBeVisible();
  await page.locator('#ask-open-cloud-workflow').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-context-hint')).toContainText('Cloud GPU processing');
  await expect(page.locator('#upload-context-hint')).toContainText('VoxelLab checks eligibility before any upload');
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is disabled.');
  await page.locator('#upload-close').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
  const userQuestion = 'What cloud work has already been done?';
  await page.locator('#ask-bar-input').fill(userQuestion);
  await page.locator('#ask-bar-send').click();

  await expect(page.locator('.ask-qa-q')).toHaveText(userQuestion);
  await expect.poll(() => postedPayload.viewerContext || '').toContain('Viewer cloud/action context');
  expect(postedPayload.question).toBe(userQuestion);
  expect(postedPayload.viewerContext).toContain('Completed cloud action: Cloud CT/MR segmentation');
  expect(postedPayload.viewerContext).toContain('job job_fixture_cloud_123');
  expect(postedPayload.viewerContext).toContain('status partial');
  expect(postedPayload.viewerContext).toContain('mode total_segmentator');
  expect(postedPayload.viewerContext).toContain('input dicom_volume_stack');
  expect(postedPayload.viewerContext).toContain('Available cloud outputs: tissue overlay.');
  expect(postedPayload.viewerContext).toContain('Active cloud provenance export: Metadata panel Provenance JSON; filename voxellab-cloud-provenance-cloud_seg_result.json');
  expect(postedPayload.viewerContext).toContain('Active cloud package export: Metadata panel Package JSON; filename voxellab-cloud-package-cloud_seg_result.json');
  expect(postedPayload.viewerContext).toContain('Completed cloud actions in loaded study: 2.');
  expect(postedPayload.viewerContext).toContain('Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial');
  expect(postedPayload.viewerContext).toContain('Other completed cloud action: Cloud reconstruction; series Cloud Reconstruction Result; job job_fixture_recon_456');
  expect(postedPayload.viewerContext).toContain('Other registration evidence: series Cloud Reconstruction Result; verdict slightly off; displacement 3.25 mm; dice 0.86; rotation 1.2 deg; source modal:rigid_registration');
  expect(postedPayload.viewerContext).toContain('export Metadata panel Registration JSON filename voxellab-registration-evidence-cloud_recon_result.json');
  expect(postedPayload.viewerContext).toContain('inspect Metadata panel Compare opens fixed/moving compare with Cloud Segmentation Result as fixed image');
  expect(postedPayload.viewerContext).toContain('outputs raw volume');
  expect(postedPayload.viewerContext).toContain('Cloud actions launch from Upload study after explicit file selection');
  expect(postedPayload.viewerContext).toContain('Cloud workflow operator summary: 4 action slots;');
  expect(postedPayload.viewerContext).toContain('Cloud workflow operator boundary: Ask can prepare prerequisites and next steps; Upload study must select files and launch jobs.');
  expect(postedPayload.viewerContext).toContain('Cloud workflow next steps:');
  expect(postedPayload.viewerContext).toContain('Cloud workflow next step: Cloud CT/MR segmentation:');
  expect(postedPayload.viewerContext).toContain('loaded study: no CT/MR source volume candidate.');
  expect(postedPayload.viewerContext).toContain('Cloud action slots:');
  expect(postedPayload.viewerContext).toContain('Cloud CT/MR segmentation:');
  expect(postedPayload.viewerContext).toContain('loaded study: no CT/MR source volume candidate');
  expect(postedPayload.viewerContext).toContain('Cloud reconstruction:');
  expect(postedPayload.viewerContext).toContain('Cloud registration/alignment:');
  expect(postedPayload.viewerContext).toContain('Cloud ultrasound scan conversion:');
  await expect(page.locator('.ask-qa-a')).toContainText('Cloud context received.');
  const askAction = page.locator('.ask-action-chip', { hasText: 'Open Cloud GPU' });
  await expect(askAction).toBeVisible();
  await expect(askAction).toContainText('segmentation, registration/alignment');
  await askAction.click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-context-hint')).toContainText('Cloud GPU processing');
  await expect(page.locator('#upload-context-hint')).toContainText('Select source files for segmentation, registration/alignment, reconstruction, or ultrasound scan conversion.');
  await page.locator('#upload-close').click();
  await expect(page.locator('#upload-modal')).toBeHidden();
  const cloudResultsAction = page.locator('.ask-action-chip', { hasText: 'Open Cloud Results' });
  await expect(cloudResultsAction).toBeVisible();
  await expect(cloudResultsAction).toContainText('job job_fixture_cloud_123');
  await cloudResultsAction.click();
  await expect(page.locator('#series-name')).toHaveText('Cloud Reconstruction Result');
  await expect(page.locator('#ask-composer')).toBeHidden();
});

test('cloud segmentation mesh export uses cached labels without requiring overlay visibility', async ({ page }) => {
  const cloudSeries = {
    ...localVolumeSeries('cloud_seg_result', 'Cloud Segmentation Result', { modality: 'CT', slices: 4 }),
    sourceJobId: 'job_fixture_cloud_mesh',
    cloudAction: {
      id: 'cloud-volume-segmentation',
      label: 'Cloud CT/MR segmentation',
      provider: 'modal',
      jobId: 'job_fixture_cloud_mesh',
      processingMode: 'total_segmentator',
      inputKind: 'dicom_volume_stack',
      resultSlug: 'cloud_seg_result',
    },
  };
  await routeLocalVolumeStudy(page, [cloudSeries]);

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#series-name')).toHaveText('Cloud Segmentation Result');

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { renderStructuresPanel } = await import('/js/atlas/structures-panel.js');
    const series = state.manifest.series[0];
    series.hasRegions = true;
    const voxels = new Uint8Array(series.width * series.height * series.slices);
    for (let z = 1; z <= 2; z += 1) {
      for (let y = 1; y <= 2; y += 1) {
        for (let x = 1; x <= 2; x += 1) {
          voxels[(z * series.height + y) * series.width + x] = 7;
        }
      }
    }
    state.useRegions = false;
    state.regionVoxels = voxels;
    state.regionMeta = {
      regions: { 7: { name: 'Fixture Organ', voxels: 8, mL: 8 } },
      colors: { 7: [255, 0, 0] },
    };
    renderStructuresPanel();
  });

  const structuresPanel = page.locator('#structures-panel');
  await expect(structuresPanel).toBeVisible();
  if (await structuresPanel.evaluate(panel => panel.classList.contains('collapsed'))) {
    await structuresPanel.locator('.sec-title').click();
  }
  await expect(structuresPanel.locator('.structure-row')).toContainText('Fixture Organ');
  const downloadPromise = page.waitForEvent('download');
  await structuresPanel.locator('#label-export-study-obj').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cloud-seg-result-segmentations.obj');
  await expect(page.locator('#notify-container')).toContainText('Exported 1 structure mesh as OBJ.');
});

test('loaded cloud stats sidecar renders quantified values with provenance', async ({ page }) => {
  const cloudSeries = {
    ...localVolumeSeries('cloud_stats_result', 'Cloud Quantification Result', { modality: 'CT', slices: 4 }),
    hasStats: true,
    hasSym: true,
    sourceJobId: 'job_fixture_quant_789',
    cloudAction: {
      id: 'cloud-volume-segmentation',
      label: 'Cloud CT/MR segmentation',
      provider: 'modal',
      jobId: 'job_fixture_quant_789',
      processingMode: 'total_segmentator',
      inputKind: 'dicom_volume_stack',
      resultSlug: 'cloud_stats_result',
    },
  };
  await routeLocalVolumeStudy(page, [cloudSeries]);
  let postedPayload = {};
  await page.route('**/api/ask/stream', async (route) => {
    postedPayload = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(askEvent({
        type: 'result',
        result: {
          cached: false,
          key: '0:study:quantification',
          slice: 0,
          x: 0,
          y: 0,
          question: 'What quantification is available?',
          answer: 'Quantification context received.',
          crop: 'data/cloud_stats_result_asks/0000_study_quantification.png',
          steps: [],
        },
      }))}\n\n`,
    });
  });
  await page.route('**/data/cloud_stats_result_stats.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        slug: 'cloud_stats_result',
        symmetryScores: [0, 2.25, 9.5, 3.1],
        csfTotalMl: 42.25,
        ventricleEstimateMl: 6.5,
        ventricleNote: 'Fixture estimate.',
        sourceRegions: 'data/cloud_stats_result_regions.json',
        regionVolumes: [{ id: '1', name: 'Heart', volumeMl: 12.25, voxels: 12250 }],
      }),
    });
  });
  await page.route('**/data/cloud_stats_result_sym/*.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/></svg>',
    });
  });

  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);

  await expect(page.locator('#series-name')).toHaveText('Cloud Quantification Result');
  await expect(page.locator('#quantification-panel')).toBeVisible();
  await expect(page.locator('#quantification')).toContainText('Asymmetry peak');
  await expect(page.locator('#quantification')).toContainText('Slice 3 · score 9.5');
  await expect(page.locator('#quantification')).toContainText('CSF estimate');
  await expect(page.locator('#quantification')).toContainText('42.3 mL');
  await expect(page.locator('#quantification')).toContainText('Ventricle est.');
  await expect(page.locator('#quantification')).toContainText('6.5 mL');
  await expect(page.locator('#quantification')).toContainText('Region Heart');
  await expect(page.locator('#quantification')).toContainText('12.3 mL');
  await expect(page.locator('#quantification')).toContainText('data/cloud_stats_result_stats.json');
  await expect(page.locator('#quantification')).toContainText('not clinical output');
  await page.locator('#quantification-panel .sec-title').click();

  await expect(page.locator('#quantification-export-csv')).toBeVisible();
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#quantification-export-csv').click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe('voxellab-quantification-cloud_stats_result.csv');
  const csv = await readFile(await csvDownload.path(), 'utf8');
  expect(csv.split('\n')[0]).toBe('series_slug,series_name,metric,value,unit,source,provenance,note');
  expect(csv).toContain('cloud_stats_result,Cloud Quantification Result,Asymmetry peak,9.5,score,data/cloud_stats_result_stats.json,slice 3');
  expect(csv).toContain('cloud_stats_result,Cloud Quantification Result,Region volume: Heart,12.3,mL,data/cloud_stats_result_stats.json,TotalSegmentator label voxels x voxel spacing');
  expect(csv).toContain('cloud_stats_result,Cloud Quantification Result,CSF estimate,42.3,mL,data/cloud_stats_result_stats.json,GMM CSF voxels x voxel spacing');
  expect(csv).toContain('cloud_stats_result,Cloud Quantification Result,Ventricle estimate,6.5,mL,data/cloud_stats_result_stats.json,opening-based CSF top-blob estimate,Fixture estimate.');
  await expect(page.locator('#quantification-export-json')).toBeVisible();
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#quantification-export-json').click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe('voxellab-quantification-cloud_stats_result.json');
  const quantification = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(quantification.schema).toBe('voxellab.quantification.v1');
  expect(quantification.disclaimer).toContain('not clinical output');
  expect(quantification.series.slug).toBe('cloud_stats_result');
  expect(quantification.records).toEqual(expect.arrayContaining([
    expect.objectContaining({
      metric: 'Region volume: Heart',
      value: '12.3',
      unit: 'mL',
      regionId: '1',
      voxels: 12250,
      sourceRegions: 'data/cloud_stats_result_regions.json',
    }),
    expect.objectContaining({
      metric: 'Asymmetry peak',
      value: '9.5',
      unit: 'score',
      sourceSliceIndex: 2,
      sourceSliceDisplay: 3,
      visualLink: { type: 'viewer-slice', sliceIndex: 2, overlay: 'symmetry' },
    }),
  ]));

  await page.locator('#jump-quant-sym').click();
  await expect(page.locator('#slice-cur')).toHaveText('3');

  await page.locator('#btn-ask').click();
  await expect(page.locator('#ask-composer')).toBeVisible();
  await page.locator('#ask-bar-input').fill('Summarize the quantitative evidence.');
  await page.locator('#ask-bar-send').click();

  await expect.poll(() => postedPayload.viewerContext || '').toContain('Active quantification sidecar');
  expect(postedPayload.viewerContext).toContain('data/cloud_stats_result_stats.json');
  expect(postedPayload.viewerContext).toContain('Heart region volume 12.3 mL');
  expect(postedPayload.viewerContext).toContain('asymmetry peak slice 3 score 9.5');
  expect(postedPayload.viewerContext).toContain('CSF estimate 42.3 mL');
  expect(postedPayload.viewerContext).toContain('ventricle estimate 6.5 mL');
  expect(postedPayload.viewerContext).toContain('Active quantification exports: Metadata panel CSV and JSON; filenames voxellab-quantification-cloud_stats_result.csv and voxellab-quantification-cloud_stats_result.json');
  expect(postedPayload.viewerContext).toContain('approximate research measurements, not clinical output');
});
