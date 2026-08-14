import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { stopCine } from '../cine.js';
import { cachedFetchJson } from '../core/cached-fetch.js';
import { tryFlattenVoxelsInWorker } from '../volume/volume-voxels-ensure.js';
import { ensureHRVoxels } from '../volume/volume-hr-voxels.js';
import { getPreferredOverlays } from '../overlay/overlay-preferences.js';
import { beginPerfTrace } from '../core/perf-trace.js';
import { applyCrossOriginPreloads } from '../preload-cross-origin.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { beginViewerRuntimeSession, syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { drawSparkline } from '../sparkline.js';
import { renderAnnotationList } from '../overlay/annotation.js';
import { renderCloudResultsPanel } from '../cloud-results.js';
import { updateOrientationMarkers } from '../shell/viewport.js';
import { markViewAwaitingSliceFade } from '../slice-view.js';
import { renderQuantificationPanel, renderVolumeTable } from '../metadata.js';
import { renderStructuresPanel } from '../atlas/structures-panel.js';
import { updateInfoTips } from '../info-tips.js';
import { listDerivedRegistryEntriesForSeries } from '../derived-objects.js';
import { notifyProjectsChanged } from '../projects/projects-sidebar.js';
import { hardFail, softFail } from '../core/error.js';
import { syncZScrubberSlider } from '../sync.js';
import { ensureOverlayStack } from '../overlay/overlay-stack.js';
import {
  beginSeriesSelection,
  finishSeriesSelection,
  hydrateSeriesSidecars,
  hydrateSeriesStacks,
  initializeSeriesViewState,
  isSeriesSelectionCurrent,
} from '../core/state/viewer-commands.js';
import { syncAskModeAfterViewChange } from '../ask-mode.js';
import { cancelActiveAnalysis, loadPersistedSeriesAnalysis } from '../analysis-findings.js';
import { clearSpinnerPendingPrefix, setSpinnerPending } from '../spinner.js';
import {
  BASE_PREFETCH_CONCURRENCY,
  DEFAULT_PREFETCH_LIMIT,
  OVERLAY_PREFETCH_CONCURRENCY,
} from '../core/constants.js';
import {
  buildCompareGrid,
  loadComparePeers,
  drawCompare,
} from './compare.js';
import { activateSeriesViewMode } from './series-view-activation.js';
import { loadImageStack, regionMetaUrlForSeries, statsUrlForSeries } from './series-image-stack.js';
import { applySelectSeriesDom } from './select-series-dom.js';

