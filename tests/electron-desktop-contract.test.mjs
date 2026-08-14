/* global Buffer, Request, Response */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const {
  APP_HOST,
  APP_SCHEME,
  DESKTOP_OPEN_FILE_FILTER_EXTENSIONS,
  DESKTOP_SIDECAR_INPUT_EXTENSIONS,
  DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS,
  IPC,
  desktopInputFormatLabel,
  isConvertibleInputPath,
  isSupportedInputPath,
  openPathsPayload,
} = await import('../electron/shared/desktop-contracts.js');
const {
  ConverterJobManager,
} = await import('../electron/main/converter-jobs.js');
const {
  clearCloudSettings,
  handleDesktopCloudRequest,
  saveCloudSettings,
} = await import('../electron/main/cloud-settings.js');
const {
  isTrustedExternalUrl,
} = await import('../electron/main/external-urls.js');
const {
  desktopLocalApiTarget,
  handleDesktopLocalApiRequest,
} = await import('../electron/main/local-api-proxy.js');
const {
  EMPTY_DESKTOP_MANIFEST,
  resolveStaticAssetPath,
} = await import('../electron/main/static-protocol.js');
const {
  collectSupportedFolderFiles,
  MAX_NATIVE_PATH_STAT_CONCURRENCY,
  nativePathItem,
  nativePathItems,
  openFolderPayload,
  readNativeFileRange,
} = await import('../electron/main/native-paths.js');
const {
  desktopFileFromRecord,
} = await import('../js/desktop-path-file.js');
const {
  parseOmeZarrFiles,
} = await import('../js/microscopy/microscopy-zarr-import.js');
const {
  launchPathsFromArgv,
} = await import('../electron/main/launch-paths.js');
const {
  handleWindowsSquirrelEvent,
  windowsFileAssociationCommands,
} = await import('../electron/main/windows-file-associations.js');
const {
  clearRecentDocuments,
  readRecentDocuments,
  rememberRecentDocuments,
  removeRecentDocuments,
} = await import('../electron/main/recent-documents.js');

function waitForConversionStatus(manager, id, expected) {
  const statuses = new Set(Array.isArray(expected) ? expected : [expected]);
  return new Promise((resolve) => {
    const onChange = (snapshot) => {
      if (snapshot.id !== id || !statuses.has(snapshot.status)) return;
      manager.off('changed', onChange);
      resolve(snapshot);
    };
    manager.on('changed', onChange);
    const current = manager.get(id);
    if (current && statuses.has(current.status)) onChange(current);
  });
}

test('desktop open contract accepts current VoxelLab input families', () => {
  assert.equal(isSupportedInputPath('/study/IM0001'), true);
  assert.equal(isSupportedInputPath('/study/scan.dcm'), true);
  assert.equal(isSupportedInputPath('/study/volume.nii.gz'), true);
  assert.equal(isSupportedInputPath('/study/notes.gz'), false);
  assert.equal(isSupportedInputPath('/study/model.obj.gz'), false);
  assert.equal(isSupportedInputPath('/study/cells.ome.tiff'), true);
  assert.equal(isSupportedInputPath('/study/cells.roi'), true);
  assert.equal(isSupportedInputPath('/study/cells-rois.zip'), true);
  assert.deepEqual(DESKTOP_SIDECAR_INPUT_EXTENSIONS, ['.json', '.roi', '.sr', '.zip']);
  assert.deepEqual(DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS, ['json', 'roi', 'sr', 'zip']);
  assert.equal(isSupportedInputPath('/study/cells.zarr/.zattrs'), true);
  assert.equal(isSupportedInputPath('/study/cells.zarr/.zgroup'), true);
  assert.equal(isSupportedInputPath('/study/cells.zarr/zarr.json'), true);
  assert.equal(isSupportedInputPath('/study/cells.zarr/0/zarr.json'), true);
  assert.equal(isSupportedInputPath('/study/cells.zarr/.hidden'), false);
  assert.equal(isSupportedInputPath('/study/cells.zarr/.git/config'), false);
  assert.equal(isSupportedInputPath('/study/.git/cells.zarr/.zattrs'), false);
  assert.equal(isSupportedInputPath('/study/__MACOSX/cells.ome.tif'), false);
  assert.equal(isSupportedInputPath('/study/cells.zarr/0/0.0.0'), true);
  assert.equal(isSupportedInputPath('/study/cells.zarr/notes.md'), false);
  assert.equal(isSupportedInputPath('/study/cells.zarr/.DS_Store'), false);
  assert.equal(isSupportedInputPath('/study/cells.czi'), false);
  assert.equal(isConvertibleInputPath('/study/cells.czi'), true);
  assert.equal(isConvertibleInputPath('/study/cells.oib'), true);
  assert.equal(isConvertibleInputPath('/study/cells.oif'), true);
  assert.equal(isConvertibleInputPath('/study/cells.lsm'), true);
  assert.equal(isConvertibleInputPath('/study/._cells.czi'), false);
  assert.equal(isConvertibleInputPath('/study/.DS_Store'), false);
  assert.equal(isConvertibleInputPath('/study/.ipynb_checkpoints/cells.czi'), false);
  assert.equal(isSupportedInputPath('/study/report.sr'), true);
  assert.equal(isSupportedInputPath('/study/results.csv'), false);
  assert.equal(isSupportedInputPath('/Applications/tool.exe'), false);
  assert.equal(isSupportedInputPath('/dataset', { isDirectory: true }), false);
  assert.ok(DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes('oib'));
  assert.ok(DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes('oif'));
  assert.ok(DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes('lsm'));
  assert.equal(DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes('csv'), false);
});

