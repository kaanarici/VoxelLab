/* global console, process */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function ghApi(endpoint) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function assertMissing(label, endpoint, probe) {
  const result = probe(endpoint);
  if (result.status === 0) throw new Error(`${label} already exists; release identities are immutable`);
  if (result.status !== 1 || !/HTTP 404/.test(result.output)) {
    throw new Error(`could not verify that ${label} is unused: ${result.output.trim() || `gh exited ${result.status}`}`);
  }
}

export function checkReleaseIdentity(repository, tag, probe = ghApi) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name');
  assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/, 'release tag must be canonical semver');
  const encodedTag = encodeURIComponent(tag);
  assertMissing(`tag ${tag}`, `repos/${repository}/git/ref/tags/${encodedTag}`, probe);
  assertMissing(`release ${tag}`, `repos/${repository}/releases/tags/${encodedTag}`, probe);
  return { repository, tag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.argv[2] || process.env.GITHUB_REPOSITORY || '';
  const tag = process.argv[3] || process.env.RELEASE_TAG || '';
  const result = checkReleaseIdentity(repository, tag);
  console.log(`OK: release identity ${result.tag} is unused in ${result.repository}`);
}
