export const ASK_MODEL_STORAGE_KEY = 'mri-viewer/aiModel/v2';
const ASK_MODEL_STORAGE_KEY_V1 = 'mri-viewer/aiModel/v1';

const LEGACY_V1_KEYS = {
  'opus-4.8': 'claude:opus',
  'gpt-5.5': 'codex:gpt-5.5',
};

export function migrateAskModelKey(stored) {
  const key = String(stored || '').trim();
  if (!key) return '';
  return LEGACY_V1_KEYS[key] || key;
}

export function readStoredAskModelKey() {
  try {
    const current = localStorage.getItem(ASK_MODEL_STORAGE_KEY);
    if (current) return migrateAskModelKey(current);
    return migrateAskModelKey(localStorage.getItem(ASK_MODEL_STORAGE_KEY_V1));
  } catch {
    return '';
  }
}

export function writeStoredAskModelKey(key) {
  const value = String(key || '').trim();
  if (!value) return;
  try { localStorage.setItem(ASK_MODEL_STORAGE_KEY, value); } catch {              }
}

export function pickAskModel(models, storedKey, preferredProvider = '') {
  const list = Array.isArray(models) ? models.filter((item) => item && item.key) : [];
  if (!list.length) return null;
  const wanted = migrateAskModelKey(storedKey);
  const exact = list.find((item) => item.key === wanted);
  if (exact) return exact;
  const provider = String(preferredProvider || '').trim();
  const pool = provider ? list.filter((item) => item.provider === provider) : list;
  const source = pool.length ? pool : list;
  const opus = source.find((item) => item.model === 'opus');
  if (opus) return opus;
  return source[0];
}

export function askModelRequestFields(choice) {
  if (!choice || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype) return {};
  const fields = {};
  if (choice.provider) fields.provider = choice.provider;
  if (choice.model) fields.model = choice.model;
  return fields;
}

export function askModelDisclosure(choice) {
  const model = String(choice?.label || '').trim();
  const provider = String(choice?.group || choice?.provider || '').trim();
  const destination = model && provider
    ? `${model} via ${provider}`
    : model || provider || 'the selected AI provider';
  return {
    text: `Sends images to ${destination} · current slice, selections, and study details · not a diagnosis`,
    title: 'Images leave this device when you send a question. The selected provider receives the current slice, selected regions, and study details, and may inspect other slices when needed.',
  };
}
