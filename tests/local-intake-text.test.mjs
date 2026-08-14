import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  localFilePath,
  localImportErrorMessage,
  localImportFailedContext,
  localImportFileContext,
  localImportIntakeContext,
  localIntakeNotice,
  localIntakeStatusText,
  microscopyConversionErrorText,
  mixedNativeImportBoundaryText,
} = await import('../js/projects/local-intake-text.js');

test('microscopyConversionErrorText maps stable converter reasons without server output', () => {
  assert.equal(
    microscopyConversionErrorText('cells.czi', 'converter_path_missing'),
    'Could not convert cells.czi: VOXELLAB_BFCONVERT points to a missing executable.',
  );
  assert.equal(
    microscopyConversionErrorText('cells.czi', 'external_process_failure'),
    'Could not convert cells.czi: the external converter failed; check the local server log for details.',
  );
  assert.equal(
    microscopyConversionErrorText('cells.czi', 'unknown_reason'),
    'Could not convert cells.czi: the local microscopy converter could not process it.',
  );
});

test('localFilePath normalizes browser and desktop paths', () => {
  assert.equal(localFilePath({ webkitRelativePath: 'folder\\scan.dcm', name: 'scan.dcm' }), 'folder/scan.dcm');
  assert.equal(localFilePath({ path: '/study/cells.ome.tiff', name: 'cells.ome.tiff' }), '/study/cells.ome.tiff');
});

test('localIntakeNotice preserves selected format labels and skipped samples', () => {
  assert.equal(
    localIntakeNotice(
      { openable: 1, convertible: 1, sidecar: 1 },
      [{ name: 'metadata.json', skipReason: 'unrecognized_json_sidecar' }],
      4,
      {
        openable: [{ name: 'brain.nii' }],
        convertible: [{ name: 'cells.czi' }],
        sidecar: [{ name: 'workflow.json', formatLabel: 'Workflow recipe' }],
      },
    ),
    'Local intake: 1 openable file (NIfTI), 1 converter-backed file (CZI) and 1 sidecar (Workflow recipe); skipped 1 unsupported file (metadata.json (unrecognized JSON sidecar)); checked 4 files. Converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: cells.czi.',
  );
});

test('local intake text names schema-bearing unknown JSON sidecars', () => {
  assert.equal(
    localIntakeNotice(
      { openable: 1, convertible: 0, sidecar: 0 },
      [{ name: 'metadata.json', skipReason: 'unrecognized_json_sidecar', schema: 'example.lab-metadata.v1' }],
      2,
      { openable: [{ name: 'cells.ome.tiff' }], convertible: [], sidecar: [] },
    ),
    'Local intake: 1 openable file (OME-TIFF); skipped 1 unsupported file (metadata.json (unrecognized JSON sidecar schema: example.lab-metadata.v1)); checked 2 files.',
  );
});

test('localIntakeStatusText preserves unsupported-only and converter-backed wording', () => {
  assert.equal(
    localIntakeStatusText({
      files: [],
      skipped: [{ webkitRelativePath: 'study/notes.md' }],
      counts: { openable: 0, convertible: 0, sidecar: 0 },
      checkedFiles: 1,
    }),
    'No supported image, sidecar, or converter-backed files selected after checking 1 file. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files; skipped 1 unsupported file (study/notes.md)',
  );
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'brain.nii' }, { name: 'cells.czi' }],
      skipped: [],
      counts: { openable: 1, convertible: 1, sidecar: 0 },
      formatItems: { openable: [{ name: 'brain.nii' }], convertible: [{ name: 'cells.czi' }], sidecar: [] },
      checkedFiles: 2,
    }),
    '1 openable file (NIfTI) and 1 converter-backed file (CZI) selected after checking 2 files; converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: cells.czi',
  );
});

test('localIntakeStatusText names unavailable local folder entries', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' }],
      skipped: [{ name: 'missing.ome.tif', webkitRelativePath: 'study/missing.ome.tif', skipReason: 'path_unavailable' }],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
      checkedFiles: 2,
    }),
    '1 openable file (DICOM) selected after checking 2 files; skipped 1 unsupported file (study/missing.ome.tif (not found or unreadable))',
  );
});

