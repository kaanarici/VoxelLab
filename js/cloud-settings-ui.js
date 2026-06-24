import { initCloud } from './cloud.js';
import { readCloudSettings, saveCloudSettings } from './cloud-settings.js';
import { getConfig, reloadConfig } from './config.js';
import { $, closeModal, openModal } from './dom.js';
import { notify } from './notify.js';

let wired = false;

function fieldValue(id) {
  return String($(id)?.value || '').trim();
}

function setFieldValue(id, value) {
  const field = $(id);
  if (field) field.value = value || '';
}

function setStatus(message, kind = '') {
  const status = $('cloud-settings-status');
  if (!status) return;
  status.className = `cloud-settings-status${kind ? ` is-${kind}` : ''}`;
  status.textContent = message;
}

function setPath(message) {
  const path = $('cloud-settings-path');
  if (path) path.textContent = message;
}

function applySettingsToForm(settings) {
  setFieldValue('cloud-settings-modal-base', settings.modalWebhookBase);
  setFieldValue('cloud-settings-r2', settings.r2PublicUrl);
  setFieldValue('cloud-settings-origins', settings.trustedUploadOrigins.join(', '));
  setFieldValue('cloud-settings-modal-token', '');
  const token = $('cloud-settings-modal-token');
  if (token) {
    token.placeholder = settings.hasModalAuthToken
      ? 'Saved token present; leave blank to keep it'
      : 'Paste Modal auth token';
  }
  const enabled = $('cloud-settings-enabled');
  if (enabled) enabled.checked = settings.cloudProcessing !== false;
  const place = settings.source === 'desktop'
    ? 'Desktop app data'
    : settings.source === 'local-env'
      ? 'Local .env'
      : 'Not writable in this static viewer';
  setPath(settings.storagePath ? `${place}: ${settings.storagePath}` : place);
  if (settings.configured) setStatus('Cloud GPU processing is configured.', 'ready');
  else if (settings.source === 'static') setStatus('Open the desktop app or run npm start to save cloud settings.', 'warning');
  else setStatus('Enter Modal webhook base, Modal auth token, and R2/upload origin settings.', 'warning');
}

function payloadFromForm(extra = {}) {
  return {
    modalWebhookBase: fieldValue('cloud-settings-modal-base'),
    modalAuthToken: fieldValue('cloud-settings-modal-token'),
    r2PublicUrl: fieldValue('cloud-settings-r2'),
    trustedUploadOrigins: fieldValue('cloud-settings-origins').split(',').map(item => item.trim()).filter(Boolean),
    cloudProcessing: $('cloud-settings-enabled')?.checked !== false,
    ...extra,
  };
}

async function refreshRuntimeCloud() {
  const cfg = await reloadConfig();
  initCloud(cfg.modalWebhookBase, cfg.r2PublicUrl, {
    enabled: cfg.features?.cloudProcessing !== false,
    trustedUploadOrigins: cfg.trustedUploadOrigins,
  });
  return cfg;
}

function wireCloudSettingsModal() {
  if (wired) return;
  wired = true;
  $('cloud-settings-cancel')?.addEventListener('click', () => closeModal('cloud-settings-modal'));
  $('cloud-settings-save')?.addEventListener('click', async () => {
    try {
      setStatus('Saving cloud settings...');
      const settings = await saveCloudSettings(payloadFromForm());
      await refreshRuntimeCloud();
      applySettingsToForm(settings);
      notify('Cloud settings saved.', { duration: 3000 });
    } catch (error) {
      setStatus(error?.message || 'Cloud settings could not be saved.', 'error');
    }
  });
  $('cloud-settings-clear-token')?.addEventListener('click', async () => {
    try {
      setStatus('Forgetting saved Modal token...');
      const settings = await saveCloudSettings(payloadFromForm({ clearModalAuthToken: true, modalAuthToken: '' }));
      await refreshRuntimeCloud();
      applySettingsToForm(settings);
      notify('Saved Modal token removed.', { duration: 3000 });
    } catch (error) {
      setStatus(error?.message || 'Saved token could not be removed.', 'error');
    }
  });
}

export async function openCloudSettingsModal() {
  wireCloudSettingsModal();
  openModal('cloud-settings-modal');
  try {
    applySettingsToForm(await readCloudSettings());
  } catch (error) {
    const cfg = getConfig();
    applySettingsToForm({
      source: 'static',
      storagePath: '',
      modalWebhookBase: cfg.modalWebhookBase || '',
      r2PublicUrl: cfg.r2PublicUrl || '',
      trustedUploadOrigins: cfg.trustedUploadOrigins || [],
      cloudProcessing: cfg.features?.cloudProcessing !== false,
      hasModalAuthToken: false,
      configured: false,
    });
    setStatus(error?.message || 'Cloud settings are not writable here.', 'error');
  }
}
