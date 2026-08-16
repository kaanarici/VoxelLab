import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDesktopMakeOutputs } from '../scripts/check_desktop_make_outputs.mjs';
import { checkReleaseAssets } from '../scripts/check_release_assets.mjs';
import { preparePublicReleaseAssets } from '../scripts/prepare_public_release_assets.mjs';
import { writeReleaseChecksums } from '../scripts/write_release_checksums.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function tempRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'voxellab-release-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, contents = relative) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

async function validPublicAssets(t, tag = 'v1.2.0') {
  const root = tempRoot(t);
  const inputs = path.join(root, 'inputs');
  const output = path.join(root, 'public');
  write(inputs, 'mac/VoxelLab.dmg', 'dmg');
  write(inputs, 'win/VoxelLab-1.2.0-Setup.exe', 'exe');
  const prepared = await preparePublicReleaseAssets(inputs, output, tag);
  await writeReleaseChecksums(output, path.join(output, 'SHA256SUMS'));
  return { root, inputs, output, prepared };
}

test('public release preparation emits two versioned installers and exact checksums', async (t) => {
  const { output, prepared } = await validPublicAssets(t);
  assert.deepEqual(prepared.map(file => path.basename(file)).sort(), [
    'VoxelLab-1.2.0-Windows-x64.exe',
    'VoxelLab-1.2.0-macOS-arm64.dmg',
  ]);
  const result = checkReleaseAssets(output, 'v1.2.0');
  assert.deepEqual(result.names.sort(), [
    'SHA256SUMS',
    'VoxelLab-1.2.0-Windows-x64.exe',
    'VoxelLab-1.2.0-macOS-arm64.dmg',
  ]);
  assert.match(readFileSync(path.join(output, 'SHA256SUMS'), 'utf8'), /VoxelLab-1\.2\.0-macOS-arm64\.dmg/);
});

test('public release rejects internal evidence, updater files, extras, and mismatched versions', async (t) => {
  const { output } = await validPublicAssets(t);
  write(output, 'lab-readiness-report.json', '{}');
  assert.throws(() => checkReleaseAssets(output, 'v1.2.0'), /must not ship in release assets/);
  rmSync(path.join(output, 'lab-readiness-report.json'));
  write(output, 'VoxelLab-1.2.0-full.nupkg', 'updater');
  assert.throws(() => checkReleaseAssets(output, 'v1.2.0'), /must not ship updater packages/);
  rmSync(path.join(output, 'VoxelLab-1.2.0-full.nupkg'));
  write(output, 'notes.txt', 'extra');
  assert.throws(() => checkReleaseAssets(output, 'v1.2.0'), /exactly the two installers/);
  rmSync(path.join(output, 'notes.txt'));
  assert.throws(() => checkReleaseAssets(output, 'v1.2.1'), /exactly the two installers/);
});

test('public release rejects stale or incomplete checksums', async (t) => {
  const { output } = await validPublicAssets(t);
  writeFileSync(path.join(output, 'VoxelLab-1.2.0-macOS-arm64.dmg'), 'changed');
  assert.throws(() => checkReleaseAssets(output, 'v1.2.0'), /checksum must match/);
  writeFileSync(path.join(output, 'SHA256SUMS'), 'bad\n');
  assert.throws(() => checkReleaseAssets(output, 'v1.2.0'), /must cover only the two installers|invalid SHA256SUMS/);
});

test('public release preparation requires one DMG, one Setup EXE, and an empty destination', async (t) => {
  const root = tempRoot(t);
  const inputs = path.join(root, 'inputs');
  const output = path.join(root, 'public');
  write(inputs, 'VoxelLab.dmg', 'dmg');
  await assert.rejects(preparePublicReleaseAssets(inputs, output, 'v1.2.0'), /one Windows installer/);
  write(inputs, 'VoxelLab-Setup.exe', 'exe');
  write(output, 'keep.txt', 'keep');
  await assert.rejects(preparePublicReleaseAssets(inputs, output, 'v1.2.0'), /must start empty/);
  await assert.rejects(preparePublicReleaseAssets(inputs, path.join(root, 'other'), 'latest'), /semantic version tag/);
});

test('desktop make outputs match configured package formats before curation', (t) => {
  const root = tempRoot(t);
  const mac = path.join(root, 'mac');
  write(mac, 'VoxelLab.dmg', 'dmg');
  assert.equal(checkDesktopMakeOutputs(mac, 'darwin').fileCount, 1);
  write(mac, 'VoxelLab.zip', 'zip');
  assert.throws(() => checkDesktopMakeOutputs(mac, 'darwin'), /not an expected macOS desktop artifact/);

  const win = path.join(root, 'win');
  write(win, `VoxelLab-${PACKAGE_VERSION}-Setup.exe`, 'exe');
  write(win, `VoxelLab-${PACKAGE_VERSION}-full.nupkg`, 'nupkg');
  write(win, 'RELEASES', 'releases');
  assert.equal(checkDesktopMakeOutputs(win, 'win32').fileCount, 3);
  write(win, 'unexpected.exe', 'exe');
  assert.throws(() => checkDesktopMakeOutputs(win, 'win32'), /must contain exactly 3 files/);
});

test('desktop make output hygiene rejects internal files and research data', (t) => {
  const root = tempRoot(t);
  write(root, 'VoxelLab.dmg', 'dmg');
  write(root, 'AGENTS.md', 'internal');
  assert.throws(() => checkDesktopMakeOutputs(root, 'darwin'), /must not ship in release assets/);
  rmSync(path.join(root, 'AGENTS.md'));
  write(root, 'patient.dcm', 'data');
  assert.throws(() => checkDesktopMakeOutputs(root, 'darwin'), /must not ship loose research imaging data/);
});
