import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function pyprojectVersion(pyprojectText) {
  const project = String(pyprojectText || '').match(/(?:^|\n)\[project\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1] || '';
  return project.match(/(?:^|\n)version\s*=\s*["']([^"']+)["']/)?.[1] || '';
}

function htmlVersion(indexHtml) {
  return String(indexHtml || '').match(/<meta name="application-version" content="([^"]+)" \/>/)?.[1] || '';
}

export function assertReleaseVersion({ packageJson, packageLock, pyprojectText = '', indexHtml = '', refName = '' }) {
  const version = String(packageJson?.version || '');
  assert.match(version, /^\d+\.\d+\.\d+$/, 'package.json must contain a semantic version');
  assert.equal(packageLock?.version, version, 'package-lock.json version must match package.json');
  assert.equal(packageLock?.packages?.['']?.version, version, 'package-lock.json root package version must match package.json');
  if (pyprojectText) assert.equal(pyprojectVersion(pyprojectText), version, 'pyproject.toml version must match package.json');
  if (indexHtml) assert.equal(htmlVersion(indexHtml), version, 'browser application version must match package.json');
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
    pyprojectText: readFileSync(path.join(root, 'pyproject.toml'), 'utf8'),
    indexHtml: readFileSync(path.join(root, 'index.html'), 'utf8'),
    refName: process.argv[2] || process.env.GITHUB_REF_NAME || '',
  });
  console.log(`OK: release version ${version} matches package metadata${process.argv[2] || process.env.GITHUB_REF_NAME ? ' and tag' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
