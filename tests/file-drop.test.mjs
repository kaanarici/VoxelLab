import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDroppedFiles, filterLocalFiles } from '../js/file-drop.js';

function fileEntry(name, file = { name }) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve) {
      resolve(file);
    },
  };
}

function unavailableFileEntry(name) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(_resolve, reject) {
      reject(new Error('not readable'));
    },
  };
}

function directoryEntry(name, batches) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let index = 0;
      return {
        readEntries(resolve) {
          resolve(batches[index++] || []);
        },
      };
    },
  };
}

function unreadableDirectoryEntry(name) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(_resolve, reject) {
          reject(new Error('not readable'));
        },
      };
    },
  };
}

function withFullPath(entry, fullPath) {
  entry.fullPath = fullPath;
  return entry;
}

function gatedSiblingFileEntries(names, state) {
  const pending = [];
  return names.map((name, index) => ({
    name,
    isFile: true,
    isDirectory: false,
    file(resolve) {
      pending.push(name);
      Promise.resolve().then(() => {
        if (index === 0) state.concurrentAtFirstResolve = pending.length === names.length;
        resolve({ name });
      });
    },
  }));
}

test('collectDroppedFiles falls back to dataTransfer.files when entries are unavailable', async () => {
  const files = [{ name: 'scan.dcm' }, { name: '.DS_Store' }, { name: 'volume.nii' }];

  const result = await collectDroppedFiles({ files });

  assert.deepEqual(result, [files[0], files[2]]);
});

test('filterLocalFiles skips OS metadata from picker FileLists without dropping zarr metadata', () => {
  const files = [
    { name: '.DS_Store' },
    { name: '.zattrs', webkitRelativePath: 'cells.zarr/.zattrs' },
    { name: '.zgroup', webkitRelativePath: 'cells.zarr/.zgroup' },
    { name: '.zmetadata', webkitRelativePath: 'cells.zarr/.zmetadata' },
    { name: 'Thumbs.db' },
    { name: '._scan.dcm', webkitRelativePath: 'study/._scan.dcm' },
    { name: 'resource.ome.tif', webkitRelativePath: '__MACOSX/study/resource.ome.tif' },
    { name: 'config', webkitRelativePath: 'study/.git/config' },
    { name: 'plane.ome.tif', webkitRelativePath: 'study/.ipynb_checkpoints/plane.ome.tif' },
    { name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' },
    { name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' },
    { name: 'scan.dcm' },
    { name: 'scan.dcm' },
    { name: '.hidden' },
  ];

  assert.deepEqual(filterLocalFiles(files), [files[1], files[2], files[3], files[9], files[11], files[12]]);
});

test('filterLocalFiles fails fast when picker selections exceed the file cap after cleanup', () => {
  const files = [
    { name: '.DS_Store' },
    { name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' },
    { name: 'volume.nii', webkitRelativePath: 'study/volume.nii' },
  ];

  assert.throws(
    () => filterLocalFiles(files, { maxFiles: 1 }),
    /more than 1 file/,
  );
});

test('filterLocalFiles stops scanning picker FileLists once the cap is exceeded', () => {
  let readAfterLimit = false;
  const files = {
    length: 3,
    0: { name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' },
    1: { name: 'volume.nii', webkitRelativePath: 'study/volume.nii' },
    get 2() {
      readAfterLimit = true;
      return { name: 'late.ome.tiff', webkitRelativePath: 'study/late.ome.tiff' };
    },
  };

  assert.throws(
    () => filterLocalFiles(files, { maxFiles: 1 }),
    /more than 1 file/,
  );
  assert.equal(readAfterLimit, false);
});

test('collectDroppedFiles caps drag fallback FileLists when entries are unavailable', async () => {
  const files = [{ name: 'scan.dcm' }, { name: 'volume.nii' }];

  await assert.rejects(
    () => collectDroppedFiles({ files }, { maxFiles: 1 }),
    /more than 1 file/,
  );
});

test('collectDroppedFiles keeps stable relative paths across nested readEntries batches', async () => {
  const dcm = { name: 'IM0001' };
  const dcmDuplicate = { name: 'IM0001' };
  const roi = { name: 'cells.roi' };
  const zattrs = { name: '.zattrs' };
  const zgroup = { name: '.zgroup' };
  const zmetadata = { name: '.zmetadata' };
  const root = directoryEntry('study', [
    [
      fileEntry('IM0001', dcm),
      fileEntry('IM0001', dcmDuplicate),
      fileEntry('.DS_Store', { name: '.DS_Store' }),
      fileEntry('._IM0001', { name: '._IM0001' }),
      fileEntry('.hidden', { name: '.hidden' }),
      directoryEntry('.git', [[fileEntry('config', { name: 'config' })], []]),
      directoryEntry('__MACOSX', [[fileEntry('resource.ome.tif', { name: 'resource.ome.tif' })], []]),
      directoryEntry('rois', [[fileEntry('cells.roi', roi)], []]),
    ],
    [
      directoryEntry('cells.zarr', [[
        fileEntry('.zattrs', zattrs),
        fileEntry('.zgroup', zgroup),
        fileEntry('.zmetadata', zmetadata),
        fileEntry('.hidden', { name: '.hidden' }),
        fileEntry('Thumbs.db', { name: 'Thumbs.db' }),
        directoryEntry('.git', [[fileEntry('config', { name: 'config' })], []]),
      ], []]),
    ],
    [],
  ]);

  const result = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => root }],
  });

  assert.deepEqual(result.map(file => file.name), ['IM0001', 'cells.roi', '.zattrs', '.zgroup', '.zmetadata']);
  assert.deepEqual(result.map(file => file.webkitRelativePath), [
    'study/IM0001',
    'study/rois/cells.roi',
    'study/cells.zarr/.zattrs',
    'study/cells.zarr/.zgroup',
    'study/cells.zarr/.zmetadata',
  ]);
});

