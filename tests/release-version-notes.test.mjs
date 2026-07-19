import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { assertReleaseVersion } from '../scripts/check_release_version.mjs';
import { extractReleaseNotes } from '../scripts/extract_release_notes.mjs';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const packageLock = JSON.parse(readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'));
const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');

test('release version matches package metadata and tag', () => {
  assert.equal(assertReleaseVersion({ packageJson, packageLock, refName: `v${packageJson.version}` }), packageJson.version);
  assert.throws(
    () => assertReleaseVersion({ packageJson, packageLock, refName: 'v9.9.9' }),
    /release tag must match/,
  );
});

test('release notes come from the current changelog section only', () => {
  const notes = extractReleaseNotes(changelog, packageJson.version);
  assert.match(notes, /desktop/i);
  assert.match(notes, /Initial public release/);
  assert.doesNotMatch(notes, /\[1\.0\.1\]/);
});
