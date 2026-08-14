import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  microscopyCalibrationSourceText,
  microscopyCalibrationTrustText,
  microscopySequenceOrderText,
  microscopySourceWarningLabels,
  microscopySourceWarningsText,
  microscopyStorageProvenanceText,
} = await import('../js/microscopy/microscopy-provenance-text.js');

test('microscopy provenance warning labels keep known codes and humanize unknown codes', () => {
  const series = {
    microscopyDataset: {
      source: {
        warnings: ['missing_xy_physical_size', 'unsupported_compression'],
      },
    },
    microscopy: {
      sequenceWarnings: ['missing_xy_physical_size', 'mixed-plane-size'],
    },
  };

  assert.deepEqual(microscopySourceWarningLabels(series), [
    'XY spacing missing',
    'Unsupported compression',
    'Mixed plane size',
  ]);
});

test('microscopy provenance warning labels explain TIFF sequence ordering issues', () => {
  assert.deepEqual(
    microscopySourceWarningLabels({
      microscopyDataset: {
        source: {
          warnings: ['missing_plane_index', 'ambiguous_plane_index', 'missing_plane_index_gap'],
        },
      },
    }),
    ['Filename plane index missing', 'Duplicate plane indices', 'Plane index gaps'],
  );
});

test('microscopy provenance warning labels explain OME-Zarr metadata boundaries', () => {
  assert.deepEqual(
    microscopySourceWarningLabels({
      microscopyDataset: {
        source: {
          warnings: [
            'omero_transitional_metadata',
            'omero_channel_count_mismatch',
            'pixel_type_unresolved',
            'axes_spatial_order_not_zyx',
            'multiscales_multiple_entries_first_selected',
            'array_metadata_missing_0',
          ],
        },
      },
    }),
    [
      'OMERO transitional metadata',
      'OMERO channel count mismatch',
      'Pixel type unresolved',
      'Spatial axes are not Z/Y/X',
      'Multiple multiscales entries; first selected',
      'OME-Zarr array metadata missing: 0',
    ],
  );
});

test('microscopy provenance warning labels explain OME-Zarr axis and transform warnings', () => {
  assert.deepEqual(
    microscopySourceWarningLabels({
      microscopyDataset: {
        source: {
          warnings: [
            'axes_x_string_form',
            'axes_axis_2_missing_type',
            'dataset_0_scale_path_unresolved',
            'multiscales_translation_path_unresolved',
          ],
        },
      },
    }),
    [
      'OME-Zarr axis uses string form: x',
      'OME-Zarr axis type missing: axis_2',
      'OME-Zarr scale transform path unresolved: dataset 0',
      'OME-Zarr translation transform path unresolved: multiscales',
    ],
  );
});

test('microscopy provenance warning text caps long warning lists', () => {
  assert.equal(
    microscopySourceWarningsText({
      microscopyDataset: {
        source: {
          warnings: [
            'missing_xy_physical_size',
            'missing_z_physical_size',
            'unsupported_x_physical_unit',
            'unsupported_y_physical_unit',
          ],
        },
      },
    }),
    'XY spacing missing, Z spacing missing, Unsupported X unit, ...',
  );
});

test('microscopy provenance warning text stays explicit when there are no warnings', () => {
  assert.equal(microscopySourceWarningsText({}), 'None');
});

test('microscopy storage provenance exposes local Zarr codec details', () => {
  assert.equal(
    microscopyStorageProvenanceText({
      microscopy: { storageProvenance: 'Local Zarr v2 · level 1 · gzip' },
    }),
    'Local Zarr v2 · level 1 · gzip',
  );
  assert.equal(microscopyStorageProvenanceText({}), '');
});

test('microscopy sequence order text exposes TIFF sequence ordering provenance', () => {
  assert.equal(
    microscopySequenceOrderText({
      microscopyDataset: {
        source: {
          originalFormat: 'TIFF sequence',
          provenance: { orderStrategy: 'numeric-suffix' },
        },
      },
    }),
    'Numeric filename suffix',
  );
  assert.equal(
    microscopySequenceOrderText({
      microscopyDataset: {
        source: {
          originalFormat: 'TIFF sequence',
          provenance: { orderStrategy: 'lexical' },
        },
      },
    }),
    'Lexical filename order',
  );
  assert.equal(
    microscopySequenceOrderText({
      microscopyDataset: {
        source: { originalFormat: 'OME-TIFF' },
      },
    }),
    '',
  );
});

