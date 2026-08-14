/* global console, process */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = changelog.match(new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm'));
  assert.ok(heading, `CHANGELOG.md must contain a [${version}] release section`);
  const remainder = changelog.slice((heading.index || 0) + heading[0].length).replace(/^\r?\n/, '');
  const nextHeading = remainder.search(/^## \[/m);
  const notes = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  assert.ok(notes, `CHANGELOG.md [${version}] release notes must not be empty`);
  return notes + '\n';
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const changelogPath = path.resolve(process.argv[2] || path.join(root, 'CHANGELOG.md'));
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : '';
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const notes = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version);
  if (outputPath) writeFileSync(outputPath, notes);
  else console.log(notes.trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