test('desktop path records carry user-facing format labels for intake summaries', () => {
  assert.equal(desktopInputFormatLabel('/study/IM0001'), 'DICOM');
  assert.equal(desktopInputFormatLabel('/study/scan.dcm'), 'DICOM');
  assert.equal(desktopInputFormatLabel('/study/volume.nii.gz'), 'NIfTI');
  assert.equal(desktopInputFormatLabel('/study/cells.ome.tiff'), 'OME-TIFF');
  assert.equal(desktopInputFormatLabel('/study/cells.zarr/.zattrs'), 'OME-Zarr');
  assert.equal(desktopInputFormatLabel('/study/cells.zarr/zarr.json'), 'OME-Zarr');
  assert.equal(desktopInputFormatLabel('/study/cells.zarr/0/0.0.0'), 'OME-Zarr');
  assert.equal(desktopInputFormatLabel('/study/cells.roi'), 'ImageJ ROI');
  assert.equal(desktopInputFormatLabel('/study/measurements.sr'), 'DICOM SR');
  assert.equal(desktopInputFormatLabel('/study/cells.nd2'), 'ND2');
  assert.equal(desktopInputFormatLabel('/study/results.csv'), '');

  const payload = openPathsPayload([
    '/study/scan.dcm',
    '/study/volume.nii.gz',
    '/study/cells.zarr/zarr.json',
    '/study/cells.nd2',
    '/study/results.csv',
  ]);

  assert.deepEqual(payload.supported.map(item => [item.name, item.formatLabel]), [
    ['scan.dcm', 'DICOM'],
    ['volume.nii.gz', 'NIfTI'],
    ['zarr.json', 'OME-Zarr'],
  ]);
  assert.deepEqual(payload.convertible.map(item => [item.name, item.formatLabel]), [
    ['cells.nd2', 'ND2'],
  ]);
  assert.equal('formatLabel' in payload.unsupported[0], false);
});

test('desktop open payload separates supported and unsupported paths', () => {
  const payload = openPathsPayload([
    '/study/scan.dcm',
    '/study/cells.roi',
    '/study/cells-rois.zip',
    '/study/cells.czi',
    '/study/cells.lsm',
    '/study/readme.md',
    { path: '/study/folder', isDirectory: true },
  ]);

  assert.equal(payload.apiVersion, 1);
  assert.equal(payload.records.length, 7);
  assert.deepEqual(payload.supported.map(item => item.name), ['scan.dcm', 'cells.roi', 'cells-rois.zip']);
  assert.deepEqual(payload.convertible.map(item => item.name), ['cells.czi', 'cells.lsm']);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['unsupported_extension', 'folder_empty_or_unsupported']);
});

test('desktop folder import expands folders into supported and convertible files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-folder-import-'));
  const nested = path.join(root, 'series');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root, 'scan.dcm'), 'dicom');
  await fs.writeFile(path.join(root, 'cells.czi'), 'fake czi');
  await fs.writeFile(path.join(root, 'cells.oib'), 'fake oib');
  await fs.writeFile(path.join(root, 'cells.oif'), 'fake oif');
  await fs.writeFile(path.join(root, 'cells.lsm'), 'fake lsm');
  await fs.writeFile(path.join(root, '._cells.czi'), 'resource fork');
  await fs.writeFile(path.join(root, 'cells.roi'), 'roi');
  await fs.writeFile(path.join(root, 'cells-rois.zip'), 'zip');
  await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify({ lab: 'example' }));
  await fs.writeFile(path.join(root, 'unknown-sidecar.json'), JSON.stringify({ schema: 'example.not-roi-results.v1' }));
  await fs.writeFile(path.join(root, 'broken.json'), '{not json');
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');
  await fs.writeFile(path.join(root, 'workflow.json'), JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await fs.writeFile(path.join(root, '.DS_Store'), 'junk');
  await fs.writeFile(path.join(root, '._scan.dcm'), 'junk');
  const macosx = path.join(root, '__MACOSX');
  await fs.mkdir(macosx);
  await fs.writeFile(path.join(macosx, 'resource.ome.tif'), 'junk');
  await fs.writeFile(path.join(nested, 'plane.ome.tif'), 'tiff');

  const { files, warnings, summary } = await collectSupportedFolderFiles([root]);
  const payload = openFolderPayload([root], files, warnings, summary);

  assert.deepEqual(
    payload.supported.map(item => item.name),
    ['cells-rois.zip', 'cells.roi', 'scan.dcm', 'plane.ome.tif', 'workflow.json'],
  );
  assert.equal(payload.supported.find(item => item.name === 'workflow.json')?.formatLabel, 'Workflow recipe');
  assert.deepEqual(payload.convertible.map(item => item.name), ['cells.czi', 'cells.lsm', 'cells.oib', 'cells.oif']);
  assert.deepEqual(payload.unsupported, []);
  assert.equal(payload.folderSummary.scannedFiles, 13);
  assert.equal(payload.folderSummary.supportedFiles, 5);
  assert.equal(payload.folderSummary.convertibleFiles, 4);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 4);
  assert.deepEqual(payload.folderSummary.skippedUnsupportedSamples.map(item => [item.name, item.reason]), [
    ['broken.json', 'invalid_json_sidecar'],
    ['metadata.json', 'unrecognized_json_sidecar'],
    ['notes.md', 'unsupported_extension'],
    ['unknown-sidecar.json', 'unrecognized_json_sidecar'],
  ]);
  assert.equal(
    payload.folderSummary.skippedUnsupportedSamples.find(item => item.name === 'unknown-sidecar.json')?.schema,
    'example.not-roi-results.v1',
  );
  const scanRecord = payload.supported.find(item => item.name === 'scan.dcm');
  assert.equal(scanRecord?.size, 5);
  assert.equal(Number.isFinite(scanRecord?.lastModified), true);
  assert.equal(scanRecord?.relativePath, `${path.basename(root)}/scan.dcm`);
  assert.deepEqual(payload.sourceFolders, [root]);
  assert.equal(payload.warnings.length, 0);
});

