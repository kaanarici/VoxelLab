import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReleaseIdentity } from '../scripts/check_release_identity.mjs';

const missing = () => ({ status: 1, output: 'gh: Not Found (HTTP 404)' });

test('release identity check requires both the tag and release to be unused', () => {
  const endpoints = [];
  const result = checkReleaseIdentity('kaanarici/VoxelLab', 'v1.2.0', endpoint => {
    endpoints.push(endpoint);
    return missing();
  });
  assert.deepEqual(result, { repository: 'kaanarici/VoxelLab', tag: 'v1.2.0' });
  assert.deepEqual(endpoints, [
    'repos/kaanarici/VoxelLab/git/ref/tags/v1.2.0',
    'repos/kaanarici/VoxelLab/releases/tags/v1.2.0',
  ]);
});

test('release identity check rejects an existing tag before publication', () => {
  assert.throws(
    () => checkReleaseIdentity('kaanarici/VoxelLab', 'v1.2.0', () => ({ status: 0, output: '{}' })),
    /tag v1\.2\.0 already exists/,
  );
});

test('release identity check fails closed on an inconclusive API response', () => {
  assert.throws(
    () => checkReleaseIdentity('kaanarici/VoxelLab', 'v1.2.0', () => ({ status: 1, output: 'HTTP 503' })),
    /could not verify/,
  );
});

test('release identity check rejects noncanonical repository and tag inputs', () => {
  assert.throws(() => checkReleaseIdentity('not a repo', 'v1.2.0', missing), /owner\/name/);
  assert.throws(() => checkReleaseIdentity('kaanarici/VoxelLab', 'latest', missing), /canonical semver/);
});
