import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const {
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
