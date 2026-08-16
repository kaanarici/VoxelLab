// Browser-side DICOM / NIfTI import: parsing lives in dicom-import-parse.js.
// This file wires parsed stacks into the manifest + sidebar.

import { state } from '../core/state.js';
import { notify } from '../notify.js';
import { notifyProjectsChanged } from '../projects/projects-sidebar.js';
import {
  localDisplayEntryForImport,
  mergeSeriesIntoManifest,
  registerProjectionSet,
} from '../series/series-contract.js';
import { seriesPersistenceKey } from '../series/series-identity.js';
import { cacheLocalRawVolume, clearLocalRawVolume } from '../local-raw-volume-cache.js';
import { createLocalByteSlice } from '../series/local-byte-slice.js';
import { retryPendingDerivedObjects } from './dicom-derived-import.js';

export { iterateDICOMFileGroups, parseDICOMFiles, parseDICOMFileGroups, parseNIfTI, parseNIfTISeries } from './dicom-import-parse.js';
export { buildDICOMSeriesResult } from './dicom-import-parse.js';

export function injectManifestSeries(manifest, entry) {
  const idx = mergeSeriesIntoManifest(manifest, entry);
  const retried = retryPendingDerivedObjects(manifest);
  const attached = retried.filter(result => !result.skipped);
  const rejected = retried.filter(result => result.skipped);
  if (attached.length && globalThis.document?.body) {
    notify(`Attached ${attached.length} waiting derived object${attached.length === 1 ? '' : 's'} to the newly loaded source series.`);
  }
  if (rejected.length && globalThis.document?.body) {
    const firstReason = String(rejected[0].reason || 'source compatibility validation failed');
    notify(
      `Could not attach ${rejected.length} waiting derived object${rejected.length === 1 ? '' : 's'}: ${firstReason}`,
      { kind: 'error' },
    );
  }
  notifyProjectsChanged(idx);
  return idx;
}

function localSliceSourcesToImages(sliceSources = [], width = 0, height = 0) {
  return sliceSources.map(source => {
    if (source instanceof Uint8Array) return createLocalByteSlice(source, width, height);
    const img = new Image();
    img.alt = '';
    img.src = source.toDataURL('image/png');
    if (Array.isArray(source._microscopyDisplayByteRange)) {
      img._microscopyDisplayByteRange = source._microscopyDisplayByteRange.slice();
    }
    if (Array.isArray(source._microscopyRawRange)) {
      img._microscopyRawRange = source._microscopyRawRange.slice();
    }
    if (source._microscopyInvertDisplayRange) {
      img._microscopyInvertDisplayRange = true;
    }
    return img;
  });
}

export function injectLocalSeries(manifest, entry, sliceSources, rawVolume, localStacks = null, rawPlanes = null) {
  const projectionSetRecord = registerProjectionSet(manifest, entry);
  const displayEntry = localDisplayEntryForImport(entry, projectionSetRecord);
  const imgs = localSliceSourcesToImages(sliceSources, displayEntry.width, displayEntry.height);
  const slug = displayEntry.slug;
  const previousEntry = (manifest?.series || []).find(series => series?.slug === slug);
  const analysisKeys = new Set([
    seriesPersistenceKey(previousEntry, manifest),
    seriesPersistenceKey(displayEntry, manifest),
  ].filter(Boolean));
  for (const key of analysisKeys) {
    if (state._microscopyAnalysisLog) delete state._microscopyAnalysisLog[key];
    if (state._microscopyAnalysisResults) delete state._microscopyAnalysisResults[key];
  }

  state._localStacks[slug] = imgs;
  if (state._localMicroscopyStacks) delete state._localMicroscopyStacks[slug];
  if (state._localMicroscopyPlanes) delete state._localMicroscopyPlanes[slug];
  clearLocalRawVolume(slug);
  if (localStacks && displayEntry.microscopy) {
    const stacks = {};
    for (const [key, canvases] of Object.entries(localStacks)) {
      stacks[key] = localSliceSourcesToImages(canvases, displayEntry.width, displayEntry.height);
    }
    state._localMicroscopyStacks[slug] = stacks;
    const activeKey = `${displayEntry.microscopy.channelIndex || 0}|${displayEntry.microscopy.timeIndex || 0}`;
    state._localStacks[slug] = stacks[activeKey] || imgs;
    // Retain raw single-channel planes (uint16-aware) for raw-domain analysis. Skipped when
    // retention exceeded the byte budget (rawPlanes === null) — analysis then fails closed.
    if (rawPlanes) state._localMicroscopyPlanes[slug] = rawPlanes;
  }
  if (rawVolume) {
    cacheLocalRawVolume(slug, rawVolume);
  }
  return injectManifestSeries(manifest, displayEntry);
}