test('microscopy calibration text marks z-stacks with missing z spacing as xy only', () => {
  assert.equal(
    microscopyCalibrationSourceText({
      slices: 4,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 4 }],
        source: { originalFormat: 'OME-Zarr' },
      },
    }, [0.00025, 0.0005]),
    'OME-Zarr metadata (XY only)',
  );
});

test('microscopy calibration trust text names xy-only metadata on z-stacks', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      slices: 4,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 4 }],
        source: { originalFormat: 'OME-Zarr' },
      },
    }, [0.00025, 0.0005]),
    'Trusted metadata · XY trusted, Z unknown',
  );
});

test('microscopy calibration text does not require z spacing for single-plane images', () => {
  assert.equal(
    microscopyCalibrationSourceText({
      slices: 1,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: { originalFormat: 'OME-Zarr' },
      },
    }, [0.00025, 0.0005]),
    'OME-Zarr metadata',
  );
});

test('microscopy calibration text recognizes the imported ImageJ-TIFF format label', () => {
  assert.equal(
    microscopyCalibrationSourceText({
      slices: 1,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: { originalFormat: 'ImageJ-TIFF' },
      },
    }, [0.00025, 0.0005]),
    'ImageJ TIFF metadata',
  );
});

test('microscopy calibration trust text marks single-plane metadata as trusted', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      slices: 1,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: { originalFormat: 'OME-Zarr' },
      },
    }, [0.00025, 0.0005]),
    'Trusted metadata',
  );
});

test('microscopy calibration text marks manual xy-only calibration on stacks', () => {
  assert.equal(
    microscopyCalibrationSourceText({
      slices: 3,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 3 }],
        source: { originalFormat: 'TIFF sequence' },
      },
    }, [0.00025, 0.0005]),
    'Manual calibration (XY only)',
  );
});

test('microscopy calibration trust text distinguishes manual calibration from metadata', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      slices: 3,
      sliceSpacing: 0,
      _sliceSpacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 3 }],
        source: { originalFormat: 'TIFF sequence' },
      },
    }, [0.00025, 0.0005]),
    'Manual calibration · XY trusted, Z unknown',
  );
});

test('microscopy calibration text prefers manual source over file format metadata', () => {
  assert.equal(
    microscopyCalibrationSourceText({
      slices: 1,
      _spacingKnown: true,
      microscopy: { calibrationSource: 'manual' },
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: { originalFormat: 'OME-Zarr' },
      },
    }, [0.00025, 0.0005]),
    'Manual calibration',
  );
});

test('microscopy calibration trust text keeps missing xy spacing explicit', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      _spacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: { originalFormat: 'OME-TIFF' },
      },
    }, [0, 0]),
    'Unknown · XY spacing missing',
  );
});

test('microscopy calibration trust text distinguishes unsupported xy units', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      _spacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: {
          originalFormat: 'OME-TIFF',
          warnings: ['unsupported_x_physical_unit'],
        },
      },
    }, [0, 0]),
    'Unknown · XY unit unsupported',
  );
  assert.equal(
    microscopyCalibrationTrustText({
      _spacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: {
          originalFormat: 'OME-TIFF',
          warnings: ['missing_xy_physical_size'],
        },
      },
    }, [0, 0]),
    'Unknown · XY spacing missing',
  );
});

test('microscopy calibration trust text names rejected non-metric ImageJ resolution', () => {
  assert.equal(
    microscopyCalibrationTrustText({
      _spacingKnown: false,
      microscopyDataset: {
        axes: [{ name: 'z', size: 1 }],
        source: {
          originalFormat: 'ImageJ TIFF',
          warnings: ['missing_xy_physical_size', 'imagej_non_metric_resolution'],
        },
      },
    }, [0, 0]),
    'Unknown · non-metric resolution ignored',
  );
});
