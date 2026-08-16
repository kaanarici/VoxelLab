import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudResultDetailText,
  cloudResultRecords,
  initCloudResults,
  openCloudResultAtIndex,
} from '../js/cloud-results.js';
import { state } from '../js/core/state.js';
import { clearSeriesAvailability } from '../js/series/series-availability.js';

test('cloud result records expose compact provenance details for timelines', () => {
  const series = {
    slug: 'cloud_seg',
    name: 'Cloud Segmentation',
    hasSeg: true,
    hasStats: true,
    cloudAction: {
      label: 'Cloud CT/MR segmentation',
      provider: 'modal',
      jobId: 'job_123',
      processingMode: 'standard',
      inputKind: 'dicom_volume_stack',
      resultSlug: 'cloud_seg',
    },
  };

  assert.equal(
    cloudResultDetailText(series),
    'provider modal · mode standard · input dicom_volume_stack',
  );

  assert.deepEqual(cloudResultRecords([series]), [
    {
      index: 0,
      slug: 'cloud_seg',
      name: 'Cloud Segmentation',
      action: 'Cloud CT/MR segmentation',
      jobId: 'job_123',
      outputs: 'tissue, stats',
      detail: 'provider modal · mode standard · input dicom_volume_stack',
    },
  ]);

  assert.equal(
    cloudResultDetailText({ ...series, cloudAction: { ...series.cloudAction, resultStatus: 'partial' } }),
    'provider modal · status partial · mode standard · input dicom_volume_stack',
  );
});

test('opening a cloud result with session pixels does not probe', async () => {
  clearSeriesAvailability();
  const selected = [];
  let probed = 0;
  initCloudResults({ selectSeries: (index) => selected.push(index) });
  state.seriesIdx = 0;
  state._localStacks = {
    cloud_ct4: Array.from({ length: 4 }, () => ({ complete: true, naturalWidth: 1 })),
  };
  state.manifest = {
    series: [
      {
        slug: 'cloud_ct3',
        name: 'CT3_2026',
        slices: 4,
        sourceJobId: 'job_ct3',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct3' },
      },
      {
        slug: 'cloud_ct4',
        name: 'CT4_2026',
        slices: 4,
        sourceJobId: 'job_ct4',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct4' },
      },
    ],
  };

  const result = await openCloudResultAtIndex(1, {
    probe: async () => {
      probed += 1;
      return false;
    },
  });

  assert.equal(result.opened, true);
  assert.equal(probed, 0);
  assert.deepEqual(selected, [1]);
});

test('opening a reachable remote cloud result routes through selectSeries', async () => {
  clearSeriesAvailability();
  const selected = [];
  initCloudResults({ selectSeries: (index) => selected.push(index) });
  state.seriesIdx = 0;
  state._localStacks = {};
  state.manifest = {
    series: [
      {
        slug: 'cloud_ct3',
        name: 'CT3_2026',
        slices: 4,
        sliceUrlBase: 'https://r2.example/data/cloud_ct3',
        sourceJobId: 'job_ct3',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct3' },
      },
      {
        slug: 'cloud_ct4',
        name: 'CT4_2026',
        slices: 4,
        sliceUrlBase: 'https://r2.example/data/cloud_ct4',
        sourceJobId: 'job_ct4',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct4' },
      },
    ],
  };

  const result = await openCloudResultAtIndex(1, { probe: async () => true });

  assert.equal(result.opened, true);
  assert.deepEqual(selected, [1]);
});

test('opening an unreachable remote cloud result does not select it', async () => {
  clearSeriesAvailability();
  const selected = [];
  initCloudResults({ selectSeries: (index) => selected.push(index) });
  state.seriesIdx = 0;
  state._localStacks = {};
  state.manifest = {
    series: [
      {
        slug: 'cloud_ct3',
        name: 'CT3_2026',
        slices: 4,
        sliceUrlBase: 'https://r2.example/data/cloud_ct3',
        sourceJobId: 'job_ct3',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct3' },
      },
      {
        slug: 'cloud_ct4',
        name: 'CT4_2026',
        slices: 4,
        sliceUrlBase: 'https://r2.example/data/cloud_ct4',
        sourceJobId: 'job_ct4',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_ct4' },
      },
    ],
  };

  const result = await openCloudResultAtIndex(1, { probe: async () => false });

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(selected, []);
});

test('a newer cloud result selection supersedes an older remote probe', async () => {
  clearSeriesAvailability();
  const selected = [];
  let finishFirstProbe;
  initCloudResults({ selectSeries: (index) => selected.push(index) });
  state.seriesIdx = 0;
  state._localStacks = {
    cloud_local: Array.from({ length: 4 }, () => ({ complete: true, naturalWidth: 1 })),
  };
  state.manifest = {
    series: [
      { slug: 'primary', name: 'Primary', slices: 4 },
      {
        slug: 'cloud_remote',
        name: 'Remote result',
        slices: 4,
        sliceUrlBase: 'https://r2.example/data/cloud_remote',
        sourceJobId: 'job_remote',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_remote' },
      },
      {
        slug: 'cloud_local',
        name: 'Local result',
        slices: 4,
        sourceJobId: 'job_local',
        cloudAction: { label: 'Cloud CT/MR segmentation', jobId: 'job_local' },
      },
    ],
  };

  const first = openCloudResultAtIndex(1, {
    probe: () => new Promise((resolve) => { finishFirstProbe = resolve; }),
  });
  const second = await openCloudResultAtIndex(2);
  finishFirstProbe(true);
  const firstResult = await first;

  assert.equal(second.opened, true);
  assert.equal(firstResult.opened, false);
  assert.equal(firstResult.reason, 'superseded');
  assert.deepEqual(selected, [2]);
});