test('localIntakeStatusText honors explicit skipped totals with bounded samples', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' }],
      skipped: [
        { name: 'notes.md', webkitRelativePath: 'study/notes.md' },
        { name: 'results.csv', webkitRelativePath: 'study/results.csv' },
      ],
      skippedCount: 7,
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
      checkedFiles: 8,
    }),
    '1 openable file (DICOM) selected after checking 8 files; skipped 7 unsupported files (study/notes.md, study/results.csv, plus 5 more files)',
  );
});

test('localIntakeStatusText includes folder read failures and warnings in unsupported-only selections', () => {
  assert.equal(
    localIntakeStatusText({
      files: [],
      skipped: [{ name: 'notes.md', webkitRelativePath: 'study/notes.md' }],
      skippedCount: 4,
      counts: { openable: 0, convertible: 0, sidecar: 0 },
      checkedFiles: 7,
      warnings: [
        { path: '/study/private', reason: 'folder_read_failed' },
        { path: '/study/deep', reason: 'folder_depth_limit' },
      ],
      failedFolderReads: 2,
      warningCount: 3,
    }),
    'No supported image, sidecar, or converter-backed files selected after checking 7 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files; skipped 4 unsupported files (study/notes.md, plus 3 more files); 2 folder reads failed (Could not read folder: private, plus 1 more folder read); 1 folder warning (Scan depth limit: deep)',
  );
});

test('localIntakeStatusText reports desktop file read failures separately from unsupported skips', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'scan.dcm', path: '/study/scan.dcm' }],
      skipped: [{ name: 'notes.md', path: '/study/notes.md' }],
      skippedCount: 1,
      failedFiles: 1,
      failedFileSamples: [{ name: 'a-missing.dcm', path: '/study/a-missing.dcm', reason: 'path_unavailable' }],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
      checkedFiles: 3,
    }),
    '1 openable file (DICOM) selected after checking 3 files; skipped 1 unsupported file (study/notes.md); 1 file read failed (study/a-missing.dcm (not found or unreadable))',
  );
});

test('localIntakeStatusText keeps scan scope for warning-only no-match selections', () => {
  assert.equal(
    localIntakeStatusText({
      files: [],
      skipped: [],
      counts: { openable: 0, convertible: 0, sidecar: 0 },
      checkedFiles: 4,
      warnings: [
        { path: '/study/deep', reason: 'folder_depth_limit' },
      ],
      warningCount: 1,
    }),
    'No supported image, sidecar, or converter-backed files selected after checking 4 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files; 1 folder warning (Scan depth limit: deep)',
  );
});

test('localIntakeStatusText keeps folder warnings visible alongside selected files', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' }],
      skipped: [],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
      checkedFiles: 5,
      warnings: [
        { path: '/study/deep-a', reason: 'folder_depth_limit' },
        { path: '/study/deep-b', reason: 'folder_depth_limit' },
      ],
      warningCount: 2,
    }),
    '1 openable file (DICOM) selected after checking 5 files; 2 folder warnings (Scan depth limit: deep-a, Scan depth limit: deep-b)',
  );
});

test('localIntakeStatusText keeps converter-only guidance concise', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'cells.czi' }],
      skipped: [],
      counts: { openable: 0, convertible: 1, sidecar: 0 },
      formatItems: { openable: [], convertible: [{ name: 'cells.czi' }], sidecar: [] },
      checkedFiles: 1,
    }),
    '1 converter-backed file (CZI) selected after checking 1 file; converter-backed files need configured local readers or an OME-TIFF converter: cells.czi',
  );
});

test('local intake converter guidance caps converter-backed file samples', () => {
  const status = localIntakeStatusText({
    files: [
      { name: 'a.czi' },
      { name: 'b.nd2' },
      { name: 'c.lif' },
      { name: 'd.oib' },
    ],
    skipped: [],
    counts: { openable: 0, convertible: 4, sidecar: 0 },
    formatItems: {
      openable: [],
      convertible: [
        { name: 'a.czi' },
        { name: 'b.nd2' },
        { name: 'c.lif' },
        { name: 'd.oib' },
      ],
      sidecar: [],
    },
    checkedFiles: 4,
  });
  assert.equal(
    status,
    '4 converter-backed files (CZI, ND2, LIF, OIB) selected after checking 4 files; converter-backed files need configured local readers or an OME-TIFF converter: a.czi, b.nd2, c.lif, plus 1 more file',
  );
});

