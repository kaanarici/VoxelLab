/* global console, process */
import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkReleaseAssetFiles } from './check_release_assets.mjs';

function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  assert.ok(match, 'public asset preparation requires an exact semantic version tag');
  return match[1];
}

function one(files, predicate, label) {
  const matches = files.filter(predicate);
  assert.equal(matches.length, 1, `expected exactly one ${label} build artifact`);
  return matches[0];
}

export async function preparePublicReleaseAssets(sourceDir, outputDir, tag) {
  const version = versionFromTag(tag);
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const files = walkReleaseAssetFiles(source);
  const dmg = one(files, file => /\.dmg$/i.test(file), 'macOS DMG');
  const exe = one(files, file => /Setup[^/]*\.exe$/i.test(path.basename(file)), 'Windows installer');
  await mkdir(output, { recursive: true });
  assert.deepEqual(await readdir(output), [], 'public asset output directory must start empty');
  const targets = [
    [dmg, path.join(output, `VoxelLab-${version}-macOS-arm64.dmg`)],
    [exe, path.join(output, `VoxelLab-${version}-Windows-x64.exe`)],
  ];
  for (const [input, target] of targets) await copyFile(input, target);
  return targets.map(([, target]) => target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = await preparePublicReleaseAssets(process.argv[2], process.argv[3], process.argv[4]);
  console.log(`OK: prepared ${files.length} versioned public installers`);
}