test('collectDroppedFiles keeps readable siblings when a dropped entry file is unavailable', async () => {
  const readable = { name: 'scan.dcm' };
  const root = directoryEntry('study', [
    [
      unavailableFileEntry('missing.ome.tif'),
      fileEntry('scan.dcm', readable),
    ],
    [],
  ]);

  const result = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => root }],
  });

  assert.deepEqual(result.map(file => [file.name, file.webkitRelativePath, file.skipReason || '']), [
    ['missing.ome.tif', 'study/missing.ome.tif', 'path_unavailable'],
    ['scan.dcm', 'study/scan.dcm', ''],
  ]);
  assert.equal(result[0].failureKind, 'file');
});

test('collectDroppedFiles keeps readable siblings when a dropped directory is unreadable', async () => {
  const root = directoryEntry('study', [
    [
      unreadableDirectoryEntry('private'),
      fileEntry('scan.dcm', { name: 'scan.dcm' }),
    ],
    [],
  ]);

  const result = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => root }],
  });

  assert.deepEqual(result.map(file => [file.name, file.webkitRelativePath, file.skipReason || '']), [
    ['private', 'study/private', 'folder_read_failed'],
    ['scan.dcm', 'study/scan.dcm', ''],
  ]);
  assert.equal(result[0].failureKind, 'folder');
});

test('filterLocalFiles keeps zarr metadata while dropping hidden zarr noise', () => {
  const files = [
    { name: '.zattrs', webkitRelativePath: 'cells.zarr/.zattrs' },
    { name: '.zarray', webkitRelativePath: 'cells.zarr/0/.zarray' },
    { name: '.zgroup', webkitRelativePath: 'cells.zarr/.zgroup' },
    { name: '.zmetadata', webkitRelativePath: 'cells.zarr/.zmetadata' },
    { name: '0.0.0', webkitRelativePath: 'cells.zarr/0/0.0.0' },
    { name: '.hidden', webkitRelativePath: 'cells.zarr/.hidden' },
    { name: 'config', webkitRelativePath: 'cells.zarr/.git/config' },
  ];

  assert.deepEqual(filterLocalFiles(files), [files[0], files[1], files[2], files[3], files[4]]);
});

