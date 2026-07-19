/* global console, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertReleaseVersion({ packageJson, packageLock, refName = '' }) {
  const version = String(packageJson?.version || '');
  assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json must contain a semantic version');
  assert.equal(packageLock?.version, version, 'package-lock.json version must match package.json');
  assert.equal(packageLock?.packages?.['']?.version, version, 'package-lock.json root package version must match package.json');
  if (refName) assert.equal(refName, `v${version}`, 'release tag must match package.json version');
  return version;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const version = assertReleaseVersion({
    packageJson: readJson(path.join(root, 'package.json')),
    packageLock: readJson(path.join(root, 'package-lock.json')),
    refName: process.argv[2] || process.env.GITHUB_REF_NAME || '',
  });
  console.log(`OK: release version ${version} matches package metadata${process.argv[2] || process.env.GITHUB_REF_NAME ? ' and tag' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