export async function selectSeries(i, v, { preserveSlice = false } = {}) {
  cancelActiveAnalysis();
  const manifest = state.manifest;
  const series = manifest.series[i];
  $('canvas-wrap')?.classList.remove('no-series');
  beginPerfTrace('select-series-2d', { slug: series?.slug || '', seriesIdx: i });
  const isRemote = !!series?.sliceUrlBase;
  const selection = beginSeriesSelection(i, { preserveSlice });
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
    && state.manifest === manifest
    && state.manifest?.series?.[i] === series;
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
    renderCloudResultsPanel();
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
  const overlays = activeOverlayStateForSeries(series);
  applyCrossOriginPreloads(state.manifest, { activeSeriesIdx: i });
  applySelectSeriesDom(i, series, v);
  updateOrientationMarkers(series);

  const variant = state.useBrain && series.hasBrain ? `${series.slug}_brain` : series.slug;
  const windowRadius = isRemote ? 0 : 5;
  const currentIndex = state.sliceIdx;

  const base = loadImageStack(variant, series.slices, state.imgs, series, {
    label: `${series.slug} base stack`,
    errorMode: 'hard',
    windowRadius,
    initialIndex: currentIndex,
  });
  hydrateSeriesStacks({ imgs: base.imgs });
  syncViewerRuntimeSession(series);
  const baseLoaders = base.loaders;

  const overlayLoaders = [];
  if (overlays.tissue.enabled) {
    const seg = loadImageStack(`${series.slug}_seg`, series.slices, state.segImgs, series, {
      label: `${series.slug} tissue overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ segImgs: seg.imgs });
    overlayLoaders.push(...seg.loaders);
  }
  if (overlays.heatmap.enabled) {
    const sym = loadImageStack(`${series.slug}_sym`, series.slices, state.symImgs, series, {
      label: `${series.slug} symmetry overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ symImgs: sym.imgs });
    overlayLoaders.push(...sym.loaders);
  }
  if (overlays.labels.enabled) {
    const reg = loadImageStack(`${series.slug}_regions`, series.slices, state.regionImgs, series, {
      label: `${series.slug} anatomy overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ regionImgs: reg.imgs });
    overlayLoaders.push(...reg.loaders);
  }

  // Prefetch preferred overlays for this modality when toggles are off so the
  // first enable renders immediately.
  const preferredOverlays = new Set(getPreferredOverlays(series.modality));
  if (preferredOverlays.has('seg') && overlays.tissue.available && !overlays.tissue.enabled) {
    const seg = loadImageStack(`${series.slug}_seg`, series.slices, state.segImgs, series, {
      label: `${series.slug} tissue overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ segImgs: seg.imgs });
    overlayLoaders.push(...seg.loaders);
  }
  if (preferredOverlays.has('sym') && overlays.heatmap.available && !overlays.heatmap.enabled) {
    const sym = loadImageStack(`${series.slug}_sym`, series.slices, state.symImgs, series, {
      label: `${series.slug} symmetry overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ symImgs: sym.imgs });
    overlayLoaders.push(...sym.loaders);
  }
  if (preferredOverlays.has('regions') && overlays.labels.available && !overlays.labels.enabled) {
    const reg = loadImageStack(`${series.slug}_regions`, series.slices, state.regionImgs, series, {
      label: `${series.slug} anatomy overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ regionImgs: reg.imgs });
    overlayLoaders.push(...reg.loaders);
  }

  const regionMetaPromise = overlays.labels.available
    ? Promise.resolve(state._localRegionMetaBySlug[series.slug] || null)
      .then((localMeta) => localMeta || hardFail(
        cachedFetchJson(regionMetaUrlForSeries(series)),
        `${series.slug} anatomy metadata`,
      ))
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
  hydrateSeriesSidecars({ regionMeta, askHistory, stats, analysis });
  applySelectSeriesDom(i, series, v);
  syncViewerRuntimeSession(series);
  refreshSidebarData();
  syncViewerRuntimeSession(series);
  syncAskModeAfterViewChange();
  // Restore-on overlays (e.g. Anatomy carried over from a previous session) must
  // render their colour on load, not only after the user toggles off/on. Drive
  // them through the same ensureOverlayStack path the toggle uses — it repaints on
  // the current slice AND again once the stack finishes, and ensures region meta —
  // so the colour overlay can't silently miss a one-shot paint race.
  if (overlays.tissue.enabled) ensureOverlayStack('seg');
  if (overlays.heatmap.enabled) ensureOverlayStack('sym');
  if (overlays.labels.enabled) ensureOverlayStack('regions');

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
    const fullOverlayLoad = Promise.all([
      state.segImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: OVERLAY_PREFETCH_CONCURRENCY,
        limit: DEFAULT_PREFETCH_LIMIT,
      }) || Promise.resolve([]),
      state.symImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: OVERLAY_PREFETCH_CONCURRENCY,
        limit: DEFAULT_PREFETCH_LIMIT,
      }) || Promise.resolve([]),
      state.regionImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: OVERLAY_PREFETCH_CONCURRENCY,
        limit: DEFAULT_PREFETCH_LIMIT,
      }) || Promise.resolve([]),
    ]);
    Promise.resolve(fullBaseLoad).then(() => triggerRebuildAfterBaseReady('full'));
    void fullOverlayLoad;
  }
}
