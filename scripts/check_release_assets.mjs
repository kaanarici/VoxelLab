/* global console, process */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BLOCKED_BASENAMES = new Set([
  '.env',
  '.env.example',
  'AGENTS.md',
  'CLAUDE.md',
  'FLOW_INDEX.md',
  'MISSION.md',
  'config.local.json',
  'lab-readiness-report.json',
]);

const BLOCKED_PATH_PARTS = new Set([
  '.claude',
  '.codex',
  '.flow',
  '.git',
  '.github',
  '.playwright-mcp',
  '.pytest_cache',
  '.venv',
  '.vercel',
  '.vscode',
  '__pycache__',
  'data_compressed',
  'demo_sources',
  'docs',
  'node_modules',
  'out',
  'synthseg_repo',
  'test-results',
]);

const BLOCKED_RESEARCH_DATA_EXTENSIONS = Object.freeze([
  '.czi', '.dcm', '.dicom', '.ima', '.lif', '.lsm', '.nd2', '.nii', '.nii.gz',
  '.oib', '.oif', '.ome.tif', '.ome.tiff', '.roi', '.tif', '.tiff',
]);

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

export function walkReleaseAssetFiles(rootDir) {
  return walkFiles(rootDir);
}

function relativeParts(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep);
}

function researchDataExtension(file) {
  const name = path.basename(file).toLowerCase();
  return BLOCKED_RESEARCH_DATA_EXTENSIONS.find(extension => name.endsWith(extension)) || '';
}

export function assertReleaseArtifactFileHygiene(rootDir, files) {
  for (const file of files) {
    const parts = relativeParts(rootDir, file);
    const relative = parts.join('/');
    assert.equal(
      parts.some(part => BLOCKED_PATH_PARTS.has(part) || part.startsWith('.env')),
      false,
      `${relative} must not ship in release assets`,
    );
    assert.equal(BLOCKED_BASENAMES.has(path.basename(file)), false, `${relative} must not ship in release assets`);
    assert.equal(researchDataExtension(file), '', `${relative} must not ship loose research imaging data in release assets`);
    assert.ok(statSync(file).size > 0, `${relative} must not be empty`);
  }
}

function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  assert.ok(match, 'release assets require an exact semantic version tag');
  return match[1];
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function expectedNames(version) {
  return [
    `VoxelLab-${version}-macOS-arm64.dmg`,
    `VoxelLab-${version}-Windows-x64.exe`,
    'SHA256SUMS',
  ];
}

function assertChecksums(rootDir, version) {
  const checksumPath = path.join(rootDir, 'SHA256SUMS');
  const lines = readFileSync(checksumPath, 'utf8').trim().split('\n');
  const expectedArtifacts = expectedNames(version).filter(name => name !== 'SHA256SUMS');
  assert.equal(lines.length, expectedArtifacts.length, 'SHA256SUMS must cover only the two installers');
  const entries = new Map(lines.map((line) => {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line);
    assert.ok(match, `invalid SHA256SUMS line: ${line}`);
    return [match[2], match[1]];
  }));
  assert.deepEqual([...entries.keys()].sort(), [...expectedArtifacts].sort(), 'SHA256SUMS must name both installers exactly');
  for (const name of expectedArtifacts) {
    assert.equal(entries.get(name), sha256(path.join(rootDir, name)), `${name} checksum must match its contents`);
  }
}

export function checkReleaseAssets(rootDir = 'public-assets', tag = '') {
  const resolvedRoot = path.resolve(rootDir);
  const version = versionFromTag(tag);
  const files = walkFiles(resolvedRoot);
  assert.ok(files.length > 0, `${resolvedRoot} contains no release assets`);
  assertReleaseArtifactFileHygiene(resolvedRoot, files);
  for (const file of files) {
    const name = path.basename(file);
    assert.equal(
      name === 'RELEASES' || path.extname(name).toLowerCase() === '.nupkg',
      false,
      `${name} must not ship updater packages or metadata without an updater`,
    );
  }
  const names = files.map(file => path.basename(file)).sort();
  assert.deepEqual(names, expectedNames(version).sort(), 'public release must contain exactly the two installers and SHA256SUMS');
  assertChecksums(resolvedRoot, version);
  return { files, names, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkReleaseAssets(process.argv[2] || 'public-assets', process.argv[3] || '');
  console.log(`OK: v${result.version} publishes only the macOS installer, Windows installer, and checksums`);
}
