import { stopCine } from '../cine.js';
import { state } from '../core/state.js';
import { $ } from '../dom.js';
import { clearLocalRawVolume } from '../local-raw-volume-cache.js';
import { removeSeriesSlugsFromProjects } from '../projects/projects-store.js';
import { clearFusionRuntime, clearRuntimeSelectionCaches } from '../runtime/viewer-runtime.js';
import { seriesIdentityKey, seriesPersistenceKey } from './series-identity.js';

const LOCAL_SERIES_MAPS = [
  '_localStacks',
  '_localMicroscopyStacks',
  '_localMicroscopyPlanes',
  '_localRegionMetaBySlug',
  '_localRegionLabelSlicesBySlug',
  '_localDerivedObjects',
  '_localRtDoseBySlug',
  'cmpStacks',
];

function clearSeriesRuntime(series, manifest) {
  const slug = series.slug;
  for (const key of LOCAL_SERIES_MAPS) {
    if (state[key]) delete state[key][slug];
  }
  clearLocalRawVolume(slug);
  const viewKey = seriesIdentityKey(series, manifest);
  if (viewKey && state.seriesViewMemory) delete state.seriesViewMemory[viewKey];
  const analysisKey = seriesPersistenceKey(series, manifest);
  if (analysisKey) {
    if (state._microscopyAnalysisLog) delete state._microscopyAnalysisLog[analysisKey];
    if (state._microscopyAnalysisResults) delete state._microscopyAnalysisResults[analysisKey];
  }
}

function showEmptyViewer() {
  stopCine();
  state.threeRuntime?.stopLoop?.();
  state.seriesIdx = -1;
  state.sliceIdx = 0;
  state.mode = '2d';
  state.loaded = false;
  state.imgs = [];
  clearRuntimeSelectionCaches();
  $('canvas-wrap')?.classList.add('no-series');
  const seriesName = $('series-name');
  if (seriesName) seriesName.textContent = '—';
  const current = $('slice-cur');
  const total = $('slice-tot');
  if (current) current.textContent = '';
  if (total) total.textContent = '';
}

export async function removeSeriesFromViewer(slugOrSlugs, {
  selectSeries,
  onUpdate,
  refreshActiveView,
  removeFromProjects = removeSeriesSlugsFromProjects,
} = {}) {
  const requested = new Set((Array.isArray(slugOrSlugs) ? slugOrSlugs : [slugOrSlugs]).map(String).filter(Boolean));
  const manifest = state.manifest;
  const seriesList = Array.isArray(manifest?.series) ? manifest.series : [];
  const removed = seriesList.filter(series => requested.has(series?.slug));
  if (!removed.length) return { removed: 0, remaining: seriesList.length };

  const activeSlug = seriesList[state.seriesIdx]?.slug || '';
  const remaining = seriesList.filter(series => !requested.has(series?.slug));
  const remainingImportIds = new Set(remaining.map(series => series?._desktopImportId).filter(Boolean));
  const forgetIds = new Set(
    removed.map(series => series?._desktopImportId).filter(id => id && !remainingImportIds.has(id)),
  );
  const desktop = globalThis.voxellabDesktop;
  if (forgetIds.size) await desktop?.removeImportedSeries?.([...forgetIds]);
  let organizationCleanupFailed = false;
  try {
    await removeFromProjects([...requested]);
  } catch (error) {
    organizationCleanupFailed = true;
    console.warn('[projects] Series removal cleanup failed:', error);
  }

  state.selectRequestId += 1;
  for (const series of removed) clearSeriesRuntime(series, manifest);
  state._seriesVolumeCacheEntries = (state._seriesVolumeCacheEntries || [])
    .filter(entry => !requested.has(entry?.slug));
  if (Array.isArray(state.cmpManualSlugs)) {
    const next = state.cmpManualSlugs.filter(slug => !requested.has(slug));
    state.cmpManualSlugs = next.length ? next : null;
  }
  if (requested.has(state.fusionSlug)) {
    state.fusionSlug = null;
    clearFusionRuntime();
  }

  manifest.series = remaining;
  const referencedProjectionSets = new Set(remaining.map(series => series?.sourceProjectionSetId).filter(Boolean));
  const removedProjectionSets = new Set(removed.map(series => series?.sourceProjectionSetId).filter(Boolean));
  if (Array.isArray(manifest.projectionSets) && removedProjectionSets.size) {
    manifest.projectionSets = manifest.projectionSets.filter(record => (
      !removedProjectionSets.has(record?.id) || referencedProjectionSets.has(record?.id)
    ));
  }

  if (!remaining.length) {
    showEmptyViewer();
    await onUpdate?.(-1);
    const result = {
      removed: removed.length,
      remaining: 0,
    };
    if (organizationCleanupFailed) result.organizationCleanupFailed = true;
    return result;
  }

  const retainedActiveIndex = remaining.findIndex(series => series.slug === activeSlug);
  if (retainedActiveIndex >= 0) {
    state.seriesIdx = retainedActiveIndex;
    await refreshActiveView?.(retainedActiveIndex);
    await onUpdate?.(retainedActiveIndex);
  } else {
    const nextIndex = Math.min(Math.max(0, state.seriesIdx), remaining.length - 1);
    state.seriesIdx = -1;
    await selectSeries?.(nextIndex);
  }
  const result = {
    removed: removed.length,
    remaining: remaining.length,
  };
  if (organizationCleanupFailed) result.organizationCleanupFailed = true;
  return result;
}
