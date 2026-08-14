/* global console, process */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertReleaseArtifactFileHygiene,
  walkReleaseAssetFiles,
} from './check_release_assets.mjs';

const PLATFORM_OUTPUTS = Object.freeze({
  darwin: {
    label: 'macOS',
    patterns: [/\.dmg$/i, /\.zip$/i],
  },
  win32: {
    label: 'Windows',
    patterns: [/\.exe$/i, /\.nupkg$/i, /^RELEASES$/],
  },
});

function relativeName(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

function expectedOutputFor(platform) {
  const output = PLATFORM_OUTPUTS[platform];
  assert.ok(output, `unsupported desktop make output platform: ${platform}`);
  return output;
}

export function checkDesktopMakeOutputs(rootDir = 'out/forge/make', platform = process.platform) {
  const output = expectedOutputFor(platform);
  const resolvedRoot = path.resolve(rootDir);
  const files = walkReleaseAssetFiles(resolvedRoot);
  assert.ok(files.length > 0, `${resolvedRoot} contains no desktop make outputs`);
  assertReleaseArtifactFileHygiene(resolvedRoot, files);

  for (const pattern of output.patterns) {
    assert.ok(
      files.some(file => pattern.test(path.basename(file))),
      `${output.label} desktop make outputs must include ${pattern}`,
    );
  }

  for (const file of files) {
    assert.ok(
      output.patterns.some(pattern => pattern.test(path.basename(file))),
      `${relativeName(resolvedRoot, file)} is not an expected ${output.label} desktop artifact`,
    );
  }

  return {
    platform,
    fileCount: files.length,
    files: files.map(file => relativeName(resolvedRoot, file)),
  };
}

function main() {
  const result = checkDesktopMakeOutputs(process.argv[2], process.argv[3] || process.platform);
  console.log(`OK: ${result.platform} desktop make outputs are downloadable artifacts (${result.fileCount} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