test('desktop folder import preserves OME-Zarr metadata and dotted chunks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-zarr-folder-'));
  const zarrRoot = path.join(root, 'cells.zarr');
  const level = path.join(zarrRoot, '0');
  await fs.mkdir(level, { recursive: true });
  await fs.writeFile(path.join(zarrRoot, '.zattrs'), '{}');
  await fs.writeFile(path.join(zarrRoot, '.zgroup'), '{}');
  await fs.writeFile(path.join(zarrRoot, '.zmetadata'), '{}');
  await fs.writeFile(path.join(zarrRoot, 'zarr.json'), '{}');
  await fs.writeFile(path.join(zarrRoot, '.hidden'), 'junk');
  await fs.writeFile(path.join(zarrRoot, '.DS_Store'), 'junk');
  const hiddenDir = path.join(zarrRoot, '.git');
  await fs.mkdir(hiddenDir);
  await fs.writeFile(path.join(hiddenDir, 'config'), 'junk');
  await fs.writeFile(path.join(level, '.zarray'), '{}');
  await fs.writeFile(path.join(level, 'zarr.json'), '{}');
  await fs.writeFile(path.join(level, '0.0.0'), 'chunk');

  const { files, warnings, summary } = await collectSupportedFolderFiles([zarrRoot]);
  const payload = openFolderPayload([zarrRoot], files, warnings, summary);
  const relativePaths = payload.supported
    .map(item => path.relative(zarrRoot, item.path).replaceAll(path.sep, '/'))
    .sort();

  assert.deepEqual(relativePaths, ['.zattrs', '.zgroup', '.zmetadata', '0/.zarray', '0/0.0.0', '0/zarr.json', 'zarr.json']);
  assert.deepEqual(
    payload.supported.map(item => item.relativePath).sort(),
    ['cells.zarr/.zattrs', 'cells.zarr/.zgroup', 'cells.zarr/.zmetadata', 'cells.zarr/0/.zarray', 'cells.zarr/0/0.0.0', 'cells.zarr/0/zarr.json', 'cells.zarr/zarr.json'],
  );
  assert.deepEqual(payload.unsupported, []);
  assert.deepEqual(payload.sourceFolders, [zarrRoot]);
  assert.equal(payload.warnings.length, 0);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 0);
});

test('desktop folder OME-Zarr records parse through the browser importer', async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(image) {
              canvas._imageData = image;
            },
          };
        },
      };
      return canvas;
    },
  };
  t.after(() => { globalThis.document = previousDocument; });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-desktop-zarr-'));
  const zarrRoot = path.join(root, 'cells.zarr');
  const level = path.join(zarrRoot, '0');
  await fs.mkdir(level, { recursive: true });
  await fs.writeFile(path.join(zarrRoot, '.zattrs'), JSON.stringify({
    ome: {
      version: '0.4',
      multiscales: [{
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
        }],
      }],
    },
  }));
  await fs.writeFile(path.join(level, '.zarray'), JSON.stringify({
    zarr_format: 2,
    shape: [1, 2, 2],
    chunks: [1, 2, 2],
    dtype: '|u1',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));
  await fs.writeFile(path.join(level, '0.0.0'), Buffer.from([0, 32, 128, 255]));

  const { files, warnings, summary } = await collectSupportedFolderFiles([root]);
  const payload = openFolderPayload([root], files, warnings, summary);
  assert.equal(payload.warnings.length, 0);
  assert.deepEqual(payload.unsupported, []);
  assert.equal(payload.folderSummary.scannedFiles, 3);

  const desktopFiles = payload.supported.map(record => desktopFileFromRecord(record, {
    readFileRange: readNativeFileRange,
  }));
  const parsed = await parseOmeZarrFiles(desktopFiles);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.rootPath, `${path.basename(root)}/cells.zarr`);
  assert.equal(parsed.results[0].entry.description.includes('OME-Zarr'), true);
  assert.deepEqual(parsed.results[0].entry.pixelSpacing, [0.00025, 0.0005]);
});

test('desktop empty folder import reports an unsupported folder record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-empty-folder-'));
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');

  const { files, warnings, summary } = await collectSupportedFolderFiles([root, root]);
  const payload = openFolderPayload([root, root], files, warnings, summary);

  assert.equal(payload.supported.length, 0);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['folder_empty_or_unsupported']);
  assert.deepEqual(payload.warnings.map(item => item.reason), ['folder_empty_or_unsupported']);
  assert.deepEqual(payload.sourceFolders, [root]);
  assert.equal(payload.folderSummary.scannedFiles, 1);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 1);
  assert.deepEqual(payload.folderSummary.skippedUnsupportedSamples.map(item => item.name), ['notes.md']);
});

