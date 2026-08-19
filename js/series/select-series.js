import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { stopCine } from '../cine.js';
import { cachedFetchJson } from '../cached-fetch.js';
import { tryFlattenVoxelsInWorker } from '../volume/volume-voxels-ensure.js';
import { ensureHRVoxels } from '../volume/volume-hr-voxels.js';
import { getPreferredOverlays } from '../overlay/overlay-preferences.js';
import { beginPerfTrace } from '../core/perf-trace.js';
import { applyCrossOriginPreloads } from '../preload-cross-origin.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_KIND } from '../runtime/overlay-cache-keys.js';
import { canUseMpr3D } from '../core/series-capabilities.js';
import { transitionVolumeCaches, setSeriesImageStacks } from '../runtime/viewer-runtime.js';
import { beginViewerRuntimeSession, syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { drawSparkline } from '../sparkline.js';
import { renderAnnotationList } from '../overlay/annotation.js';
import { updateOrientationMarkers } from '../shell/viewport.js';
import { markViewAwaitingSliceFade } from '../slice-view.js';
import { renderQuantificationPanel, renderVolumeTable } from '../metadata.js';
import { renderStructuresPanel } from '../atlas/structures-panel.js';
import { updateInfoTips } from '../info-tips.js';
import { listDerivedRegistryEntriesForSeries } from '../derived-objects.js';
import { notifyProjectsChanged } from '../projects/projects-sidebar.js';
import { notify } from '../notify.js';
import { softFail } from '../core/error.js';
import { syncZScrubberSlider } from '../sync.js';
import { ensureOverlayStack } from '../overlay/overlay-stack.js';
import {
  beginSeriesSelection,
  finishSeriesSelection,
  hydrateSeriesSidecars,
  initializeSeriesViewState,
  isSeriesSelectionCurrent,
} from '../core/state/viewer-commands.js';
import { syncAskModeAfterViewChange } from '../ask-mode.js';
import { setAskHistory } from '../ask-session.js';
import { cancelActiveAnalysis, loadPersistedSeriesAnalysis } from '../analysis-findings.js';
import { clearSpinnerPendingPrefix, setSpinnerPending } from '../spinner.js';
import {
  BASE_PREFETCH_CONCURRENCY,
  DEFAULT_PREFETCH_LIMIT,
  OVERLAY_PREFETCH_CONCURRENCY,
} from '../core/constants.js';
import {
  buildCompareGrid,
  drawCompare,
  getGroupPeers,
  loadComparePeers,
} from './compare.js';
import { activateSeriesViewMode } from './series-view-activation.js';
import { loadImageStack, regionMetaUrlForSeries, statsUrlForSeries } from './series-image-stack.js';
import { applySelectSeriesDom } from './select-series-dom.js';

function constrainSeriesViewMode(series, v) {
  if (!canUseMpr3D(series) && (v.is3dActive() || v.isMprActive())) v.setMode('2d');
  if (state.mode === 'cmp' && getGroupPeers().length < 2) v.setMode('2d');
}

function enableOverlayCaches() {
  return Object.values(OVERLAY_CACHE_BY_KIND).filter((cache) => cache.availableFlag);
}

function loadSeriesOverlayStack(series, cache, {
  preferred = false,
  hardErrors = false,
  windowRadius,
  currentIndex,
} = {}) {
  const options = {
    label: `${series.slug} ${cache.kind} overlay${preferred ? ' (preferred)' : ''}`,
    windowRadius,
    initialIndex: currentIndex,
  };
  if (hardErrors) options.errorMode = 'hard';
  const loaded = loadImageStack(
    `${series.slug}_${cache.type}`,
    series.slices,
    state[cache.imgs],
    series,
    options,
  );
  setSeriesImageStacks({ [cache.imgs]: loaded.imgs });
}

export async function selectSeries(i, v, { preserveSlice = false } = {}) {
  cancelActiveAnalysis();
  const manifest = state.manifest;
  let series = manifest.series[i];
  $('canvas-wrap')?.classList.remove('no-series');
  beginPerfTrace('select-series-2d', { slug: series?.slug || '', seriesIdx: i });
  const isRemote = !!series?.sliceUrlBase;
  const previous = state.manifest.series[state.seriesIdx] || null;
  const selection = transitionVolumeCaches(previous, () => beginSeriesSelection(i, { preserveSlice }));
  setAskHistory([]);
  markViewAwaitingSliceFade();
  const requestId = selection.requestId;
  const seriesLoadSpinnerKey = `series-load:${requestId}`;
  let seriesLoadSpinnerCleared = false;
  const clearSeriesLoadSpinner = () => {
    if (!isRemote || seriesLoadSpinnerCleared) return;
    seriesLoadSpinnerCleared = true;
    setSpinnerPending(seriesLoadSpinnerKey, false);
  };
  v.resetTransform();
  stopCine();

  const scrubEl = $('scrub');
  const zScrubEl = $('s-zscrub');
  clearSpinnerPendingPrefix('series-load');
  if (scrubEl) scrubEl.disabled = false;
  if (zScrubEl) zScrubEl.disabled = false;
  if (isRemote) setSpinnerPending(seriesLoadSpinnerKey, true);
  if (scrubEl && isRemote) scrubEl.disabled = true;
  if (zScrubEl && isRemote) zScrubEl.disabled = true;

  const isCurrent = () => isSeriesSelectionCurrent(requestId, series.slug)
    && state.manifest === manifest;
  const refreshSidebarData = () => {
    v.renderFindings();
    v.renderScrubTicks();
    v.renderRegionLegend();
    v.renderFusionPicker();
    v.renderRoiResults();
    renderQuantificationPanel();
    renderAnnotationList();
    renderVolumeTable();
    renderStructuresPanel();
    v.syncModalityPresets();
    v.syncOverlayOpacityUI();
    v.syncToolbarReadyState();
    updateInfoTips(series);
  };
  try {
    await notifyProjectsChanged(i);
  } catch {
    // Folder organization is best-effort; the canonical series load still wins.
  }
  if (!isCurrent()) {
    clearSeriesLoadSpinner();
    return;
  }
  beginViewerRuntimeSession(series, { seriesIdx: i, requestId });
  initializeSeriesViewState(series);
  activateSeriesViewMode(selection, series, v);
  const derivedEntries = listDerivedRegistryEntriesForSeries(series);
  if (derivedEntries.length) {
    const { hydrateDerivedStateForSeries } = await import('../dicom/dicom-derived-import.js');
    if (!isCurrent()) {
      clearSeriesLoadSpinner();
      return;
    }
    hydrateDerivedStateForSeries(series);
  }
  series = state.manifest?.series?.[i] || series;
  const overlays = activeOverlayStateForSeries(series);
  applyCrossOriginPreloads(state.manifest, { activeSeriesIdx: i });
  applySelectSeriesDom(i, series, v);
  constrainSeriesViewMode(series, v);
  updateOrientationMarkers(series);

  const variant = state.overlays.useBrain && series.hasBrain ? `${series.slug}_brain` : series.slug;
  const windowRadius = isRemote ? 0 : 5;
  const currentIndex = state.sliceIdx;

  const base = loadImageStack(variant, series.slices, state.imgs, series, {
    label: `${series.slug} base stack`,
    errorMode: 'hard',
    windowRadius,
    initialIndex: currentIndex,
  });
  setSeriesImageStacks({ imgs: base.imgs });
  syncViewerRuntimeSession(series);
  const baseLoaders = base.loaders;

  // Prefetch preferred overlays for this modality when toggles are off so the
  // first enable renders immediately.
  const preferredOverlays = new Set(getPreferredOverlays(series.modality));
  for (const cache of enableOverlayCaches()) {
    const overlay = overlays[cache.kind];
    const enabled = !!overlay?.enabled;
    const preferred = preferredOverlays.has(cache.kind) && overlay?.available && !enabled;
    if (!enabled && !preferred) continue;
    loadSeriesOverlayStack(series, cache, {
      preferred,
      hardErrors: enabled,
      windowRadius,
      currentIndex,
    });
  }

  const regionMetaPromise = overlays.labels.available
    ? Promise.resolve(state._localRegionMetaBySlug[series.slug] || null)
      .then((localMeta) => localMeta || softFail(
        cachedFetchJson(regionMetaUrlForSeries(series)),
        `${series.slug} anatomy metadata`,
      ).then((value) => {
        if (value == null) notify(`${series.slug} anatomy metadata failed`, { kind: 'error' });
        return value;
      }))
    : Promise.resolve(null);
  const askHistoryPromise = series.hasAskHistory
    ? softFail(
      cachedFetchJson(`./data/${series.slug}_asks.json`).then((d) => d?.entries || null),
      `${series.slug} ask history`,
    )
    : Promise.resolve(null);
  const statsPromise = series.hasStats
    ? softFail(cachedFetchJson(statsUrlForSeries(series)), `${series.slug} stats`)
    : Promise.resolve(null);

  // Source-keyed local results take precedence across selection and reload.
  // Declared legacy slug sidecars remain a static demo compatibility fallback.
  const analysisPromise = loadPersistedSeriesAnalysis(series, manifest);
  if (!isCurrent()) {
    clearSeriesLoadSpinner();
    return;
  }
  refreshSidebarData();
  drawSparkline();

  $('volumes-panel').hidden = true;

  if (series.hasRaw || series.rawUrl) {
    ensureHRVoxels().then(() => {
      if (!isCurrent()) return;
      syncViewerRuntimeSession(series);
    });
  }

  try {
    if (baseLoaders.length > 0) await baseLoaders[0];
  } finally {
    clearSeriesLoadSpinner();
    if (isCurrent()) {
      if (scrubEl) scrubEl.disabled = false;
      if (zScrubEl) zScrubEl.disabled = false;
    }
  }
  if (!isCurrent()) return;
  syncViewerRuntimeSession(series);
  syncZScrubberSlider(series);
  finishSeriesSelection();
  if (isCurrent() && state.mode === '2d') {
    requestAnimationFrame(() => v.zoomToFit());
  }
  // Analysis applies via hydrateSeriesSidecars with the other sidecars.
  const [regionMeta, askHistory, stats, analysis] = await Promise.all([
    regionMetaPromise,
    askHistoryPromise,
    statsPromise,
    analysisPromise,
  ]);
  if (!isCurrent()) return;
  hydrateSeriesSidecars({ regionMeta, stats, analysis });
  if (Array.isArray(askHistory)) setAskHistory(askHistory);
  applySelectSeriesDom(i, series, v);
  constrainSeriesViewMode(series, v);
  syncViewerRuntimeSession(series);
  refreshSidebarData();
  syncViewerRuntimeSession(series);
  syncAskModeAfterViewChange();
  // Restore-on overlays (e.g. Anatomy carried over from a previous session) must
  // render their colour on load, not only after the user toggles off/on. Drive
  // them through the same ensureOverlayStack path the toggle uses — it repaints on
  // the current slice AND again once the stack finishes, and ensures region meta —
  // so the colour overlay can't silently miss a one-shot paint race.
  for (const cache of enableOverlayCaches()) {
    if (overlays[cache.kind]?.enabled) ensureOverlayStack(cache.type);
  }

  if (state.mode === 'cmp') {
    buildCompareGrid();
    await loadComparePeers();
    if (!isCurrent()) return;
    drawCompare();
  }

  // Shape: { variant: "full" } when the whole base stack is warm enough for MPR/3D reuse.
  const triggerRebuildAfterBaseReady = async (variant) => {
    if (!isCurrent()) return;
    const voxelsKeyBefore = state.voxelsKey;
    await tryFlattenVoxelsInWorker();
    if (!isCurrent()) return;
    syncViewerRuntimeSession(series);
    if (variant === 'full' && state.voxelsKey === voxelsKeyBefore && voxelsKeyBefore) return;
    if (v.is3dActive()) {
      v.applyThreeDPresetForSeries(series);
      v.buildVolume();
      v.updateUniforms();
      v.updateClipReadouts();
    }
    if (v.isMprActive()) { v.ensureVoxels(); v.drawMPR(); }
    if (overlays.tissue.available && state.mode !== '3d' && state.mode !== 'mpr') v.ensureVoxels();
  };

  Promise.all(baseLoaders).then(() => triggerRebuildAfterBaseReady('window'));

  if (!isRemote) {
    const fullBaseLoad = base.imgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
      concurrency: BASE_PREFETCH_CONCURRENCY,
      limit: Infinity,
    }) || Promise.resolve([]);
    const liveOverlays = activeOverlayStateForSeries(series);
    const prefetchInactiveOverlay = (imgs, enabled) => enabled
      ? Promise.resolve([])
      : imgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: OVERLAY_PREFETCH_CONCURRENCY,
        limit: DEFAULT_PREFETCH_LIMIT,
      }) || Promise.resolve([]);
    const fullOverlayLoad = Promise.all(
      enableOverlayCaches().map((cache) => (
        prefetchInactiveOverlay(state[cache.imgs], liveOverlays[cache.kind].enabled)
      )),
    );
    Promise.resolve(fullBaseLoad).then(() => triggerRebuildAfterBaseReady('full'));
    void fullOverlayLoad;
  }
}