test('localIntakeNotice honors explicit skipped totals with bounded samples', () => {
  assert.equal(
    localIntakeNotice(
      { openable: 1, convertible: 0, sidecar: 0 },
      [
        { name: 'notes.md', webkitRelativePath: 'study/notes.md' },
        { name: 'results.csv', webkitRelativePath: 'study/results.csv' },
      ],
      8,
      { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
      7,
    ),
    'Local intake: 1 openable file (DICOM); skipped 7 unsupported files (study/notes.md, study/results.csv, plus 5 more files); checked 8 files.',
  );
});

test('localIntakeNotice names hidden skipped sample counts', () => {
  const skipped = Array.from({ length: 7 }, (_, index) => ({
    name: `notes-${index}.md`,
    webkitRelativePath: `study/notes-${index}.md`,
  }));
  assert.equal(
    localIntakeNotice(
      { openable: 1, convertible: 0, sidecar: 0 },
      skipped,
      8,
      { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    ),
    'Local intake: 1 openable file (DICOM); skipped 7 unsupported files (study/notes-0.md, study/notes-1.md, study/notes-2.md, study/notes-3.md, study/notes-4.md, plus 2 more files); checked 8 files.',
  );
});

test('localIntakeStatusText names DICOM SR sidecars as sidecars', () => {
  assert.equal(
    localIntakeStatusText({
      files: [{ name: 'measurements.sr', formatLabel: 'DICOM SR' }],
      skipped: [],
      counts: { openable: 0, convertible: 0, sidecar: 1 },
      formatItems: { openable: [], convertible: [], sidecar: [{ name: 'measurements.sr', formatLabel: 'DICOM SR' }] },
      checkedFiles: 1,
    }),
    '1 sidecar (DICOM SR) selected after checking 1 file',
  );
});

test('localImportIntakeContext separates folder read failures from folder warnings', () => {
  assert.equal(
    localImportIntakeContext({
      checkedFiles: 4,
      skipped: [{ name: 'notes.md' }],
      skippedCount: 1,
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'broken-supported.dcm' }] },
      warnings: [
        { path: '/study/private-folder', reason: 'folder_read_failed' },
        { path: '/study/deep', reason: 'folder_depth_limit' },
      ],
      warningCount: 2,
      failedFolderReads: 1,
    }),
    ' Intake: checked 4 files; selected 1 openable file (DICOM); skipped 1 unsupported file (notes.md); 1 folder read failed (Could not read folder: private-folder); 1 folder warning (Scan depth limit: deep).',
  );
});

test('localImportIntakeContext separates file read failures from unsupported skips', () => {
  assert.equal(
    localImportIntakeContext({
      checkedFiles: 4,
      skipped: [{ name: 'notes.md' }],
      skippedCount: 1,
      failedFiles: 1,
      failedFileSamples: [{ name: 'a-missing.dcm', path: '/study/a-missing.dcm', reason: 'path_unavailable' }],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'broken-supported.dcm' }] },
    }),
    ' Intake: checked 4 files; selected 1 openable file (DICOM); skipped 1 unsupported file (notes.md); 1 file read failed (study/a-missing.dcm (not found or unreadable)).',
  );
});

test('localImportIntakeContext counts fallback folder warnings after read failures', () => {
  assert.equal(
    localImportIntakeContext({
      checkedFiles: 4,
      skipped: [],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'broken-supported.dcm' }] },
      warnings: [
        { path: '/study/private-folder', reason: 'folder_read_failed' },
        { path: '/study/deep', reason: 'folder_depth_limit' },
      ],
    }),
    ' Intake: checked 4 files; selected 1 openable file (DICOM); 1 folder read failed (Could not read folder: private-folder); 1 folder warning (Scan depth limit: deep).',
  );
});

