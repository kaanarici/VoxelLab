import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const {
  cloudProvenanceExportPayload,
  cloudResultPackagePayload,
  cloudSidecarsForSeries,
  formatPixelSpacing,
  seriesCalibrationText,
  seriesCalibrationTrustText,
  sourceFileMetadataRow,
  sourceFileListText,
} = await import('../js/series/select-series-dom.js');

const selectSeriesDomSource = readFileSync(fileURLToPath(new URL('../js/series/select-series-dom.js', import.meta.url)), 'utf8');

test('metadata pixel spacing preserves anisotropic non-microscopy calibration', () => {
  assert.equal(formatPixelSpacing([0.5, 0.5], {}), '0.500 mm');
  assert.equal(formatPixelSpacing([0.75, 0.5], {}), '0.750 mm × 0.500 mm');
});

test('metadata pixel spacing keeps microscopy unit display and unknown spacing closed', () => {
  assert.equal(
    formatPixelSpacing([0.00025, 0.0005], { imageDomain: 'microscopy', microscopy: { physicalUnit: 'µm' } }),
    '0.250 µm × 0.500 µm',
  );
  assert.equal(formatPixelSpacing([0, 0], {}), '—');
});

test('medical calibration text names why spacing is uncalibrated', () => {
  assert.equal(
    seriesCalibrationText({ _niftiSpatialUnit: 'unknown', _spacingKnown: false }, [0, 0]),
    'Uncalibrated (NIfTI unit unknown)',
  );
  assert.equal(
    seriesCalibrationText({ dicomImportKind: 'image-stack', _spacingKnown: false }, [0, 0]),
    'Uncalibrated (DICOM pixel spacing missing)',
  );
  assert.equal(
    seriesCalibrationText({ _spacingKnown: false }, [0, 0]),
    'Uncalibrated (pixel spacing missing)',
  );
});

test('medical calibration text preserves known metadata provenance', () => {
  assert.equal(seriesCalibrationText({ _niftiSpatialUnit: 'mm', _spacingKnown: true }, [0.5, 0.5]), 'NIfTI metadata (mm)');
  assert.equal(seriesCalibrationText({ dicomImportKind: 'volume', _spacingKnown: true }, [0.5, 0.5]), 'DICOM metadata');
  assert.equal(seriesCalibrationText({ _spacingKnown: true }, [0.5, 0.5]), 'Metadata calibrated');
});

test('medical calibration trust text names trusted and unknown spacing states', () => {
  assert.equal(
    seriesCalibrationTrustText({
      width: 8,
      height: 8,
      slices: 2,
      sliceSpacing: 1,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 1],
      orientation: [1, 0, 0, 0, 1, 0],
      _niftiSpatialUnit: 'mm',
      _spacingKnown: true,
    }, [0.5, 0.5]),
    'Trusted voxel metadata',
  );
  assert.equal(
    seriesCalibrationTrustText({ dicomImportKind: 'single-image', _spacingKnown: true }, [0.5, 0.5]),
    'Trusted XY metadata · 2D only',
  );
  assert.equal(
    seriesCalibrationTrustText({ modality: 'DX', slices: 2, _spacingKnown: true }, [0.5, 0.5]),
    'Trusted pixel metadata · reconstruction required',
  );
  assert.equal(
    seriesCalibrationTrustText({ _niftiSpatialUnit: 'unknown', _spacingKnown: false }, [0, 0]),
    'Unknown · NIfTI spatial unit unknown',
  );
  assert.equal(
    seriesCalibrationTrustText({ dicomImportKind: 'image-stack', _spacingKnown: false }, [0, 0]),
    'Unknown · DICOM pixel spacing missing',
  );
});

test('microscopy metadata panel exposes TIFF sequence ordering provenance', () => {
  assert.match(selectSeriesDomSource, /microscopySequenceOrderText/);
  assert.match(selectSeriesDomSource, /\['Sequence order', sequenceOrderText\]/);
  assert.match(selectSeriesDomSource, /\['Spacing trust', microscopyCalibrationTrustText\(series, pixelSpacing\)\]/);
});

