import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudResultDetailText, cloudResultRecords } from '../js/cloud-results.js';

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