test('desktop folder import keeps scanning when a candidate file becomes unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-folder-race-'));
  const missingCandidate = path.join(root, 'a-missing.dcm');
  const supportedCandidate = path.join(root, 'b-cells.ome.tif');
  await fs.writeFile(missingCandidate, 'dicom');
  await fs.writeFile(supportedCandidate, 'tiff');

  const { files, warnings, summary } = await collectSupportedFolderFiles([root], {
    async statFile(filePath) {
      if (filePath === missingCandidate) throw new Error('vanished');
      return fs.stat(filePath);
    },
  });
  const payload = openFolderPayload([root], files, warnings, summary);

  assert.deepEqual(payload.supported.map(item => item.name), ['b-cells.ome.tif']);
  assert.deepEqual(payload.unsupported, []);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 0);
  assert.deepEqual(payload.folderSummary.skippedUnsupportedSamples, []);
  assert.equal(payload.folderSummary.failedFiles, 1);
  assert.deepEqual(payload.folderSummary.failedFileSamples.map(item => [item.name, item.reason]), [
    ['a-missing.dcm', 'path_unavailable'],
  ]);
  assert.deepEqual(payload.warnings, []);
});

test('desktop folder payload counts unreadable folders separately from skipped files', () => {
  const payload = openFolderPayload(
    ['/study'],
    [],
    [
      { path: '/study/private', reason: 'folder_read_failed' },
      { path: '/study/deep', reason: 'folder_depth_limit' },
    ],
    {
      scannedFiles: 4,
      skippedUnsupportedFiles: 3,
      skippedUnsupportedSamples: [
        { path: '/study/notes.md', name: 'notes.md', relativePath: 'study/notes.md', reason: 'unsupported_extension' },
      ],
    },
  );

  assert.equal(payload.folderSummary.warningCount, 2);
  assert.equal(payload.folderSummary.failedFolderReads, 1);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 3);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['folder_empty_or_unsupported']);
});

test('desktop folder import bounds unsupported-heavy scans', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-scan-limit-folder-'));
  await fs.writeFile(path.join(root, 'a-notes.md'), 'notes');
  await fs.writeFile(path.join(root, 'b-results.csv'), 'results');
  await fs.writeFile(path.join(root, 'c-scan.dcm'), 'dicom');

  const { files, warnings, summary } = await collectSupportedFolderFiles([root], { maxScannedFiles: 2 });
  const payload = openFolderPayload([root], files, warnings, summary);

  assert.deepEqual(files, []);
  assert.deepEqual(payload.supported, []);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['folder_empty_or_unsupported']);
  assert.deepEqual(payload.warnings.map(item => item.reason), ['folder_file_limit']);
  assert.equal(payload.folderSummary.scannedFiles, 2);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 2);
  assert.deepEqual(payload.folderSummary.skippedUnsupportedSamples.map(item => item.name), ['a-notes.md', 'b-results.csv']);
});

test('desktop folder import avoids duplicate records from overlapping folder selections', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-overlap-folder-'));
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root, 'scan.dcm'), 'dicom');
  await fs.writeFile(path.join(nested, 'cells.ome.tiff'), 'tiff');

  const { files, warnings, summary } = await collectSupportedFolderFiles([root, nested, root]);
  const payload = openFolderPayload([root, nested, root], files, warnings, summary);

  assert.deepEqual(payload.supported.map(item => item.name).sort(), ['cells.ome.tiff', 'scan.dcm']);
  assert.equal(payload.supported.length, new Set(payload.supported.map(item => item.path)).size);
  assert.deepEqual(payload.sourceFolders, [root, nested]);
  assert.equal(payload.warnings.length, 0);
  assert.equal(payload.folderSummary.skippedUnsupportedFiles, 0);
});

test('desktop folder import skips nested scan roots covered by selected parents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-covered-folder-'));
  const nested = path.join(root, '..metadata');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root, 'scan.dcm'), 'dicom');
  await fs.writeFile(path.join(nested, 'notes.md'), 'notes');

  const { files, warnings, summary } = await collectSupportedFolderFiles([nested, root]);
  const payload = openFolderPayload([nested, root], files, warnings, summary);

  assert.deepEqual(payload.supported.map(item => item.name), ['scan.dcm']);
  assert.deepEqual(payload.sourceFolders, [nested, root]);
  assert.equal(payload.warnings.length, 0);
});

test('desktop static protocol resolves only bundled app assets', () => {
  const root = path.resolve('/tmp/voxellab');

  assert.equal(
    resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/`, root),
    path.join(root, 'index.html'),
  );
  assert.equal(
    resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/js/index-init.js`, root),
    path.join(root, 'js/index-init.js'),
  );
  assert.equal(
    resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/three/build/three.module.js`, root),
    path.join(root, 'node_modules/three/build/three.module.js'),
  );
  assert.equal(
    resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/dcmjs/build/dcmjs.es.js`, root),
    path.join(root, 'node_modules/dcmjs/build/dcmjs.es.js'),
  );
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/dcmjs/build/dcmjs.js`, root), null);
  assert.equal(
    resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/three/examples/jsm/controls/TrackballControls.js`, root),
    path.join(root, 'node_modules/three/examples/jsm/controls/TrackballControls.js'),
  );
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/package.json`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/docs/private.md`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/electron/index.js`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/dcmjs/test/sample-dicom.json`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/onnxruntime-web/docs/api/index.md`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/node_modules/three/examples/jsm/loaders/OBJLoader.js`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://other/index.html`, root), null);
  assert.equal(resolveStaticAssetPath(`${APP_SCHEME}://${APP_HOST}/%2e%2e/secret.txt`, root), null);
});

