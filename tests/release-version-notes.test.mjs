import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { assertReleaseVersion } from '../scripts/check_release_version.mjs';
import { extractReleaseNotes } from '../scripts/extract_release_notes.mjs';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const packageLock = JSON.parse(readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'));
const pyprojectText = readFileSync(fileURLToPath(new URL('../pyproject.toml', import.meta.url)), 'utf8');
const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');

test('release version matches package metadata and tag', () => {
  assert.equal(assertReleaseVersion({ packageJson, packageLock, pyprojectText, indexHtml, refName: `v${packageJson.version}` }), packageJson.version);
  assert.throws(
    () => assertReleaseVersion({ packageJson, packageLock, refName: 'v9.9.9' }),
    /release tag must match/,
  );
  assert.throws(
    () => assertReleaseVersion({
      packageJson,
      packageLock,
      pyprojectText: pyprojectText.replace(/version\s*=\s*["'][^"']+["']/, 'version = "9.9.9"'),
    }),
    /pyproject\.toml version must match/,
  );
  assert.throws(
    () => assertReleaseVersion({
      packageJson,
      packageLock,
      indexHtml: indexHtml.replace(`content="${packageJson.version}"`, 'content="9.9.9"'),
    }),
    /browser application version must match/,
  );
});

test('release notes come from the current changelog section only', () => {
  const notes = extractReleaseNotes(changelog, packageJson.version);
  assert.ok(notes.trim().length > 0);
  assert.doesNotMatch(notes, /^## \[/m);
  assert.doesNotMatch(notes, /Initial public release/);
});
