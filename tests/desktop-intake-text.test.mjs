import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  desktopConversionDialogText,
  desktopDerivedSidecarOnlyText,
  desktopIntakeNotice,
  desktopMicroscopySidecarOnlyText,
  unsupportedDesktopSelectionText,
} = await import('../js/desktop-intake-text.js');

test('desktopIntakeNotice names skipped files and folder warning reasons', () => {
  const payload = {
    warnings: [
      { path: '/study/deep-folder', reason: 'folder_depth_limit' },
      { path: '/study/private', reason: 'folder_read_failed' },
    ],
    folderSummary: {
      scannedFiles: 9,
      skippedUnsupportedFiles: 2,
      skippedUnsupportedSamples: [
        { relativePath: 'study/notes.md' },
        { relativePath: 'study/report.csv' },
      ],
      warningCount: 2,
    },
  };

  assert.equal(
    desktopIntakeNotice(
      payload,
      [{ name: 'scan.dcm' }],
      [{ name: 'cells.roi' }],
      [{ name: 'cells.czi' }],
      [],
    ),
    'Desktop intake: scanned 9 files, 1 openable file (DICOM), 1 sidecar (ImageJ ROI), 1 converter-backed file (CZI), 2 unsupported files skipped, 1 folder read failed, 1 folder warning (study/notes.md, study/report.csv, Could not read folder: private, plus 1 more item).',
  );
});

test('desktopIntakeNotice explains unrecognized JSON sidecars without noisy generic reasons', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        folderSummary: {
          scannedFiles: 3,
          skippedUnsupportedFiles: 2,
          skippedUnsupportedSamples: [
            { relativePath: 'study/metadata.json', reason: 'unrecognized_json_sidecar' },
            { relativePath: 'study/notes.md', reason: 'unsupported_extension' },
          ],
          warningCount: 0,
        },
      },
      [{ name: 'cells.ome.tiff' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 3 files, 1 openable file (OME-TIFF), 2 unsupported files skipped (study/metadata.json (unrecognized JSON sidecar), study/notes.md).',
  );
});

test('desktopIntakeNotice names schema-bearing unknown JSON sidecars', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        folderSummary: {
          scannedFiles: 2,
          skippedUnsupportedFiles: 1,
          skippedUnsupportedSamples: [
            {
              relativePath: 'study/unknown-sidecar.json',
              reason: 'unrecognized_json_sidecar',
              schema: 'example.not-roi-results.v1',
            },
          ],
          warningCount: 0,
        },
      },
      [{ name: 'cells.ome.tiff' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 2 files, 1 openable file (OME-TIFF), 1 unsupported file skipped (study/unknown-sidecar.json (unrecognized JSON sidecar schema: example.not-roi-results.v1)).',
  );
});

test('desktopIntakeNotice distinguishes invalid JSON sidecars', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        folderSummary: {
          scannedFiles: 2,
          skippedUnsupportedFiles: 1,
          skippedUnsupportedSamples: [
            { relativePath: 'study/broken.json', reason: 'invalid_json_sidecar' },
          ],
          warningCount: 0,
        },
      },
      [{ name: 'cells.ome.tiff' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 2 files, 1 openable file (OME-TIFF), 1 unsupported file skipped (study/broken.json (invalid JSON sidecar)).',
  );
});

test('desktopIntakeNotice reports unreadable candidate files as failed reads', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        folderSummary: {
          scannedFiles: 3,
          skippedUnsupportedFiles: 1,
          skippedUnsupportedSamples: [
            { relativePath: 'study/notes.md', reason: 'unsupported_extension' },
          ],
          failedFiles: 1,
          failedFileSamples: [
            { relativePath: 'study/a-missing.dcm', reason: 'path_unavailable' },
          ],
          warningCount: 0,
        },
      },
      [{ name: 'cells.ome.tiff' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 3 files, 1 openable file (OME-TIFF), 1 unsupported file skipped, 1 file read failed (study/notes.md, study/a-missing.dcm (not found or unreadable)).',
  );
});