test('collectDroppedFiles deduplicates entry paths before file reads and cap accounting', async () => {
  let reads = 0;
  const countedFile = (name) => ({
    name,
    isFile: true,
    isDirectory: false,
    file(resolve) {
      reads += 1;
      resolve({ name });
    },
  });
  const root = directoryEntry('study', [
    [countedFile('IM0001'), countedFile('IM0001')],
    [],
  ]);

  const result = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => root }],
  }, { maxFiles: 1 });

  assert.equal(reads, 1);
  assert.deepEqual(result.map(file => file.name), ['IM0001']);
  assert.deepEqual(result.map(file => file.webkitRelativePath), ['study/IM0001']);
});

test('collectDroppedFiles skips selected roots already covered by another dropped folder', async () => {
  let reads = 0;
  const countedFile = (name) => ({
    name,
    isFile: true,
    isDirectory: false,
    fullPath: `/study/rois/${name}`,
    file(resolve) {
      reads += 1;
      resolve({ name });
    },
  });
  const rois = withFullPath(directoryEntry('rois', [[countedFile('cells.roi')], []]), '/study/rois');
  const root = withFullPath(directoryEntry('study', [[rois], []]), '/study');

  const result = await collectDroppedFiles({
    items: [
      { webkitGetAsEntry: () => root },
      { webkitGetAsEntry: () => rois },
      { webkitGetAsEntry: () => root },
    ],
  });

  assert.equal(reads, 1);
  assert.deepEqual(result.map(file => file.name), ['cells.roi']);
  assert.deepEqual(result.map(file => file.webkitRelativePath), ['study/rois/cells.roi']);
});

test('collectDroppedFiles returns traversal output without rescanning files', async () => {
  let fileNameReads = 0;
  const file = {};
  Object.defineProperty(file, 'name', {
    get() {
      fileNameReads += 1;
      return 'IM0001';
    },
  });
  const root = directoryEntry('study', [
    [fileEntry('IM0001', file)],
    [],
  ]);

  const result = await collectDroppedFiles({
    items: [{ webkitGetAsEntry: () => root }],
  });

  assert.equal(result[0], file);
  assert.equal(result[0].webkitRelativePath, 'study/IM0001');
  assert.equal(fileNameReads, 0);
});

test('collectDroppedFiles reads sibling entries in one browser batch concurrently', async () => {
  const gate = { concurrentAtFirstResolve: false };
  const root = directoryEntry('study', [
    gatedSiblingFileEntries(['IM0001', 'IM0002'], gate),
    [],
  ]);

  const result = await collectDroppedFiles({ items: [{ webkitGetAsEntry: () => root }] });

  assert.equal(gate.concurrentAtFirstResolve, true);
  assert.deepEqual(result.map(file => file.name), ['IM0001', 'IM0002']);
  assert.deepEqual(result.map(file => file.webkitRelativePath), ['study/IM0001', 'study/IM0002']);
});

test('collectDroppedFiles does not traverse later roots after the shared file cap fails', async () => {
  let secondRootReads = 0;
  const first = withFullPath(directoryEntry('first', [[fileEntry('IM0001')], []]), '/first');
  const second = withFullPath(directoryEntry('second', [[{
    name: 'IM0002',
    isFile: true,
    isDirectory: false,
    file(resolve) {
      secondRootReads += 1;
      resolve({ name: 'IM0002' });
    },
  }], []]), '/second');

  await assert.rejects(
    () => collectDroppedFiles({
      items: [
        { webkitGetAsEntry: () => first },
        { webkitGetAsEntry: () => second },
      ],
    }, { maxFiles: 1 }),
    /more than 1 file/,
  );
  assert.equal(secondRootReads, 0);
});

test('collectDroppedFiles fails fast when a dropped folder exceeds the file cap', async () => {
  const root = directoryEntry('study', [
    [fileEntry('IM0001'), fileEntry('IM0002')],
    [],
  ]);

  await assert.rejects(
    () => collectDroppedFiles({ items: [{ webkitGetAsEntry: () => root }] }, { maxFiles: 1 }),
    /more than 1 file/,
  );
});
