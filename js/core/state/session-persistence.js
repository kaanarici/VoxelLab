import { state } from '../state.js';
import { seriesIdentityKey } from '../series-identity.js';

const STORAGE_KEY = 'mri-viewer/session/v1';

const MAX_ENTRIES = 300;

let lastActiveKey = '';
let persistTimer = null;

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isSessionRecord(value) {
  return value != null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function pruneViews(views) {
  const keys = Object.keys(views);
  if (keys.length <= MAX_ENTRIES) return views;
  const trimmed = {};
  for (const key of keys.slice(keys.length - MAX_ENTRIES)) trimmed[key] = views[key];
  return trimmed;
}

export function hydrateSeriesViewMemory() {
  const store = readRaw();
  if (isSessionRecord(store?.views)) {
    state.seriesViewMemory = { ...store.views };
  }
  const persistedKey = store?.lastActiveKey;
  lastActiveKey = persistedKey != null && String(persistedKey) === persistedKey ? persistedKey : '';
}

export function setLastActiveSeries(series) {
  const key = seriesIdentityKey(series, state.manifest);
  if (key) lastActiveKey = key;
}

export function persistedInitialSeriesIndex(manifest) {
  if (!lastActiveKey || !manifest?.series?.length) return -1;
  return manifest.series.findIndex((s) => seriesIdentityKey(s, manifest) === lastActiveKey);
}

export function persistSessionNow() {
  try {
    const views = pruneViews(state.seriesViewMemory || {});
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lastActiveKey, views }));
  } catch {

  }
}

export function scheduleSessionPersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSessionNow();
  }, 250);
}