test('sourceFileListText names bounded source-file samples', () => {
  assert.equal(sourceFileListText([], { emptyText: '—' }), '—');
  assert.equal(sourceFileListText(['/study/scan.dcm']), 'study/scan.dcm');
  assert.equal(
    sourceFileListText([
      '/study/seq/seq_z001.tif',
      '/study/seq/seq_z002.tif',
      '/study/seq/seq_z003.tif',
    ], { pathSegments: 1 }),
    '3 files (seq_z001.tif, seq_z002.tif, plus 1 more)',
  );
});

test('sourceFileMetadataRow uses plural label for multi-file medical sources', () => {
  assert.equal(sourceFileMetadataRow({}), null);
  assert.deepEqual(
    sourceFileMetadataRow({ sourceFiles: ['/study/scan.dcm'] }),
    ['Source file', 'study/scan.dcm'],
  );
  assert.deepEqual(
    sourceFileMetadataRow({ sourceFiles: ['/study/a.dcm', '/study/b.dcm', '/study/c.dcm'] }),
    ['Source files', '3 files (study/a.dcm, study/b.dcm, plus 1 more)'],
  );
});

test('cloud export sidecars match projection result companions and Ask history filename', () => {
  const series = {
    slug: 'cloud_recon',
    name: 'Cloud Reconstruction',
    description: 'Derived projection volume',
    modality: 'CT',
    width: 4,
    height: 4,
    slices: 2,
    hasRaw: true,
    hasAskHistory: true,
    sourceJobId: 'job_recon',
    sourceProjectionSetId: 'projection_set_1',
    sliceUrlBase: 'https://r2.example/team-a/data/cloud_recon',
    rawUrl: 'https://r2.example/team-a/cloud_recon.raw.zst',
    cloudAction: {
      label: 'Cloud reconstruction',
      jobId: 'job_recon',
      processingMode: 'projection_set_reconstruction',
      inputKind: 'calibrated_projection_set',
      resultStatus: 'partial',
    },
  };
  const manifest = {
    projectionSets: [{
      id: 'projection_set_1',
      projectionKind: 'parallel-beam',
      projectionCount: 120,
      reconstructionStatus: 'reconstructed',
    }],
  };

  const sidecars = cloudSidecarsForSeries(series);
  assert.equal(sidecars.askHistory, 'data/cloud_recon_asks.json');
  assert.equal(sidecars.projectionSet, 'https://r2.example/team-a/results/job_recon/projection_set.json');

  const provenance = cloudProvenanceExportPayload(series, manifest);
  assert.equal(provenance.action.resultStatus, 'partial');
  assert.equal(provenance.outputs.sidecars.projectionSet, 'https://r2.example/team-a/results/job_recon/projection_set.json');
  assert.equal(provenance.sourceProjectionSet.id, 'projection_set_1');
  assert.equal(cloudResultPackagePayload(series, manifest).action.resultStatus, 'partial');

  const asset = cloudResultPackagePayload(series, manifest).assets
    .find(item => item.kind === 'sidecar-projectionSet');
  assert.deepEqual(asset, {
    kind: 'sidecar-projectionSet',
    label: 'projectionSet',
    url: 'https://r2.example/team-a/results/job_recon/projection_set.json',
  });
});

test('cloud export sidecars include registration companion for cloud registration results', () => {
  const series = {
    slug: 'cloud_reg',
    name: 'Registered MR',
    description: 'Moving series aligned into fixed space',
    modality: 'MR',
    width: 4,
    height: 4,
    slices: 2,
    hasRaw: true,
    sourceJobId: 'job_reg',
    engineSourceKind: 'rigid-registration',
    sliceUrlBase: 'https://r2.example/data/cloud_reg',
    rawUrl: 'https://r2.example/cloud_reg.raw.zst',
    registration: {
      source: 'modal:rigid_registration',
      verdict: 'aligned',
    },
    cloudAction: {
      label: 'Cloud registration/alignment',
      jobId: 'job_reg',
      processingMode: 'rigid_registration',
      inputKind: 'dicom_registration_pair',
    },
  };

  assert.equal(
    cloudProvenanceExportPayload(series, {}).outputs.sidecars.registration,
    'https://r2.example/results/job_reg/registration.json',
  );
  assert.deepEqual(
    cloudResultPackagePayload(series, {}).assets.find(item => item.kind === 'sidecar-registration'),
    {
      kind: 'sidecar-registration',
      label: 'registration',
      url: 'https://r2.example/results/job_reg/registration.json',
    },
  );
});
