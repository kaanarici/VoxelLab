import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeReleaseChecksums } from '../scripts/write_release_checksums.mjs';

test('writeReleaseChecksums writes sorted basename-addressable SHA-256 entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voxellab-checksums-'));
  try {
    await mkdir(path.join(root, 'mac'));
    await mkdir(path.join(root, 'win'));
    await writeFile(path.join(root, 'mac', 'VoxelLab.dmg'), 'mac');
    await writeFile(path.join(root, 'win', 'VoxelLab.exe'), 'win');
    const output = path.join(root, 'SHA256SUMS');
    const result = await writeReleaseChecksums(root, output);
    assert.equal(result.fileCount, 2);
    assert.equal(await readFile(output, 'utf8'), [
      '348a629f5ceed032c3e8706ec47d9bfafb00fb4250b018dd965435ca50cb836e  VoxelLab.dmg',
      '823a3180dad3c9c3c4dea43ab2baf9f04bac9c3a7711745ff5f702551496d735  VoxelLab.exe',
      '',
    ].join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeReleaseChecksums rejects duplicate downloadable basenames', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voxellab-checksums-'));
  try {
    await mkdir(path.join(root, 'a'));
    await mkdir(path.join(root, 'b'));
    await writeFile(path.join(root, 'a', 'same.zip'), 'a');
    await writeFile(path.join(root, 'b', 'same.zip'), 'b');
    await assert.rejects(
      writeReleaseChecksums(root, path.join(root, 'SHA256SUMS')),
      /basenames must be unique/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