test('localImportIntakeContext names hidden folder read failure counts', () => {
  assert.equal(
    localImportIntakeContext({
      checkedFiles: 9,
      skipped: [],
      counts: { openable: 1, convertible: 0, sidecar: 0 },
      formatItems: { openable: [{ name: 'broken-supported.dcm' }] },
      warnings: [
        { path: '/study/private-0', reason: 'folder_read_failed' },
        { path: '/study/private-1', reason: 'folder_read_failed' },
        { path: '/study/private-2', reason: 'folder_read_failed' },
        { path: '/study/private-3', reason: 'folder_read_failed' },
        { path: '/study/private-4', reason: 'folder_read_failed' },
        { path: '/study/private-5', reason: 'folder_read_failed' },
      ],
      warningCount: 6,
      failedFolderReads: 6,
    }),
    ' Intake: checked 9 files; selected 1 openable file (DICOM); 6 folder reads failed (Could not read folder: private-0, Could not read folder: private-1, Could not read folder: private-2, Could not read folder: private-3, Could not read folder: private-4, plus 1 more folder read).',
  );
});

test('localImportErrorMessage keeps selected and intake context together', () => {
  assert.equal(
    localImportErrorMessage(
      new Error('Import failed.'),
      [{ path: '/study/broken-supported.dcm', name: 'broken-supported.dcm' }],
      {
        checkedFiles: 2,
        skipped: [{ name: 'notes.md' }],
        counts: { openable: 1, convertible: 0, sidecar: 0 },
        formatItems: { openable: [{ name: 'broken-supported.dcm' }] },
      },
    ),
    'Import failed. Selected file: study/broken-supported.dcm. Intake: checked 2 files; selected 1 openable file (DICOM); skipped 1 unsupported file (notes.md).',
  );
});

test('localImportErrorMessage explains converter-backed files were not opened by a failed import', () => {
  assert.equal(
    localImportErrorMessage(
      new Error('Import failed.'),
      [{ path: '/study/broken-supported.dcm', name: 'broken-supported.dcm' }],
      {
        checkedFiles: 2,
        skipped: [],
        counts: { openable: 1, convertible: 1, sidecar: 0 },
        formatItems: {
          openable: [{ name: 'broken-supported.dcm' }],
          convertible: [{ name: 'cells.czi' }],
          sidecar: [],
        },
      },
    ),
    'Import failed. Selected file: study/broken-supported.dcm. Intake: checked 2 files; selected 1 openable file (DICOM) and 1 converter-backed file (CZI); converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: cells.czi.',
  );
});

test('mixedNativeImportBoundaryText names native image families and samples', () => {
  assert.equal(
    mixedNativeImportBoundaryText([
      { webkitRelativePath: 'study/brain.nii', name: 'brain.nii' },
      { webkitRelativePath: 'study/cells.ome.tiff', name: 'cells.ome.tiff' },
      { webkitRelativePath: 'study/roi/overlay.sr', name: 'overlay.sr' },
    ]),
    'Mixed native image families need separate imports for now. Selected openable families: 1 NIfTI file (study/brain.nii), 1 microscopy TIFF file (study/cells.ome.tiff) and 1 DICOM or derived-object file (roi/overlay.sr). Open one family at a time so calibration, sidecars, and geometry stay tied to the right source data.',
  );
});

test('localImportFailedContext caps attempted file samples', () => {
  const files = Array.from({ length: 7 }, (_, index) => ({ name: `file-${index}.dcm` }));
  assert.equal(
    localImportFailedContext(files),
    ' Failed 7 attempted files: file-0.dcm, file-1.dcm, file-2.dcm, file-3.dcm, file-4.dcm, plus 2 more files.',
  );
});

test('localImportFileContext names hidden selected file counts', () => {
  const files = Array.from({ length: 6 }, (_, index) => ({ name: `file-${index}.dcm` }));
  assert.equal(
    localImportFileContext(files),
    ' Selected files: file-0.dcm, file-1.dcm, file-2.dcm, plus 3 more files.',
  );
});