test('desktopIntakeNotice reports simple folder scan scope without noisy single-file opens', () => {
  assert.equal(
    desktopIntakeNotice(
      { folderSummary: { scannedFiles: 1, skippedUnsupportedFiles: 0, warningCount: 0 } },
      [{ name: 'scan.dcm' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 1 file, 1 openable file (DICOM).',
  );
});

test('desktopIntakeNotice does not count unsupported folder records as files', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        warnings: [{ path: '/study/bad-folder', reason: 'folder_empty_or_unsupported' }],
        folderSummary: {
          scannedFiles: 3,
          skippedUnsupportedFiles: 2,
          skippedUnsupportedSamples: [
            { relativePath: 'bad-folder/notes.md' },
            { relativePath: 'bad-folder/results.csv' },
          ],
          warningCount: 1,
        },
      },
      [{ name: 'scan.dcm' }],
      [],
      [],
      [{ name: 'bad-folder', kind: 'folder', reason: 'folder_empty_or_unsupported' }],
    ),
    'Desktop intake: scanned 3 files, 1 openable file (DICOM), 2 unsupported files skipped, 1 folder warning (bad-folder/notes.md, bad-folder/results.csv, No supported files found: bad-folder).',
  );
});

test('desktopIntakeNotice explains bounded folder scans as stopped at the file limit', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        warnings: [{ path: '/study/huge-folder', reason: 'folder_file_limit' }],
        folderSummary: {
          scannedFiles: 10000,
          skippedUnsupportedFiles: 9999,
          skippedUnsupportedSamples: [
            { relativePath: 'huge-folder/notes.md' },
          ],
          warningCount: 1,
        },
      },
      [{ name: 'scan.dcm' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 10000 files, 1 openable file (DICOM), 9999 unsupported files skipped, 1 folder warning (huge-folder/notes.md, Scan stopped at file limit: huge-folder, plus 9998 more items).',
  );
});

test('desktopIntakeNotice names hidden warning sample counts', () => {
  assert.equal(
    desktopIntakeNotice(
      {
        warnings: [
          { path: '/study/deep-a', reason: 'folder_depth_limit' },
          { path: '/study/deep-b', reason: 'folder_depth_limit' },
          { path: '/study/deep-c', reason: 'folder_depth_limit' },
          { path: '/study/deep-d', reason: 'folder_depth_limit' },
        ],
        folderSummary: {
          scannedFiles: 12,
          skippedUnsupportedFiles: 0,
          warningCount: 4,
        },
      },
      [{ name: 'scan.dcm' }],
      [],
      [],
      [],
    ),
    'Desktop intake: scanned 12 files, 1 openable file (DICOM), 4 folder warnings (Scan depth limit: deep-a, Scan depth limit: deep-b, Scan depth limit: deep-c, plus 1 more item).',
  );
});

test('unsupportedDesktopSelectionText explains unsupported-only folder warnings', () => {
  const payload = {
    sourceFolders: ['/study/bad-folder'],
    warnings: [
      { path: '/study/bad-folder', reason: 'folder_read_failed' },
    ],
    folderSummary: {
      skippedUnsupportedFiles: 1,
      skippedUnsupportedSamples: [
        { relativePath: 'bad-folder/notes.md' },
      ],
      warningCount: 1,
    },
  };

  assert.equal(
    unsupportedDesktopSelectionText(payload, [{ name: 'bad-folder', reason: 'folder_empty_or_unsupported' }]),
    'No supported image, sidecar, or converter-backed files were found in bad-folder. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files. Skipped unsupported files: bad-folder/notes.md. Folder read failures: Could not read folder: bad-folder.',
  );
});

