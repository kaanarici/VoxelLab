import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const {
  APP_HOST,
  APP_SCHEME,
  IPC,
  isConvertibleInputPath,
  isSupportedInputPath,
  openPathsPayload,
} = await import('../electron/shared/desktop-contracts.js');
const {
  ConverterJobManager,
} = await import('../electron/main/converter-jobs.js');
const {
  isTrustedExternalUrl,
} = await import('../electron/main/external-urls.js');
const {
  EMPTY_DESKTOP_MANIFEST,
  resolveStaticAssetPath,
} = await import('../electron/main/static-protocol.js');
const {
  collectSupportedFolderFiles,
  nativePathItem,
  openFolderPayload,
  readNativeFileRange,
} = await import('../electron/main/native-paths.js');
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
} = await import('../electron/main/recent-documents.js');

test('desktop open contract accepts current VoxelLab input families', () => {
  assert.equal(isSupportedInputPath('/study/IM0001'), true);
  assert.equal(isSupportedInputPath('/study/scan.dcm'), true);
  assert.equal(isSupportedInputPath('/study/volume.nii.gz'), true);
  assert.equal(isSupportedInputPath('/study/notes.gz'), false);
  assert.equal(isSupportedInputPath('/study/model.obj.gz'), false);
  assert.equal(isSupportedInputPath('/study/cells.ome.tiff'), true);
  assert.equal(isSupportedInputPath('/study/cells.czi'), false);
  assert.equal(isConvertibleInputPath('/study/cells.czi'), true);
  assert.equal(isSupportedInputPath('/study/results.csv'), true);
  assert.equal(isSupportedInputPath('/Applications/tool.exe'), false);
  assert.equal(isSupportedInputPath('/dataset', { isDirectory: true }), false);
});

test('desktop open payload separates supported and unsupported paths', () => {
  const payload = openPathsPayload([
    '/study/scan.dcm',
    '/study/cells.czi',
    '/study/readme.md',
    { path: '/study/folder', isDirectory: true },
  ]);

  assert.equal(payload.apiVersion, 1);
  assert.equal(payload.records.length, 4);
  assert.deepEqual(payload.supported.map(item => item.name), ['scan.dcm']);
  assert.deepEqual(payload.convertible.map(item => item.name), ['cells.czi']);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['unsupported_extension', 'folder_empty_or_unsupported']);
});

test('desktop folder import expands folders into supported files only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-folder-import-'));
  const nested = path.join(root, 'series');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root, 'scan.dcm'), 'dicom');
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');
  await fs.writeFile(path.join(root, '.DS_Store'), 'junk');
  await fs.writeFile(path.join(nested, 'plane.ome.tif'), 'tiff');

  const { files, warnings } = await collectSupportedFolderFiles([root]);
  const payload = openFolderPayload([root], files, warnings);

  assert.deepEqual(
    payload.supported.map(item => item.name),
    ['scan.dcm', 'plane.ome.tif'],
  );
  assert.deepEqual(payload.unsupported, []);
  assert.deepEqual(payload.sourceFolders, [root]);
  assert.equal(payload.warnings.length, 0);
});

test('desktop empty folder import reports an unsupported folder record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-empty-folder-'));
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');

  const { files, warnings } = await collectSupportedFolderFiles([root]);
  const payload = openFolderPayload([root], files, warnings);

  assert.equal(payload.supported.length, 0);
  assert.deepEqual(payload.unsupported.map(item => item.reason), ['folder_empty_or_unsupported']);
  assert.deepEqual(payload.warnings.map(item => item.reason), ['folder_empty_or_unsupported']);
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
  assert.equal(isTrustedExternalUrl('https://github.com/kaanaricio/VoxelLab'), true);
  assert.equal(isTrustedExternalUrl('https://github.com/kaanaricio/VoxelLab/issues'), true);
  assert.equal(isTrustedExternalUrl('http://github.com/kaanaricio/VoxelLab'), false);
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
  assert.ok(commands.some(([, args]) => args.join(' ').includes('HKCU\\Software\\Classes\\.czi')));
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
    'clearRecentDocuments',
    'conversionJobChanged',
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
    'startConversionJob',
    'windowState',
    'windowStateChanged',
  ]);
});

test('desktop path records carry file metadata and support bounded range reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-path-backed-'));
  const filePath = path.join(root, 'scan.dcm');
  await fs.writeFile(filePath, '0123456789');

  const item = await nativePathItem(filePath);
  const payload = openPathsPayload([item]);
  assert.equal(payload.supported[0].size, 10);
  assert.equal(Number.isFinite(payload.supported[0].lastModified), true);

  const range = await readNativeFileRange(filePath, { start: 2, end: 6, maxBytes: 4 });
  assert.equal(new TextDecoder().decode(range.bytes), '2345');
  const empty = await readNativeFileRange(filePath, { start: 200, end: 250, maxBytes: 4 });
  assert.equal(empty.bytes.byteLength, 0);
  await assert.rejects(
    readNativeFileRange(filePath, { start: 0, end: 5, maxBytes: 4 }),
    /too large/i,
  );
});

test('desktop converter jobs require configured absolute tools and write provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'fake-converter.mjs');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs/promises';
    const [, , input, output] = process.argv;
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(output + '/source.txt', input);
    console.log('converted');
  `);

  const unavailable = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_BIOFORMATS2RAW: 'bioformats2raw' },
  });
  assert.equal(unavailable.capabilities().available, false);
  await assert.rejects(
    unavailable.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' }),
    /not configured/i,
  );

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
  const job = await manager.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' });
  assert.equal(job.status, 'running');
  await new Promise((resolve) => manager.once('changed', (next) => {
    if (next.status === 'completed') resolve();
    else manager.once('changed', resolve);
  }));
  const finished = manager.get(job.id);
  assert.equal(finished.status, 'completed');
  assert.match(finished.stdout, /converted/);
  assert.equal(await fs.readFile(path.join(finished.outputPath, 'source.txt'), 'utf8'), inputPath);
  const provenance = JSON.parse(await fs.readFile(finished.provenancePath, 'utf8'));
  assert.equal(provenance.status, 'completed');
  assert.equal(provenance.outputKind, 'ome-zarr');
});

test('desktop converter jobs can be canceled with provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-cancel-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'slow-converter.mjs');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(scriptPath, 'setTimeout(() => {}, 30000);');

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
  });

  const job = await manager.start({ tool: 'bioformats2raw', inputPaths: [inputPath], outputKind: 'ome-zarr' });
  const canceled = await manager.cancel(job.id);
  assert.equal(canceled.status, 'canceled');
  const provenance = JSON.parse(await fs.readFile(canceled.provenancePath, 'utf8'));
  assert.equal(provenance.status, 'canceled');
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
