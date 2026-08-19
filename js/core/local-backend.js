function parseBooleanQuery(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function hostnameLooksLocal(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) return true;
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(value)) return true;
  if (value.endsWith('.local')) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(value)) return true;
  const private172 = value.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

const location = globalThis.location ?? { search: '', hostname: '' };
const query = new URLSearchParams(location.search);
const forcedLocalBackend = parseBooleanQuery(query.get('localBackend'));
const legacyHosted = parseBooleanQuery(query.get('hosted'));

export const HAS_LOCAL_BACKEND = forcedLocalBackend != null
  ? forcedLocalBackend
  : legacyHosted != null
    ? !legacyHosted
    : hostnameLooksLocal(location.hostname);