test('unsupportedDesktopSelectionText reports hidden folder and warning counts from summary', () => {
  const payload = {
    sourceFolders: ['/study/bad-a', '/study/bad-b', '/study/bad-c'],
    warnings: [
      { path: '/study/bad-a', reason: 'folder_read_failed' },
      { path: '/study/bad-c', reason: 'folder_depth_limit' },
    ],
    folderSummary: {
      scannedFiles: 7,
      skippedUnsupportedFiles: 3,
      skippedUnsupportedSamples: [
        { relativePath: 'bad-a/notes.md' },
      ],
      failedFolderReads: 3,
      warningCount: 5,
    },
  };

  assert.equal(
    unsupportedDesktopSelectionText(payload, []),
    'No supported image, sidecar, or converter-backed files were found in bad-a, bad-b, plus 1 more folder after scanning 7 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files. Skipped unsupported files: bad-a/notes.md, plus 2 more files. Folder read failures: Could not read folder: bad-a, plus 2 more folder reads. Folder warnings: Scan depth limit: bad-c, plus 1 more warning.',
  );
});

test('unsupportedDesktopSelectionText names unavailable desktop paths', () => {
  assert.equal(
    unsupportedDesktopSelectionText({}, [
      { name: 'missing-extensionless-dicom', reason: 'path_unavailable' },
    ]),
    'VoxelLab cannot open: missing-extensionless-dicom (not found or unreadable). Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.',
  );
});

test('unsupportedDesktopSelectionText bounds direct unsupported desktop selections', () => {
  assert.equal(
    unsupportedDesktopSelectionText({}, [
      { name: 'notes-0.md' },
      { name: 'notes-1.md' },
      { name: 'notes-2.md' },
      { name: 'notes-3.md' },
      { name: 'notes-4.md' },
      { name: 'notes-5.md' },
      { name: 'notes-6.md' },
    ]),
    'VoxelLab cannot open: notes-0.md, notes-1.md, notes-2.md, notes-3.md, notes-4.md, plus 2 more files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.',
  );
});

test('unsupportedDesktopSelectionText explains when a folder scan stopped at the file limit', () => {
  const payload = {
    sourceFolders: ['/study/huge-folder'],
    warnings: [
      { path: '/study/huge-folder', reason: 'folder_file_limit' },
    ],
    folderSummary: {
      scannedFiles: 10000,
      skippedUnsupportedFiles: 10000,
      skippedUnsupportedSamples: [
        { relativePath: 'huge-folder/notes.md' },
      ],
      warningCount: 1,
    },
  };

  assert.equal(
    unsupportedDesktopSelectionText(payload, [{ name: 'huge-folder', kind: 'folder', reason: 'folder_empty_or_unsupported' }]),
    'No supported image, sidecar, or converter-backed files were found in huge-folder after scanning 10000 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files. Skipped unsupported files: huge-folder/notes.md, plus 9999 more files. Folder warnings: Scan stopped at file limit: huge-folder.',
  );
});

test('unsupportedDesktopSelectionText reports file read failures separately from unsupported files', () => {
  const payload = {
    sourceFolders: ['/study/bad-folder'],
    folderSummary: {
      scannedFiles: 2,
      skippedUnsupportedFiles: 1,
      skippedUnsupportedSamples: [
        { relativePath: 'bad-folder/notes.md' },
      ],
      failedFiles: 1,
      failedFileSamples: [
        { relativePath: 'bad-folder/a-missing.dcm', reason: 'path_unavailable' },
      ],
      warningCount: 0,
    },
  };

  assert.equal(
    unsupportedDesktopSelectionText(payload, [{ name: 'bad-folder', kind: 'folder', reason: 'folder_empty_or_unsupported' }]),
    'No supported image, sidecar, or converter-backed files were found in bad-folder after scanning 2 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files. Skipped unsupported files: bad-folder/notes.md. File read failures: bad-folder/a-missing.dcm (not found or unreadable).',
  );
});

test('unsupportedDesktopSelectionText reports scan scope when no folder item opens', () => {
  const payload = {
    sourceFolders: ['/study/bad-folder'],
    folderSummary: {
      scannedFiles: 3,
      skippedUnsupportedFiles: 3,
      skippedUnsupportedSamples: [
        { relativePath: 'bad-folder/notes.md' },
      ],
      warningCount: 0,
    },
  };

  assert.equal(
    unsupportedDesktopSelectionText(payload, [{ name: 'bad-folder', reason: 'folder_empty_or_unsupported' }]),
    'No supported image, sidecar, or converter-backed files were found in bad-folder after scanning 3 files. Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files. Skipped unsupported files: bad-folder/notes.md, plus 2 more files.',
  );
});

