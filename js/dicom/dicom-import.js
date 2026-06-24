// Browser-side DICOM / NIfTI import: parsing lives in dicom-import-parse.js.
// This file wires parsed stacks into the manifest + sidebar.

import { state } from '../core/state.js';
import { notifyProjectsChanged } from '../projects/projects-sidebar.js';
import {
  localDisplayEntryForImport,
  mergeSeriesIntoManifest,
  registerProjectionSet,
} from '../series/series-contract.js';
import { cacheLocalRawVolume } from '../local-raw-volume-cache.js';

export { parseDICOMFiles, parseDICOMFileGroups, parseNIfTI } from './dicom-import-parse.js';
export { buildDICOMSeriesResult } from './dicom-import-parse.js';

export function injectManifestSeries(manifest, entry) {
  const idx = mergeSeriesIntoManifest(manifest, entry);
  notifyProjectsChanged(idx);
  return idx;
}

function canvasesToImages(sliceCanvases = []) {
  return sliceCanvases.map(c => {
    const img = new Image();
    img.src = c.toDataURL('image/png');
    if (Array.isArray(c._microscopyDisplayByteRange)) {
      img._microscopyDisplayByteRange = c._microscopyDisplayByteRange.slice();
    }
    if (Array.isArray(c._microscopyRawRange)) {
      img._microscopyRawRange = c._microscopyRawRange.slice();
    }
    if (c._microscopyInvertDisplayRange) {
      img._microscopyInvertDisplayRange = true;
    }
    return img;
  });
}

export function injectLocalSeries(manifest, entry, sliceCanvases, rawVolume, localStacks = null, rawPlanes = null) {
  const projectionSetRecord = registerProjectionSet(manifest, entry);
  const displayEntry = localDisplayEntryForImport(entry, projectionSetRecord);
  const imgs = canvasesToImages(sliceCanvases);

  state._localStacks[displayEntry.slug] = imgs;
  if (localStacks && displayEntry.microscopy) {
    const stacks = {};
    for (const [key, canvases] of Object.entries(localStacks)) {
      stacks[key] = canvasesToImages(canvases);
    }
    state._localMicroscopyStacks[displayEntry.slug] = stacks;
    const activeKey = `${displayEntry.microscopy.channelIndex || 0}|${displayEntry.microscopy.timeIndex || 0}`;
    state._localStacks[displayEntry.slug] = stacks[activeKey] || imgs;
    // Retain raw single-channel planes (uint16-aware) for raw-domain analysis. Skipped when
    // retention exceeded the byte budget (rawPlanes === null) — analysis then fails closed.
    if (rawPlanes) state._localMicroscopyPlanes[displayEntry.slug] = rawPlanes;
  }
  if (rawVolume) {
    cacheLocalRawVolume(displayEntry.slug, rawVolume);
  }
  return injectManifestSeries(manifest, displayEntry);
}
