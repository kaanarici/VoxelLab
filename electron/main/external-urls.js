const TRUSTED_EXTERNAL_URLS = Object.freeze([
  'https://github.com/kaanaricio/VoxelLab',
]);

export function isTrustedExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return TRUSTED_EXTERNAL_URLS.some((trusted) => {
      const base = new URL(trusted);
      return url.protocol === 'https:'
        && url.host === base.host
        && (url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname}/`));
    });
  } catch {
    return false;
  }
}

export function openTrustedExternalUrl(shell, value) {
  if (!isTrustedExternalUrl(value)) return false;
  shell.openExternal(String(value));
  return true;
}
