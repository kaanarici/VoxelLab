import { state } from '../core/state.js';
import { listDerivedRegistryEntriesForSeriesWithSkipped } from '../derived-objects.js';
import { replaceLocalDerivedBucket, setLocalRuntimeMapEntry } from '../runtime/viewer-runtime.js';
import { attachRegionOverlay, deserializeSegPayload } from './derived-seg.js';

function hydrateSegEntries(sourceSeries, entries) {
  if (state._localRegionLabelSlicesBySlug[sourceSeries.slug]) return;
  const segEntries = entries.filter((entry) => entry?.binding?.derivedKind === 'seg');
  for (const entry of segEntries) {
    const overlay = deserializeSegPayload(entry.payload, sourceSeries.width, sourceSeries.height, sourceSeries.slices);
    if (!overlay) continue;
    attachRegionOverlay(sourceSeries, {
      kind: 'seg',
      overlayKind: 'labels',
      name: entry.name,
      labelSlices: overlay.labelSlices,
      regionMeta: overlay.regionMeta,
    });
  }
}

function hydrateRtDoseEntries(sourceSeries, entries) {
  const doseEntries = entries.filter((entry) => entry?.binding?.derivedKind === 'rtdose' && entry?.payload?.format === 'rtdose-summary-v1');
  if (!doseEntries.length) return;
  setLocalRuntimeMapEntry('_localRtDoseBySlug', sourceSeries.slug, doseEntries.map((entry) => ({
    objectUID: entry.objectUID,
    name: entry.name,
    summary: entry.payload,
  })));
}

export function hydrateDerivedStateForSeries(sourceSeries) {
  const { entries, skipped } = listDerivedRegistryEntriesForSeriesWithSkipped(sourceSeries);
  const next = {};
  for (const entry of entries) {
    next[entry.objectUID] = {
      kind: entry.binding.derivedKind,
      name: entry.name,
    };
  }
  replaceLocalDerivedBucket(sourceSeries.slug, next);
  hydrateSegEntries(sourceSeries, entries);
  hydrateRtDoseEntries(sourceSeries, entries);
  entries.skipped = skipped;
  return entries;
}
