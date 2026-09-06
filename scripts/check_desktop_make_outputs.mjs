import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertReleaseArtifactFileHygiene,
  walkReleaseAssetFiles,
} from './check_release_assets.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ESCAPED_PACKAGE_VERSION = PACKAGE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PLATFORM_OUTPUTS = Object.freeze({
  darwin: {
    label: 'macOS',
    patterns: [/\.dmg$/i],
  },
  win32: {
    label: 'Windows',
    patterns: [
      new RegExp(`^VoxelLab-${ESCAPED_PACKAGE_VERSION}-Setup\\.exe$`, 'i'),
      new RegExp(`^VoxelLab-${ESCAPED_PACKAGE_VERSION}-full\\.nupkg$`, 'i'),
      /^RELEASES$/,
    ],
    exactCount: 3,
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
  if (output.exactCount) {
    assert.equal(files.length, output.exactCount, `${output.label} desktop make outputs must contain exactly ${output.exactCount} files`);
  }

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
  console.log(`OK: ${result.platform} desktop make outputs match the configured package formats (${result.fileCount} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
