// localStorage-backed durability for the per-series view session: which series
// was active last, and for each series the last slice, view mode, window/level,
// and overlay toggles. The in-memory source of truth stays `state.seriesViewMemory`
// (see series-view-memory.js); this module only mirrors it to disk and rehydrates
// it on boot. Keyed by `seriesIdentityKey` so it survives reloads and re-orders.

import { state } from '../state.js';
import { seriesIdentityKey } from '../../series/series-identity.js';

const STORAGE_KEY = 'mri-viewer/session/v1';
// Cap stored per-series entries so a long-lived install can't grow the blob
// unbounded; oldest insertion-order keys are dropped first. Generous headroom.
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

function pruneViews(views) {
  const keys = Object.keys(views);
  if (keys.length <= MAX_ENTRIES) return views;
  const trimmed = {};
  for (const key of keys.slice(keys.length - MAX_ENTRIES)) trimmed[key] = views[key];
  return trimmed;
}

// Hydrate `state.seriesViewMemory` from disk. Call once at boot, before the first
// series selection so remembered views are available to viewStateForSeries.
export function hydrateSeriesViewMemory() {
  const store = readRaw();
  if (store && store.views && typeof store.views === 'object') {
    state.seriesViewMemory = { ...store.views };
  }
  lastActiveKey = (store && typeof store.lastActiveKey === 'string') ? store.lastActiveKey : '';
}

export function setLastActiveSeries(series) {
  const key = seriesIdentityKey(series, state.manifest);
  if (key) lastActiveKey = key;
}

// Index of the series that was active in the previous session, or -1 if none is
// recorded or it no longer exists in the manifest.
export function persistedInitialSeriesIndex(manifest) {
  if (!lastActiveKey || !manifest?.series?.length) return -1;
  return manifest.series.findIndex((s) => seriesIdentityKey(s, manifest) === lastActiveKey);
}

export function persistSessionNow() {
  try {
    const views = pruneViews(state.seriesViewMemory || {});
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lastActiveKey, views }));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

export function scheduleSessionPersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSessionNow();
  }, 250);
}