test('desktop external URL policy only trusts project documentation HTTPS links', () => {
  assert.equal(isTrustedExternalUrl('https://github.com/kaanarici/VoxelLab'), true);
  assert.equal(isTrustedExternalUrl('https://github.com/kaanarici/VoxelLab/issues'), true);
  assert.equal(isTrustedExternalUrl('http://github.com/kaanarici/VoxelLab'), false);
  assert.equal(isTrustedExternalUrl('https://github.com/other/VoxelLab'), false);
  assert.equal(isTrustedExternalUrl('javascript:alert(1)'), false);
});

test('desktop packaged manifest fallback stays empty and local-first', () => {
  assert.deepEqual(EMPTY_DESKTOP_MANIFEST, { patient: 'anonymous', studyDate: '', series: [] });
});

test('desktop Windows Squirrel hooks register file associations for open-with', () => {
  const exePath = 'C:\\Users\\researcher\\AppData\\Local\\VoxelLab\\app-1.0.0\\VoxelLab.exe';
  const commands = windowsFileAssociationCommands(exePath);
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.dcm')));
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.roi')));
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.sr')));
  assert.equal(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.zip')), false);
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.czi')));
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.oib')));
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.oif')));
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.lsm')));
  assert.equal(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.gz')), false);
  assert.ok(commands.some(([, args]) => args.join(' ').includes('"C:\\Users\\researcher\\AppData\\Local\\VoxelLab\\app-1.0.0\\VoxelLab.exe" "%1"')));

  const spawned = [];
  const handled = handleWindowsSquirrelEvent(
    ['VoxelLab.exe', '--squirrel-install'],
    exePath,
    (command, args) => {
      spawned.push([command, args]);
      return { unref() {} };
    },
    'win32',
  );
  assert.equal(handled, true);
  assert.ok(spawned.some(([command]) => command === 'reg.exe'));
  assert.ok(spawned.some(([, args]) => args.includes('--createShortcut')));
  assert.equal(handleWindowsSquirrelEvent(['VoxelLab.exe'], exePath, () => {}, 'darwin'), false);
});

test('desktop IPC contract exposes only named bridge channels', () => {
  assert.deepEqual(Object.keys(IPC).sort(), [
    'appInfo',
    'cancelConversionJob',
    'clearCloudSettings',
    'clearRecentDocuments',
    'conversionJobChanged',
    'getCloudSettings',
    'getConversionJob',
    'getConverterCapabilities',
    'getRecentDocuments',
    'menuCommand',
    'openFiles',
    'openFolder',
    'openPaths',
    'openRecentPath',
    'readFileRange',
    'recentDocumentsChanged',
    'rendererReady',
    'revealPath',
    'saveCloudSettings',
    'startConversionJob',
    'windowState',
    'windowStateChanged',
  ]);
});

test('desktop cloud settings store token out of renderer-facing payloads', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-settings-'));
  const saved = await saveCloudSettings(userData, {
    modalWebhookBase: 'https://example-org--medical-imaging-pipeline.modal.run',
    modalAuthToken: 'secret-token',
    r2PublicUrl: 'https://pub.example.r2.dev/assets',
    trustedUploadOrigins: ['https://pub.example.r2.dev/assets'],
  });

  assert.equal(saved.configured, true);
  assert.equal(saved.hasModalAuthToken, true);
  assert.equal('modalAuthToken' in saved, false);
  assert.deepEqual(saved.trustedUploadOrigins, ['https://pub.example.r2.dev']);

  const raw = JSON.parse(await fs.readFile(path.join(userData, 'cloud-settings.json'), 'utf8'));
  assert.equal(raw.modalAuthToken, 'secret-token');
  const stat = await fs.stat(path.join(userData, 'cloud-settings.json'));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);

  const cleared = await clearCloudSettings(userData);
  assert.equal(cleared.configured, false);
  assert.equal(cleared.hasModalAuthToken, false);
});

test('desktop cloud proxy injects saved Modal token in main process', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-proxy-'));
  await saveCloudSettings(userData, {
    modalWebhookBase: 'https://example-org--medical-imaging-pipeline.modal.run',
    modalAuthToken: 'secret-token',
    r2PublicUrl: 'https://pub.example.r2.dev',
  });
  const seen = {};
  const response = await handleDesktopCloudRequest(
    new Request('voxellab://app/api/cloud/check_status', {
      method: 'POST',
      body: JSON.stringify({ job_id: 'job_123' }),
    }),
    userData,
    {
      fetch: async (url, init) => {
        seen.url = url;
        seen.body = JSON.parse(init.body);
        return Response.json({ status: 'complete' });
      },
    },
  );

  assert.equal(seen.url, 'https://example-org--medical-imaging-pipeline-check-status.modal.run');
  assert.deepEqual(seen.body, { job_id: 'job_123', token: 'secret-token' });
  assert.equal((await response.json()).status, 'complete');
});

