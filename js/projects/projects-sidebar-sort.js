// Series sort options and ordering helpers shared by tree-render (row layout,
// study-type grouping) and context-menus (sort popover). DOM-free.

import { state } from '../core/state.js';
import { syncSeriesIdxForActiveSlug } from '../core/state/viewer-commands.js';

export const SORT_POPOVER_OPTIONS = [
  { label: 'Name A→Z', key: 'name-asc' },
  { label: 'Name Z→A', key: 'name-desc' },
  { label: 'Study type', key: 'study-type' },
  { label: 'Slices ↑', key: 'slices-asc' },
  { label: 'Slices ↓', key: 'slices-desc' },
];

// Persisted sidebar sort selection so the chosen order survives a refresh.
const SORT_STORAGE_KEY = 'mri-viewer/sidebarSort/v1';
const VALID_SORT_KEYS = new Set(SORT_POPOVER_OPTIONS.map(o => o.key));

export function loadSidebarSort() {
  try {
    const key = localStorage.getItem(SORT_STORAGE_KEY) || '';
    return VALID_SORT_KEYS.has(key) ? key : '';
  } catch {
    return '';
  }
}

export function saveSidebarSort(key) {
  try {
    if (VALID_SORT_KEYS.has(key)) localStorage.setItem(SORT_STORAGE_KEY, key);
    else localStorage.removeItem(SORT_STORAGE_KEY);
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// DICOM modality code → display label. Non-obvious codes only; self-explanatory
// codes (CT, MR, US, etc.) pass through. Example: { PT: 'PET', CR: 'X-Ray' }
const MODALITY_LABEL = { PT: 'PET', NM: 'Nuclear Medicine', CR: 'X-Ray', DX: 'X-Ray', XA: 'Angiography' };

export function studyType(s) {
  const mod = (s.modality || '').toUpperCase();
  return MODALITY_LABEL[mod] || mod || 'Other';
}

export function sortSeriesArray(arr, key) {
  switch (key) {
    case 'name-asc': arr.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break;
    case 'name-desc': arr.sort((a, b) => (b.name || '').localeCompare(a.name || '')); break;
    case 'study-type': arr.sort((a, b) => studyType(a).localeCompare(studyType(b))); break;
    case 'slices-asc': arr.sort((a, b) => (a.slices || 0) - (b.slices || 0)); break;
    case 'slices-desc': arr.sort((a, b) => (b.slices || 0) - (a.slices || 0)); break;
  }
}

export function sortManifestSeries(manifest, key) {
  const activeSlug = manifest.series[state.seriesIdx]?.slug || '';
  sortSeriesArray(manifest.series, key);
  syncSeriesIdxForActiveSlug(manifest, activeSlug);
}
