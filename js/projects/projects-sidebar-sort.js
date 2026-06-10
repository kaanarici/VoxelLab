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