test('desktop cloud proxy rejects direct calls when cloud processing is disabled', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-proxy-disabled-'));
  const saved = await saveCloudSettings(userData, {
    modalWebhookBase: 'https://example-org--medical-imaging-pipeline.modal.run',
    modalAuthToken: 'secret-token',
    r2PublicUrl: 'https://pub.example.r2.dev',
    cloudProcessing: false,
  });
  const response = await handleDesktopCloudRequest(
    new Request('voxellab://app/api/cloud/check_status', {
      method: 'POST',
      body: JSON.stringify({ job_id: 'job_123' }),
    }),
    userData,
    { fetch: async () => assert.fail('disabled cloud proxy must not call Modal') },
  );

  assert.equal(saved.configured, false);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'cloud processing is disabled' });
});

test('desktop local API proxy forwards helper requests to localhost', async () => {
  const seen = {};
  const request = new Request('voxellab://app/api/ask/stream?x=1', {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-VoxelLab-Local-Token': 'runtime-token',
      Cookie: 'skip-me',
    },
    body: JSON.stringify({ question: 'what is this?' }),
  });
  const response = await handleDesktopLocalApiRequest(
    request,
    {
      fetch: async (url, init) => {
        seen.url = url;
        seen.method = init.method;
        seen.headers = Object.fromEntries(init.headers.entries());
        seen.bodyIsBlob = init.body instanceof Blob;
        seen.body = JSON.parse(await init.body.text());
        return Response.json({ ok: true });
      },
    },
    'http://127.0.0.1:9123',
  );

  assert.equal(seen.url, 'http://127.0.0.1:9123/api/ask/stream?x=1');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.accept, 'text/event-stream');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers['x-voxellab-local-token'], 'runtime-token');
  assert.equal(seen.headers.origin, 'http://127.0.0.1:9123');
  assert.equal(seen.headers['sec-fetch-site'], 'same-origin');
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.bodyIsBlob, true);
  assert.equal(request.bodyUsed, true);
  assert.deepEqual(seen.body, { question: 'what is this?' });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(desktopLocalApiTarget('voxellab://app/api/cloud/check_status'), '');
});

test('desktop path records carry file metadata and support bounded range reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-path-backed-'));
  const filePath = path.join(root, 'scan.dcm');
  const roiResultsPath = path.join(root, 'roi-results.json');
  const metadataPath = path.join(root, 'metadata.json');
  const unknownSchemaPath = path.join(root, 'unknown-sidecar.json');
  const invalidJsonPath = path.join(root, 'broken.json');
  await fs.writeFile(filePath, '0123456789');
  await fs.writeFile(roiResultsPath, JSON.stringify({ schema: 'voxellab.roiResults.v1' }));
  await fs.writeFile(metadataPath, JSON.stringify({ lab: 'example' }));
  await fs.writeFile(unknownSchemaPath, JSON.stringify({ schema: 'example.not-roi-results.v1' }));
  await fs.writeFile(invalidJsonPath, '{not json');

  const item = await nativePathItem(filePath);
  const roiResultsItem = await nativePathItem(roiResultsPath);
  const metadataItem = await nativePathItem(metadataPath);
  const unknownSchemaItem = await nativePathItem(unknownSchemaPath);
  const invalidJsonItem = await nativePathItem(invalidJsonPath);
  const payload = openPathsPayload([item, roiResultsItem, metadataItem, unknownSchemaItem, invalidJsonItem]);
  assert.equal(payload.supported[0].size, 10);
  assert.equal(Number.isFinite(payload.supported[0].lastModified), true);
  assert.equal(payload.supported.find(record => record.name === 'roi-results.json')?.formatLabel, 'ROI results');
  assert.equal(payload.unsupported.find(record => record.name === 'metadata.json')?.reason, 'unrecognized_json_sidecar');
  assert.equal(payload.unsupported.find(record => record.name === 'unknown-sidecar.json')?.schema, 'example.not-roi-results.v1');
  assert.equal(payload.unsupported.find(record => record.name === 'broken.json')?.reason, 'invalid_json_sidecar');

  const range = await readNativeFileRange(filePath, { start: 2, end: 6, maxBytes: 4 });
  assert.equal(new TextDecoder().decode(range.bytes), '2345');
  const empty = await readNativeFileRange(filePath, { start: 200, end: 250, maxBytes: 4 });
  assert.equal(empty.bytes.byteLength, 0);
  await assert.rejects(
    readNativeFileRange(filePath, { start: 0, end: 5, maxBytes: 4 }),
    /too large/i,
  );
});

test('desktop unavailable native paths stay unsupported with an honest reason', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-missing-path-'));
  const missingPath = path.join(root, 'missing-extensionless-dicom');

  const item = await nativePathItem(missingPath);
  const payload = openPathsPayload([item]);

  assert.deepEqual(payload.supported, []);
  assert.equal(payload.unsupported.length, 1);
  assert.equal(payload.unsupported[0].name, 'missing-extensionless-dicom');
  assert.equal(payload.unsupported[0].reason, 'path_unavailable');
});

