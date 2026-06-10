import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextEncoder } from 'node:util';

const { desktopFileFromRecord } = await import('../js/desktop-path-file.js');

function desktopFile(bytes = new TextEncoder().encode('0123456789')) {
  const calls = [];
  const desktop = {
    async readFileRange(filePath, range) {
      calls.push({ filePath, range });
      return {
        bytes: bytes.buffer.slice(bytes.byteOffset + range.start, bytes.byteOffset + range.end),
      };
    },
  };
  return {
    calls,
    file: desktopFileFromRecord({
      path: '/study/scan.dcm',
      name: 'scan.dcm',
      size: bytes.byteLength,
      lastModified: 123,
      relativePath: 'study/scan.dcm',
    }, desktop),
  };
}

test('desktop path-backed files preserve browser File metadata', () => {
  const { file } = desktopFile();

  assert.equal(file.name, 'scan.dcm');
  assert.equal(file.path, '/study/scan.dcm');
  assert.equal(file.size, 10);
  assert.equal(file.lastModified, 123);
  assert.equal(file.webkitRelativePath, 'study/scan.dcm');
});

test('desktop path-backed File.slice supports browser-style negative ranges', async () => {
  const { file, calls } = desktopFile();

  const blob = file.slice(-4, -1, 'TEXT/PLAIN');

  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), '678');
  assert.deepEqual(calls, [{
    filePath: '/study/scan.dcm',
    range: { start: 6, end: 9 },
  }]);
});

test('desktop path-backed File.slice returns an empty blob for reversed ranges', async () => {
  const { file, calls } = desktopFile();

  const blob = file.slice(8, 2);

  assert.equal(blob.size, 0);
  assert.equal((await blob.arrayBuffer()).byteLength, 0);
  assert.deepEqual(calls, []);
});

test('desktop path-backed blobs stream range reads in chunks', async () => {
  const bytes = new Uint8Array((1024 * 1024) + 3);
  bytes[0] = 1;
  bytes[1024 * 1024] = 2;
  bytes[1024 * 1024 + 2] = 3;
  const { file, calls } = desktopFile(bytes);
  const reader = file.stream().getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  assert.deepEqual(chunks.map(chunk => chunk.byteLength), [1024 * 1024, 3]);
  assert.equal(chunks[0][0], 1);
  assert.equal(chunks[1][0], 2);
  assert.equal(chunks[1][2], 3);
  assert.deepEqual(calls, [{
    filePath: '/study/scan.dcm',
    range: { start: 0, end: 1024 * 1024 },
  }, {
    filePath: '/study/scan.dcm',
    range: { start: 1024 * 1024, end: (1024 * 1024) + 3 },
  }]);
});
