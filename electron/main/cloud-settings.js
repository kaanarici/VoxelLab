import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'cloud-settings.json';
const MODAL_FUNCTIONS = Object.freeze({
  get_upload_urls: 'get-upload-urls',
  start_processing: 'start-processing',
  check_status: 'check-status',
});

function settingsPath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

function cleanString(value, max = 2048) {
  return String(value || '').trim().slice(0, max);
}

function cleanOrigins(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || '').split(',');
  const out = [];
  for (const item of raw) {
    const value = cleanString(item);
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') out.push(url.origin);
    } catch {
      continue;
    }
  }
  return [...new Set(out)];
}

function modalEndpoint(base, functionName) {
  const suffix = MODAL_FUNCTIONS[functionName];
  const raw = cleanString(base).replace(/\/+$/, '');
  const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  let host = parsed.hostname.endsWith('.modal.run')
    ? parsed.hostname.slice(0, -'.modal.run'.length)
    : parsed.hostname;
  for (const known of Object.values(MODAL_FUNCTIONS)) {
    if (host.endsWith(`-${known}`)) {
      host = host.slice(0, -(known.length + 1));
      break;
    }
  }
  return `https://${host}-${suffix}.modal.run`;
}

function validModalBase(value) {
  try {
    modalEndpoint(value, 'check_status');
    return true;
  } catch {
    return false;
  }
}

async function readRawSettings(userDataPath) {
  try {
    return JSON.parse(await fs.readFile(settingsPath(userDataPath), 'utf8'));
  } catch {
    return {};
  }
}

function publicSettings(raw, userDataPath) {
  const modalWebhookBase = cleanString(raw.modalWebhookBase);
  const r2PublicUrl = cleanString(raw.r2PublicUrl);
  const trustedUploadOrigins = cleanOrigins(raw.trustedUploadOrigins);
  const hasModalAuthToken = !!cleanString(raw.modalAuthToken, 8192);
  const cloudProcessing = raw.cloudProcessing !== false;
  return {
    source: 'desktop',
    storagePath: settingsPath(userDataPath),
    modalWebhookBase,
    r2PublicUrl,
    trustedUploadOrigins,
    cloudProcessing,
    hasModalAuthToken,
    configured: !!(cloudProcessing && validModalBase(modalWebhookBase) && hasModalAuthToken && (r2PublicUrl || trustedUploadOrigins.length)),
  };
}

export async function readCloudSettings(userDataPath) {
  return publicSettings(await readRawSettings(userDataPath), userDataPath);
}

export async function saveCloudSettings(userDataPath, payload = {}) {
  const previous = await readRawSettings(userDataPath);
  const next = {
    modalWebhookBase: cleanString(payload.modalWebhookBase),
    r2PublicUrl: cleanString(payload.r2PublicUrl),
    trustedUploadOrigins: cleanOrigins(payload.trustedUploadOrigins),
    cloudProcessing: payload.cloudProcessing !== false,
    modalAuthToken: payload.clearModalAuthToken
      ? ''
      : cleanString(payload.modalAuthToken, 8192) || cleanString(previous.modalAuthToken, 8192),
    savedAt: new Date().toISOString(),
  };
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(settingsPath(userDataPath), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(settingsPath(userDataPath), 0o600);
  } catch {
    // File permissions are best-effort on non-POSIX filesystems.
  }
  return publicSettings(next, userDataPath);
}

export async function clearCloudSettings(userDataPath) {
  try {
    await fs.rm(settingsPath(userDataPath), { force: true });
  } catch {
    // Missing settings file is already clear.
  }
  return readCloudSettings(userDataPath);
}

export async function handleDesktopCloudRequest(request, userDataPath, net) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/cloud/')) return null;
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }
  const functionName = url.pathname.split('/').pop();
  if (!Object.hasOwn(MODAL_FUNCTIONS, functionName)) {
    return Response.json({ error: 'unknown cloud function' }, { status: 404 });
  }
  const settings = await readRawSettings(userDataPath);
  if (settings.cloudProcessing === false) {
    return Response.json({ error: 'cloud processing is disabled' }, { status: 503 });
  }
  const modalWebhookBase = cleanString(settings.modalWebhookBase);
  const token = cleanString(settings.modalAuthToken, 8192);
  if (!modalWebhookBase || !token) {
    return Response.json({ error: 'cloud processing is not configured' }, { status: 503 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Response.json({ error: 'expected JSON object body' }, { status: 400 });
  }
  let target;
  try {
    target = modalEndpoint(modalWebhookBase, functionName);
  } catch {
    return Response.json({ error: 'invalid Modal webhook base' }, { status: 503 });
  }
  return net.fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(payload && typeof payload === 'object' ? payload : {}), token }),
  });
}