test('desktop native path item stats stay bounded while preserving selection order', async () => {
  const tracker = { active: 0, maxActive: 0 };
  const paths = Array.from({ length: 12 }, (_, index) => `/study/scan-${index}.dcm`);
  const items = await nativePathItems(paths, {
    concurrency: 3,
    async readItem(filePath) {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      try {
        await delay(1);
        return { path: filePath, isDirectory: false };
      } finally {
        tracker.active -= 1;
      }
    },
  });

  assert.deepEqual(items.map(item => item.path), paths);
  assert.ok(tracker.maxActive > 1, `expected path stats to remain parallel, saw ${tracker.maxActive}`);
  assert.ok(tracker.maxActive <= 3, `expected at most 3 concurrent path stats, saw ${tracker.maxActive}`);
});

test('desktop native path item stats treat invalid concurrency as conservative', async () => {
  const paths = ['/study/scan-a.dcm', '/study/scan-b.dcm'];
  const items = await nativePathItems(paths, {
    concurrency: 0.5,
    async readItem(filePath) {
      await delay(1);
      return { path: filePath, isDirectory: false };
    },
  });

  assert.deepEqual(items.map(item => item.path), paths);
});

test('desktop native path item stats clamp excessive concurrency', async () => {
  const tracker = { active: 0, maxActive: 0 };
  const paths = Array.from({ length: MAX_NATIVE_PATH_STAT_CONCURRENCY + 8 }, (_, index) => `/study/scan-${index}.dcm`);
  const items = await nativePathItems(paths, {
    concurrency: 10_000,
    async readItem(filePath) {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      try {
        await delay(1);
        return { path: filePath, isDirectory: false };
      } finally {
        tracker.active -= 1;
      }
    },
  });

  assert.deepEqual(items.map(item => item.path), paths);
  assert.ok(
    tracker.maxActive <= MAX_NATIVE_PATH_STAT_CONCURRENCY,
    `expected at most ${MAX_NATIVE_PATH_STAT_CONCURRENCY} concurrent path stats, saw ${tracker.maxActive}`,
  );
});

