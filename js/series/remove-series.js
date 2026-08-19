import { stopCine } from '../cine.js';
import { deletePassthroughRootEntry, state } from '../core/state.js';
import { $ } from '../dom.js';
import { clearLocalRawVolume } from '../local-raw-volume-cache.js';
import { removeSeriesSlugsFromProjects } from '../projects/projects-store.js';
import {
  clearFusionRuntime,
  clearRuntimeImageStacks,
  clearRuntimeSelectionCaches,
  dropRuntimeVolumeCachesForSlugs,
  forgetLocalSeriesRuntime,
} from '../runtime/viewer-runtime.js';
import { seriesIdentityKey } from '../core/series-identity.js';
import {
  bumpSelectRequest,
  emptyViewer,
  forgetSeriesViewMemory,
  setComparePeers,
  setFusionSelection,
  setManifestCollections,
  setSeriesIndex,
} from '../core/state/viewer-commands.js';

function clearSeriesRuntime(series, manifest) {
  forgetLocalSeriesRuntime(series, manifest);
  deletePassthroughRootEntry('cmpStacks', series.slug);
  clearLocalRawVolume(series.slug);
  forgetSeriesViewMemory(seriesIdentityKey(series, manifest));
}

function showEmptyViewer() {
  stopCine();
  state.threeRuntime?.stopLoop?.();
  emptyViewer();
  clearRuntimeImageStacks();
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

  bumpSelectRequest();
  for (const series of removed) clearSeriesRuntime(series, manifest);
  dropRuntimeVolumeCachesForSlugs(requested);
  if (Array.isArray(state.cmpManualSlugs)) {
    const next = state.cmpManualSlugs.filter(slug => !requested.has(slug));
    setComparePeers(next);
  }
  if (requested.has(state.overlays.fusionSlug)) {
    setFusionSelection(null);
    clearFusionRuntime();
  }

  const referencedProjectionSets = new Set(remaining.map(series => series?.sourceProjectionSetId).filter(Boolean));
  const removedProjectionSets = new Set(removed.map(series => series?.sourceProjectionSetId).filter(Boolean));
  setManifestCollections({
    series: remaining,
    projectionSets: Array.isArray(manifest.projectionSets) && removedProjectionSets.size
      ? manifest.projectionSets.filter(record => (
        !removedProjectionSets.has(record?.id) || referencedProjectionSets.has(record?.id)
      ))
      : undefined,
  });

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
    setSeriesIndex(retainedActiveIndex);
    await refreshActiveView?.(retainedActiveIndex);
    await onUpdate?.(retainedActiveIndex);
  } else {
    const nextIndex = Math.min(Math.max(0, state.seriesIdx), remaining.length - 1);
    setSeriesIndex(-1);
    await selectSeries?.(nextIndex);
  }
  const result = {
    removed: removed.length,
    remaining: remaining.length,
  };
  if (organizationCleanupFailed) result.organizationCleanupFailed = true;
  return result;
}
