/* global console, process */

const PLATFORM_VARIABLES = Object.freeze({
  darwin: [
    'VOXELLAB_MACOS_CERTIFICATE_BASE64',
    'VOXELLAB_MACOS_CERTIFICATE_PASSWORD',
    'VOXELLAB_OSX_IDENTITY',
    'VOXELLAB_APPLE_API_KEY_P8',
    'VOXELLAB_APPLE_API_KEY_ID',
    'VOXELLAB_APPLE_API_ISSUER',
  ],
  win32: [
    'VOXELLAB_WINDOWS_CERTIFICATE_BASE64',
    'VOXELLAB_WINDOWS_CERTIFICATE_PASSWORD',
  ],
});

export function releaseSigningMode(platform, env = process.env) {
  const names = PLATFORM_VARIABLES[platform];
  if (!names) throw new Error(`unsupported release signing platform: ${platform}`);
  const configured = names.filter(name => String(env[name] ?? '').trim() !== '');
  if (configured.length === names.length) return 'signed';
  if (configured.length > 0) {
    const missing = names.filter(name => !configured.includes(name));
    throw new Error(`${platform} release signing is partially configured; missing ${missing.join(', ')}`);
  }
  if (env.VOXELLAB_ALLOW_UNSIGNED_RELEASE !== 'true') {
    throw new Error(`${platform} release signing is absent and unsigned release mode is not explicitly enabled`);
  }
  return 'unsigned';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(releaseSigningMode(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
