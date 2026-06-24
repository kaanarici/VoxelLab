import { HAS_LOCAL_BACKEND } from './core/state.js';
import { localApiHeaders } from './config.js';

function settingsHost() {
  const desktop = globalThis.voxellabDesktop;
  if (desktop?.getCloudSettings && desktop?.saveCloudSettings) return 'desktop';
  if (HAS_LOCAL_BACKEND) return 'local';
  return 'static';
}

function normalizeSettings(payload = {}, host = settingsHost()) {
  const origins = Array.isArray(payload.trustedUploadOrigins)
    ? payload.trustedUploadOrigins
    : String(payload.trustedUploadOrigins || '').split(',');
  return {
    source: payload.source || host,
    storagePath: payload.storagePath || '',
    modalWebhookBase: String(payload.modalWebhookBase || ''),
    r2PublicUrl: String(payload.r2PublicUrl || ''),
    trustedUploadOrigins: origins.map(item => String(item || '').trim()).filter(Boolean),
    cloudProcessing: payload.cloudProcessing !== false,
    hasModalAuthToken: payload.hasModalAuthToken === true,
    configured: payload.configured === true,
  };
}

async function fetchLocalSettings(method = 'GET', body = null) {
  const response = await fetch('/api/cloud-settings', {
    method,
    headers: localApiHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Cloud settings failed: ${response.status}`);
  return response.json();
}

export async function readCloudSettings() {
  const host = settingsHost();
  if (host === 'desktop') return normalizeSettings(await globalThis.voxellabDesktop.getCloudSettings(), host);
  if (host === 'local') return normalizeSettings(await fetchLocalSettings(), host);
  return normalizeSettings({
    source: 'static',
    cloudProcessing: false,
    configured: false,
  }, host);
}

export async function saveCloudSettings(payload) {
  const host = settingsHost();
  if (host === 'desktop') return normalizeSettings(await globalThis.voxellabDesktop.saveCloudSettings(payload), host);
  if (host === 'local') return normalizeSettings(await fetchLocalSettings('POST', payload), host);
  throw new Error('Cloud settings can be saved in the desktop app or from npm start.');
}

export async function clearCloudSettings() {
  const host = settingsHost();
  if (host === 'desktop' && globalThis.voxellabDesktop?.clearCloudSettings) {
    return normalizeSettings(await globalThis.voxellabDesktop.clearCloudSettings(), host);
  }
  if (host === 'local') {
    return saveCloudSettings({
      modalWebhookBase: '',
      modalAuthToken: '',
      r2PublicUrl: '',
      trustedUploadOrigins: [],
      cloudProcessing: false,
      clearModalAuthToken: true,
    });
  }
  return readCloudSettings();
}
