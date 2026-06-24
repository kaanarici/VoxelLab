import { state } from '../state.js';
import { canUseMpr3D } from '../../series/series-capabilities.js';
import { seriesIdentityKey } from '../../series/series-identity.js';
import { clampSliceIndex, getCurrentSeries } from './viewer-selectors.js';
import { scheduleSessionPersist } from './session-persistence.js';

const RESTORABLE_SERIES_MODES = new Set(['2d', 'mpr', '3d', 'mpr3d']);
const PRESERVABLE_SERIES_MODES = new Set([...RESTORABLE_SERIES_MODES, 'cmp']);

export function seriesViewMemoryKey(series, manifest = state.manifest) {
  return seriesIdentityKey(series, manifest);
}

export function normalModeForSeries(series, mode, { preserveCompare = false } = {}) {
  const allowed = preserveCompare ? PRESERVABLE_SERIES_MODES : RESTORABLE_SERIES_MODES;
  const value = allowed.has(mode) ? mode : '2d';
  if ((value === 'mpr' || value === '3d' || value === 'mpr3d') && !canUseMpr3D(series)) return '2d';
  return value;
}

export function rememberSeriesViewState(series = getCurrentSeries()) {
  const key = seriesViewMemoryKey(series);
  if (!key) return null;
  const entry = {
    mode: normalModeForSeries(series, state.mode),
    sliceIdx: clampSliceIndex(state.sliceIdx, series),
    window: state.window,
    level: state.level,
    overlays: {
      useBrain: !!state.useBrain,
      useSeg: !!state.useSeg,
      useRegions: !!state.useRegions,
      useSym: !!state.useSym,
    },
    // Locked anatomy structures (numeric ids). Sets don't survive JSON, so store
    // a sorted array; rehydrated to a Set on restore.
    lockedLabels: state.lockedLabels instanceof Set
      ? [...state.lockedLabels].sort((a, b) => a - b)
      : [],
  };
  state.seriesViewMemory = {
    ...(state.seriesViewMemory || {}),
    [key]: entry,
  };
  scheduleSessionPersist();
  return entry;
}

export function viewStateForSeries(series, { preserveSlice = false } = {}) {
  const saved = series?.slug ? state.seriesViewMemory?.[seriesViewMemoryKey(series)] : null;
  if (preserveSlice) {
    return {
      mode: normalModeForSeries(series, state.mode, { preserveCompare: true }),
      sliceIdx: clampSliceIndex(state.sliceIdx, series),
      window: null,
      level: null,
      overlays: null,
      lockedLabels: [],
      restored: false,
    };
  }
  if (!saved) {
    return { mode: '2d', sliceIdx: 0, window: null, level: null, overlays: null, lockedLabels: [], restored: false };
  }
  return {
    mode: normalModeForSeries(series, saved.mode),
    sliceIdx: clampSliceIndex(saved.sliceIdx, series),
    window: Number.isFinite(saved.window) ? saved.window : null,
    level: Number.isFinite(saved.level) ? saved.level : null,
    overlays: saved.overlays || null,
    lockedLabels: Array.isArray(saved.lockedLabels) ? saved.lockedLabels : [],
    restored: true,
  };
}
