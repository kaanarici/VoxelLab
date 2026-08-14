import assert from 'node:assert/strict';
import { test } from 'node:test';

import { releaseSigningMode } from '../scripts/check_release_signing_env.mjs';

const macSecrets = {
  VOXELLAB_MACOS_CERTIFICATE_BASE64: 'certificate',
  VOXELLAB_MACOS_CERTIFICATE_PASSWORD: 'password',
  VOXELLAB_OSX_IDENTITY: 'Developer ID Application: VoxelLab',
  VOXELLAB_APPLE_API_KEY_P8: 'private-key',
  VOXELLAB_APPLE_API_KEY_ID: 'key-id',
  VOXELLAB_APPLE_API_ISSUER: 'issuer',
};

test('release signing requires explicit unsigned mode when credentials are absent', () => {
  assert.equal(releaseSigningMode('darwin', { VOXELLAB_ALLOW_UNSIGNED_RELEASE: 'true' }), 'unsigned');
  assert.throws(() => releaseSigningMode('win32', {}), /not explicitly enabled/);
});

test('release signing rejects partial credential matrices', () => {
  assert.throws(
    () => releaseSigningMode('darwin', { VOXELLAB_OSX_IDENTITY: 'identity' }),
    /partially configured/,
  );
  assert.throws(
    () => releaseSigningMode('win32', { VOXELLAB_WINDOWS_CERTIFICATE_BASE64: 'certificate' }),
    /VOXELLAB_WINDOWS_CERTIFICATE_PASSWORD/,
  );
});

test('release signing accepts complete credential matrices', () => {
  assert.equal(releaseSigningMode('darwin', macSecrets), 'signed');
  assert.equal(releaseSigningMode('win32', {
    VOXELLAB_WINDOWS_CERTIFICATE_BASE64: 'certificate',
    VOXELLAB_WINDOWS_CERTIFICATE_PASSWORD: 'password',
  }), 'signed');
});