test('desktop converter jobs require configured absolute tools and write provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'fake-converter.mjs');
  const nonExecutablePath = path.join(root, 'not-executable-bioformats2raw');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(nonExecutablePath, '#!/bin/sh\n');
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs/promises';
    const [, , input, output] = process.argv;
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(output + '/.zattrs', JSON.stringify({ multiscales: [{}] }));
    await fs.writeFile(output + '/source.txt', input);
    console.log('converted');
  `);

  const unavailable = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: 'bioformats2raw' },
  });
  assert.equal(unavailable.capabilities().available, false);
  assert.equal(unavailable.capabilities().tools[0].reason, 'converter_path_not_absolute');
  await assert.rejects(
    unavailable.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' }),
    /not configured/i,
  );
  const stalePath = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: path.join(root, 'missing-bioformats2raw') },
  });
  assert.equal(stalePath.capabilities().available, false);
  assert.equal(stalePath.capabilities().tools[0].reason, 'converter_path_missing');
  await assert.rejects(
    stalePath.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' }),
    /not configured/i,
  );
  const nonExecutable = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: nonExecutablePath },
  });
  assert.equal(nonExecutable.capabilities().available, false);
  assert.equal(nonExecutable.capabilities().tools[0].reason, 'converter_path_not_executable');
  const unconfigured = new ConverterJobManager({ userDataPath: root, env: {} });
  assert.equal(unconfigured.capabilities().tools[0].reason, 'converter_not_configured');
  const windowsTextFile = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: nonExecutablePath },
    platform: 'win32',
  });
  assert.equal(windowsTextFile.capabilities().tools[0].reason, 'converter_path_not_executable');

  const manager = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: process.execPath },
    tools: [{
      id: 'bioformats2raw',
      label: 'Test converter',
      env: 'VOXELLAB_BIOFORMATS2RAW',
      inputExtensions: ['.czi'],
      outputKinds: ['ome-zarr'],
      licenseNote: 'test only',
      outputName: 'converted.ome.zarr',
      args: (input, output) => [scriptPath, input, output],
    }],
  });
  await assert.rejects(
    manager.start({ tool: 'bioformats2raw', inputPaths: [path.join(root, 'scan.dcm')], outputKind: 'ome-zarr' }),
    /does not support the selected input file/i,
  );
  await assert.rejects(
    manager.start({ tool: 'bioformats2raw', inputPaths: [path.join(root, '._cells.czi')], outputKind: 'ome-zarr' }),
    /does not support the selected input file/i,
  );
  await assert.rejects(
    manager.start({ tool: 'bioformats2raw', inputPaths: [path.join(root, 'missing.czi')], outputKind: 'ome-zarr' }),
    /selected input file is unavailable/i,
  );
  const job = await manager.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' });
  assert.equal(job.status, 'running');
  await waitForConversionStatus(manager, job.id, 'completed');
  const finished = manager.get(job.id);
  assert.equal(finished.status, 'completed');
  assert.match(finished.stdout, /converted/);
  assert.equal(await fs.readFile(path.join(finished.outputPath, 'source.txt'), 'utf8'), inputPath);
  const provenance = JSON.parse(await fs.readFile(finished.provenancePath, 'utf8'));
  assert.equal(provenance.schema, 'voxellab.desktop-conversion-provenance.v1');
  assert.equal(provenance.status, 'completed');
  assert.equal(provenance.tool, 'bioformats2raw');
  assert.equal(provenance.toolLabel, 'Test converter');
  assert.equal(provenance.toolEnv, 'VOXELLAB_BIOFORMATS2RAW');
  assert.equal(provenance.toolVersion, '');
  assert.equal(provenance.outputKind, 'ome-zarr');
  assert.equal(provenance.inputFiles[0].path, inputPath);
  assert.equal(provenance.inputFiles[0].name, 'cells.czi');
  assert.equal(provenance.inputFiles[0].bytes, 8);
  assert.equal(provenance.outputFiles[0].path, finished.outputPath);
  assert.equal(provenance.outputFiles[0].kind, 'directory');
  assert.equal(provenance.outputFiles[0].entryCount, 2);
  assert.deepEqual(provenance.outputFiles[0].entries, ['.zattrs', 'source.txt']);
  assert.match(provenance.knownLosses.join('\n'), /Proprietary vendor metadata/);
});

test('desktop converter jobs can be canceled with provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-cancel-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'slow-converter.mjs');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(scriptPath, 'setInterval(() => {}, 30000);');

  const signals = [];

  const manager = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: process.execPath },
    tools: [{
      id: 'bioformats2raw',
      label: 'Slow converter',
      env: 'VOXELLAB_BIOFORMATS2RAW',
      inputExtensions: ['.czi'],
      outputKinds: ['ome-zarr'],
      licenseNote: 'test only',
      outputName: 'converted.ome.zarr',
      args: () => [scriptPath],
    }],
    cancelGraceMs: 10,
    signalChild(child, signal) {
      signals.push(signal);
      if (signal === 'SIGTERM') return false;
      return child.kill(signal);
    },
  });

  const job = await manager.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' });
  const canceling = await manager.cancel(job.id);
  assert.equal(canceling.status, 'canceling');
  assert.equal(canceling.finishedAt, '');
  await assert.rejects(fs.stat(canceling.provenancePath));
  const canceled = await waitForConversionStatus(manager, job.id, 'canceled');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  const provenance = JSON.parse(await fs.readFile(canceled.provenancePath, 'utf8'));
  assert.equal(provenance.schema, 'voxellab.desktop-conversion-provenance.v1');
  assert.equal(provenance.status, 'canceled');
  assert.equal(provenance.outputFiles[0].kind, 'missing');
});

test('desktop recent documents persist opened files and folders without duplicates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-recent-docs-'));
  const storePath = path.join(root, 'recent-documents.json');
  const folder = path.join(root, 'study-folder');
  const first = path.join(root, 'scan.dcm');
  const second = path.join(root, 'cells.ome.tiff');
  await fs.mkdir(folder);
  await fs.writeFile(first, 'dicom');
  await fs.writeFile(second, 'tiff');
  const appLike = { getPath: () => root };

  let records = await rememberRecentDocuments(appLike, [first, folder], { storePath, now: Date.parse('2026-01-01T00:00:00Z') });
  assert.deepEqual(records.map(record => [record.name, record.kind]), [
    ['scan.dcm', 'file'],
    ['study-folder', 'folder'],
  ]);

  records = await rememberRecentDocuments(appLike, [second, first], { storePath, now: Date.parse('2026-01-02T00:00:00Z') });
  assert.deepEqual(records.map(record => record.name), ['cells.ome.tiff', 'scan.dcm', 'study-folder']);
  assert.equal(records[1].lastOpenedAt, '2026-01-02T00:00:00.000Z');
  assert.deepEqual((await readRecentDocuments(appLike, { storePath })).map(record => record.name), records.map(record => record.name));
  records = await removeRecentDocuments(appLike, [first], { storePath });
  assert.deepEqual(records.map(record => record.name), ['cells.ome.tiff', 'study-folder']);
  assert.deepEqual(await clearRecentDocuments(appLike, { storePath }), []);
});

test('desktop launch parser ignores app bootstrap args and keeps opened file paths', () => {
  const root = path.resolve('/tmp/voxellab');
  const image = path.join(root, 'sample.ome.tif');
  const launchPaths = launchPathsFromArgv([
    '/Applications/VoxelLab.app/Contents/MacOS/VoxelLab',
    root,
    '--enable-logging',
    image,
    image,
  ], {
    cwd: root,
    rootDir: root,
    mainPath: path.join(root, 'electron/main/index.js'),
  });

  assert.deepEqual(launchPaths, [image]);
});

test('desktop launch parser accepts file URLs and relative second-instance paths', () => {
  const root = path.resolve('/tmp/voxellab');
  const relative = 'study/scan.dcm';
  const encoded = pathToFileURL(path.join(root, 'cells with space.ome.tiff')).href;

  assert.deepEqual(
    launchPathsFromArgv(['VoxelLab.exe', '--', relative, encoded], { cwd: root, rootDir: root }),
    [path.join(root, relative), path.join(root, 'cells with space.ome.tiff')],
  );
});

test('desktop launch parser preserves native Windows absolute and relative paths', () => {
  assert.deepEqual(
    launchPathsFromArgv([
      'VoxelLab.exe',
      'C:\\Studies\\scan.dcm',
      'D:/Microscopy/cells.ome.tif',
      'relative\\series\\IM0001',
    ], {
      cwd: 'C:\\Users\\researcher',
      rootDir: 'C:\\Program Files\\VoxelLab\\resources\\app',
    }),
    [
      'C:\\Studies\\scan.dcm',
      'D:\\Microscopy\\cells.ome.tif',
      'C:\\Users\\researcher\\relative\\series\\IM0001',
    ],
  );
});
