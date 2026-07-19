import assert from 'node:assert/strict';
import { test } from 'node:test';

const { PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE } = await import('../scripts/verify_microscopy_public_samples.mjs');

test('combined public microscopy verifier declares exact fixture evidence and boundaries', () => {
  assert.deepEqual(
    PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.map(item => item.label),
    ['ome-tiff', 'imagej-tiff', 'ome-zarr-metadata'],
  );
  assert.deepEqual(
    PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.map(item => item.script),
    [
      'verify_ome_microscopy_samples.mjs',
      'verify_imagej_microscopy_sample.mjs',
      'verify_ome_zarr_public_sample.mjs',
    ],
  );
  assert.ok(PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.some(item =>
    item.format === 'OME-TIFF'
    && /missing-calibration warnings/.test(item.coverage)
    && /stay uncalibrated/.test(item.boundary)));
  assert.ok(PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.some(item =>
    item.format === 'ImageJ TIFF'
    && /micrometer calibration/.test(item.coverage)
    && /metadata calibration provenance/.test(item.coverage)
    && /ROI-results CSV area\/perimeter\/circularity\/center-coordinate\/integrated-density/.test(item.coverage)
    && /not full ImageJ/.test(item.boundary)));
  assert.ok(PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.some(item =>
    item.format === 'OME-Zarr metadata'
    && /per-level shapes\/chunks\/compression/.test(item.coverage)
    && /channel colors\/LUTs\/display ranges/.test(item.coverage)
    && /coarsest-level local provenance/.test(item.coverage)
    && /bounded coarsest-level local proof/.test(item.boundary)
    && /declared zero fill_value/.test(item.boundary)
    && /full-resolution level-0 eager import over budget/.test(item.boundary)));
  for (const item of PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE) {
    assert.doesNotMatch(`${item.coverage} ${item.boundary}`, /Fiji replacement|Bio-Formats parity/i);
  }
});