test('desktopIntakeNotice stays quiet for a simple supported file open', () => {
  assert.equal(
    desktopIntakeNotice({}, [{ name: 'scan.dcm' }], [], [], []),
    '',
  );
});

test('desktopMicroscopySidecarOnlyText explains standalone microscopy sidecars', () => {
  assert.equal(
    desktopMicroscopySidecarOnlyText([{ name: 'workflow.json' }, { name: 'cells.roi' }]),
    'Sidecar files are not standalone images. Open the matching microscopy image first, then open the sidecar again. Selected sidecars: workflow.json, cells.roi.',
  );
});

test('desktopMicroscopySidecarOnlyText names hidden sidecar file counts', () => {
  assert.equal(
    desktopMicroscopySidecarOnlyText([
      { name: 'workflow.json' },
      { name: 'cells.roi' },
      { name: 'angles.roi' },
      { name: 'points.roi' },
      { name: 'results.json' },
      { name: 'extra.roi' },
    ]),
    'Sidecar files are not standalone images. Open the matching microscopy image first, then open the sidecar again. Selected sidecars: workflow.json, cells.roi, angles.roi, points.roi, results.json, plus 1 more file.',
  );
});

test('desktopConversionDialogText bounds converter-backed desktop file samples', () => {
  assert.equal(
    desktopConversionDialogText(
      [{ name: 'a.czi' }, { name: 'b.nd2' }, { name: 'c.lif' }, { name: 'd.oib' }],
      [],
    ),
    'Converting 4 desktop files to OME-TIFF: a.czi, b.nd2, c.lif, plus 1 more file. Converted outputs reopen automatically.',
  );
  assert.equal(
    desktopConversionDialogText(
      [],
      [{ name: 'a.czi' }, { name: 'b.nd2' }, { name: 'c.lif' }, { name: 'd.oib' }],
    ),
    'Configure an OME-TIFF converter before opening 4 converter-backed files: a.czi, b.nd2, c.lif, plus 1 more file.',
  );
  assert.equal(
    desktopConversionDialogText(
      [{ path: '/study/a.czi' }],
      [{ relativePath: 'study/b.nd2' }],
    ),
    'Converting 1 desktop file to OME-TIFF: a.czi. Converted outputs reopen automatically. Configure an OME-TIFF converter before opening 1 converter-backed file: b.nd2.',
  );
});

test('desktopDerivedSidecarOnlyText explains standalone DICOM SR sidecars', () => {
  assert.equal(
    desktopDerivedSidecarOnlyText([{ name: 'measurements.sr' }]),
    'DICOM SR files are derived objects, not standalone images. Open the matching source DICOM series first, then open the SR file again. Selected sidecar: measurements.sr.',
  );
});

test('unsupportedDesktopSelectionText explains selected unrecognized JSON sidecars', () => {
  assert.equal(
    unsupportedDesktopSelectionText({}, [{ name: 'metadata.json', reason: 'unrecognized_json_sidecar' }]),
    'VoxelLab cannot open: metadata.json (unrecognized JSON sidecar). Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.',
  );
  assert.equal(
    unsupportedDesktopSelectionText({}, [{ name: 'metadata.json', reason: 'unrecognized_json_sidecar', schema: 'example.lab-metadata.v1' }]),
    'VoxelLab cannot open: metadata.json (unrecognized JSON sidecar schema: example.lab-metadata.v1). Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.',
  );
});

test('unsupportedDesktopSelectionText explains selected invalid JSON sidecars', () => {
  assert.equal(
    unsupportedDesktopSelectionText({}, [{ name: 'broken.json', reason: 'invalid_json_sidecar' }]),
    'VoxelLab cannot open: broken.json (invalid JSON sidecar). Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.',
  );
});
