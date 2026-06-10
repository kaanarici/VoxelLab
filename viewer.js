// Medical imaging viewer — composition root: init(), module inits, viewerBridge.
// DOM/canvas wiring: js/wire-controls.js; series load: js/select-series.js;
// local-backend UI gating: js/local-backend-mode.js; auto W/L: js/auto-window-level.js.

import { state } from './js/core/state.js';
import { $, clientToCanvasPx as _clientToCanvasPx } from './js/dom.js';
import { updateClipReadouts } from './js/clip-readouts.js';
import { renderVolumes } from './js/volume/volumes-panel.js';
import {
  renderFusionPicker,
  renderRegionLegend,
} from './js/fusion-regions.js';
import {
  setMode,
  applyThreeDPresetForSeries,
} from './js/view-modes.js';
import { initROI } from './js/roi.js';
import { initRoiResultsPanel, renderRoiResults } from './js/roi/roi-results.js';
import { drawHistogram, drawSparkline, initSparkline } from './js/sparkline.js';
import { updateScrubFill as _updateScrubFill } from './js/cine.js';
import { drawMeasurements } from './js/roi/measure.js';
import { initCompare, drawCompare as _drawCompare } from './js/series/compare.js';
import {
  initAnnotations,
  getAnnotatedSlices,
} from './js/overlay/annotation.js';
import { initTouch } from './js/touch.js';
import { loadRegistrationData, renderVolumeTable } from './js/metadata.js';
import { initCloud } from './js/cloud.js';
import { loadConfig, viewerAiFlags } from './js/config.js';
import { initProjects, renderProjectsSidebar, expandFolderForSeries } from './js/projects/projects-sidebar.js';
import { isMprActive, is3dActive } from './js/core/mode-flags.js';
import { initReactiveSync } from './js/sync.js';
import { initOverlayStack } from './js/overlay/overlay-stack.js';
import {
  initAnalysisFindings,
  renderFindings,
  renderScrubTicks,
} from './js/analysis-findings.js';
import { wireCollapsiblePanels } from './js/collapsible-sidebar.js';
import { initPanelRangeFills, syncPanelRangeFills } from './js/panel-range-fills.js';
import { resetTransform } from './js/view-transform.js';
import { zoomToFit, updateOrientationMarkers } from './js/shell/viewport.js';
import { selectSeries as runSelectSeries } from './js/series/select-series.js';
import {
  initVolume3D,
  sync3DScrubber,
  updateUniforms,
  ensureVoxels,
  ensureThree,
  buildVolume,
  syncThreeSurfaceState,
  updateLabelTexture,
} from './js/volume/volume-3d.js';
import {
  initSliceView,
  updateSliceDisplay,
  drawSlice,
  drawMPR,
} from './js/slice-view.js';
import { applyLocalBackendMode } from './js/local-backend-mode.js';
import { autoWindowLevel } from './js/auto-window-level.js';
import { wireControls } from './js/wire-controls.js';
import { registerCommands } from './js/command-palette.js';
import { ensureTemplate } from './js/template-loader.js';
import { getRawSliceData } from './js/raw-slice-data.js';
import { notify } from './js/notify.js';
import { syncToolbarReadyState, syncWlToolGroupVisibility } from './js/shell/toolbar-chrome.js';
import { cleanToolbarSeparators } from './js/series/select-series-dom.js';
import { applyCrossOriginPreloads } from './js/preload-cross-origin.js';
import { PERF_MODE } from './js/core/runtime-flags.js';
import { wirePanelInfoViewportTips } from './js/info-tips.js';
import { initTooltips } from './js/tooltips.js';
import { syncThemeIcons } from './js/theme-icons.js';
import {
  applyViewerPreset,
  setManifest,
  setWindowLevel,
  syncMprSliceIndex,
  stepSlice,
} from './js/core/state/viewer-commands.js';

const clientToCanvasPx = (cx, cy) => _clientToCanvasPx($('view'), cx, cy);
let microscopyControlsInitialized = false;

async function openShortcutsModal() {
  const shortcuts = await import('./js/shortcuts-modal.js');
  shortcuts.openShortcutsModal();
}

function hideMicroscopyPanels() {
  $('microscopy-stack-controls')?.replaceChildren();
  $('microscopy-stack-panel')?.classList.add('panel-init-hidden');
  $('microscopy-analysis-controls')?.replaceChildren();
  $('microscopy-analysis-panel')?.classList.add('panel-init-hidden');
}

async function renderMicroscopyHyperstackControls(host = state) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (series?.imageDomain !== 'microscopy') {
    hideMicroscopyPanels();
    return null;
  }
  const mod = await import('./js/microscopy/microscopy-hyperstack-controls.js');
  if (!microscopyControlsInitialized) {
    mod.initMicroscopyHyperstackControls({
      onStackChange: () => {
        drawMeasurements();
        renderRoiResults();
      },
    });
    microscopyControlsInitialized = true;
    return null;
  }
  return mod.renderMicroscopyHyperstackControls(host);
}

initOverlayStack({
  is3dActive,
  ensureVoxels,
  updateLabelTexture,
});
initAnalysisFindings({
  drawSlice,
  sync3DScrubber,
  renderScrubTicks,
});

function syncOverlayOpacityUI() {
  const visible = state.useSeg || state.useRegions || state.useSym;
  const wrap = $('overlay-opacity-wrap');
  if (wrap) wrap.hidden = !visible;
  syncWlToolGroupVisibility();
  cleanToolbarSeparators();
}

function syncModalityPresets() {
  const series = state.manifest?.series[state.seriesIdx];
  if (!series) return;
  const mrRow = $('mr-presets');
  if (mrRow) mrRow.hidden = series.modality !== 'MR';
}

initReactiveSync({
  syncOverlayOpacityUI,
  renderVolumes,
  renderFusionPicker,
  renderRegionLegend,
  renderVolumeTable,
  renderRoiResults,
  renderMicroscopyHyperstackControls,
});

init();

async function init() {
  initOfflineSupport();
  const res = await fetch('./data/manifest.json');
  setManifest(await res.json());
  const cfg = await loadConfig();

  if (state.manifest?.series?.length) {
    updateOrientationMarkers(state.manifest.series[state.seriesIdx]);
  }

  // Cross-origin preconnect + first-slice preload (no-op if everything is local).
  applyCrossOriginPreloads(state.manifest, { activeSeriesIdx: 0 });

  const sd = $('study-date');
  if (sd) sd.textContent = state.manifest.studyDate;

  // Empty state: only show when there's genuinely no data.
  // Default is hidden (no flash on load when data exists).
  const wrap = $('canvas-wrap');
  if (state.manifest.series.length === 0) {
    wrap.classList.add('no-series');
    const seriesName = $('series-name');
    if (seriesName) seriesName.textContent = '—';
  }

  // Projects: folder organization persisted in IndexedDB
  initProjects({
    onUpdate: (currentSeriesIdx = state.seriesIdx) => renderProjectsSidebar(state.manifest, currentSeriesIdx),
    selectSeries,
  });

  wireControls({
    selectSeries,
    autoWindowLevel,
    toggleHelp,
    hideHover,
    applyPreset,
    step,
    clientToCanvasPx,
    syncOverlayOpacityUI,
  });
  wireCollapsiblePanels();
  wirePanelInfoViewportTips();
  initTooltips();
  initPanelRangeFills();
  applyLocalBackendMode();

  initSparkline(getAnnotatedSlices);

  initCompare({
    selectSeries,
    step,
    hideHover,
  });

  initAnnotations({ drawSlice, drawSparkline, updateSliceDisplay });

  initTouch({
    onWindowLevel: (dw, dl) => {
      setWindowLevel(state.window + dw, state.level + dl);
    },
    onScrub: (delta) => step(delta),
  });

  initROI({
    state,
    getRawSliceData,
    onROIChange: () => {
      drawMeasurements();
      renderRoiResults();
    },
  });
  initRoiResultsPanel(state, {
    onImport: () => {
      drawMeasurements();
      renderRoiResults();
    },
    onChange: () => {
      drawMeasurements();
      renderRoiResults();
    },
  });
  if (state.manifest.series.length > 0) {
    loadRegistrationData();
  }

  // Shape: re-apply local-backend gating after config.json is loaded.
  applyLocalBackendMode();
  initCloud(cfg.modalWebhookBase, cfg.r2PublicUrl, {
    enabled: cfg.features?.cloudProcessing !== false,
    trustedUploadOrigins: cfg.trustedUploadOrigins,
  });
  document.title = cfg.siteName;
  const aiFlags = viewerAiFlags();

  registerCommands([
    // Tools
    { id: 'ruler',     label: 'Ruler',           icon: 'i-ruler',   section: 'Tools', shortcut: 'R',   keywords: 'measure distance', action: () => $('btn-measure').click() },
    { id: 'angle',     label: 'Angle',           icon: 'i-corner',  section: 'Tools', shortcut: 'G',   keywords: 'protractor',       action: () => $('btn-angle').click() },
    { id: 'roi-ell',   label: 'Ellipse ROI',     icon: 'i-circle',  section: 'Tools', shortcut: 'E',   keywords: 'region oval',      action: () => $('btn-roi-ell').click() },
    { id: 'roi-poly',  label: 'Polygon ROI',     icon: 'i-polygon', section: 'Tools', shortcut: 'P',   keywords: 'region freehand',  action: () => $('btn-roi-poly').click() },
    { id: 'roi-point', label: 'Point count ROI', icon: 'i-pin',     section: 'Tools', shortcut: 'O',   keywords: 'point count cell marker', action: () => $('btn-roi-point').click() },
    { id: 'annotate',  label: 'Annotate',        icon: 'i-pin',     section: 'Tools', shortcut: 'N',   keywords: 'pin note',         action: () => $('btn-annot').click() },
    { id: 'clear',     label: 'Clear slice drawings', icon: 'i-x',  section: 'Tools',                  keywords: 'delete remove',    action: () => $('btn-clear').click() },
    // Overlays
    { id: 'brain',     label: 'Brain (skull strip)', icon: 'i-brain',  section: 'Overlays', shortcut: 'B', keywords: 'skull strip',    action: () => $('btn-brain').click() },
    { id: 'seg',       label: 'Tissue segmentation', icon: 'i-layers', section: 'Overlays', shortcut: 'T', keywords: 'csf gm wm',     action: () => $('btn-seg').click() },
    { id: 'regions',   label: 'Anatomy overlay',  icon: 'i-map',     section: 'Overlays',                keywords: 'parcellation',    action: () => $('btn-regions').click() },
    { id: 'sym',       label: 'Symmetry heatmap', icon: 'i-flip',    section: 'Overlays', shortcut: 'Y', keywords: 'asymmetry',       action: () => $('btn-sym').click() },
    // View
    { id: 'compare',   label: 'Compare mode',     icon: 'i-columns', section: 'View', shortcut: 'C',   keywords: 'side by side',     action: () => $('btn-compare').click() },
    { id: 'mpr',       label: 'MPR mode',         icon: 'i-grid',    section: 'View', shortcut: 'M',   keywords: 'multiplanar',      action: () => $('btn-mpr').click() },
    { id: '3d',        label: '3D volume',         icon: 'i-cube',    section: 'View', shortcut: '3',   keywords: 'three render',     action: () => $('btn-3d').click() },
    // Display
    { id: 'auto-wl',   label: 'Auto contrast',    icon: 'i-sun',     section: 'Display', shortcut: 'A', keywords: 'window level',    action: () => $('btn-auto').click() },
    { id: 'invert',    label: 'Invert',           icon: 'i-flip',    section: 'Display', shortcut: 'I', keywords: 'negative',         action: () => $('btn-invert').click() },
    { id: 'zoomfit',   label: 'Zoom to fit',      icon: 'i-maximize',section: 'Display', shortcut: 'F', keywords: 'reset fit',        action: () => $('btn-zoomfit').click() },
    // Export
    { id: 'screenshot',label: 'Screenshot',       icon: 'i-camera',  section: 'Export', shortcut: 'S',  keywords: 'capture png',      action: () => $('btn-shot').click() },
    {
      id: 'screenshot-tiff',
      label: 'Rendered TIFF snapshot',
      icon: 'i-download',
      section: 'Export',
      keywords: 'capture tiff tif rendered snapshot microscopy',
      action: async () => {
        const { takeScreenshot } = await import('./js/screenshot.js');
        if (!await takeScreenshot('tiff')) notify('Rendered TIFF snapshots are available for 2D, MPR, and compare views.');
      },
    },
    { id: 'dicom-sr',  label: 'DICOM SR export',  icon: 'i-download',section: 'Export',                  keywords: 'structured',      action: () => $('btn-sr').click() },
    { id: 'roi-csv',   label: 'ROI results CSV',   icon: 'i-download',section: 'Export',                  keywords: 'roi results table csv imagej fiji', action: () => $('roi-results-export')?.click() },
    ...(aiFlags.localAiActionsEnabled ? [
      { id: 'ask',       label: 'Ask AI',           icon: 'i-sparkles',section: 'Export', shortcut: 'K',  keywords: 'ai question',      action: () => $('btn-ask').click() },
      { id: 'consult',   label: 'Consolidated read',icon: 'i-scroll',  section: 'Export',                  keywords: 'synthesize',      action: () => $('btn-consult').click() },
    ] : []),
    { id: 'help',      label: 'Help & shortcuts', icon: 'i-help',    section: 'Export', shortcut: '?',  keywords: 'keyboard reference',action: () => $('btn-help').click() },
    // General
    { id: 'shortcuts', label: 'Customize shortcuts', icon: 'i-help',  section: 'General',                keywords: 'keyboard keybindings hotkeys preferences', action: openShortcutsModal },
    { id: 'upload',    label: 'Upload study',     icon: 'i-upload',  section: 'General',                 keywords: 'open dicom nifti ome tiff microscopy', action: () => $('btn-upload').click() },
    { id: 'theme',     label: 'Toggle theme',     icon: 'i-sun',     section: 'General',                 keywords: 'dark light mode',  action: () => $('btn-theme').click() },
  ]);
  document.documentElement.dataset.voxellabControlsReady = 'true';
  window.dispatchEvent(new Event('voxellab:controls-ready'));
  await renderProjectsSidebar(state.manifest, state.seriesIdx);

  if (state.manifest.series.length > 0) {
    const initialSeriesIdx = PERF_MODE
      ? Math.max(
        0,
        state.manifest.series.findIndex((series) =>
          !series?.sliceUrlBase
          && (series?.reconstructionCapability === 'display-volume' || series?.geometryKind === 'volumeStack')
        ),
      )
      : 0;
    await selectSeries(initialSeriesIdx);
  }
  syncToolbarReadyState();
  syncThemeIcons();
}

function initOfflineSupport() {
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(globalThis.location?.hostname);
  if ('serviceWorker' in navigator) {
    if (isLocalhost) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => {});
      if ('caches' in globalThis) {
        caches.keys()
          .then((keys) => Promise.all(
            keys
              .filter((key) => (
                key.startsWith('voxellab-static-')
                || key.startsWith('voxellab-cdn-')
                || key.startsWith('voxellab-data-')
              ))
              .map((key) => caches.delete(key)),
          ))
          .catch(() => {});
      }
    } else {
    navigator.serviceWorker.register('./sw.js', {
      type: 'module',
      updateViaCache: 'none',
    }).catch((error) => {
      console.warn('service worker registration failed:', error);
    });
    }
  }
  window.addEventListener('offline', () => {
    notify('Offline — working from cache', { duration: 5000 });
  });
}

async function toggleHelp() {
  await ensureTemplate('./templates/help-modal.html', 'modal-root', 'help-modal');
  applyLocalBackendMode();
  $('help-shortcuts-open')?.addEventListener('click', async () => {
    // Preload the shortcuts module before touching the DOM so the two
    // identical overlays cross-fade in the same frame — no async gap that
    // would flash the backdrop while one dialog tears down before the next.
    const shortcuts = await import('./js/shortcuts-modal.js');
    shortcuts.openShortcutsModal();
    $('help-modal')?.classList.remove('visible');
  }, { once: true });
  const willShow = !$('help-modal').classList.contains('visible');
  // Warm the shortcuts chunk while help is open so the hand-off is instant.
  if (willShow) import('./js/shortcuts-modal.js').catch(() => {});
  $('help-modal').classList.toggle('visible');
}

// Theme toggle — instant, no transition (initial glyph sync: bootstrap.js + end of init())
syncThemeIcons();
const themeBtn = $('btn-theme');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    html.classList.add('light-switching');
    html.classList.toggle('light');
    const isLight = html.classList.contains('light');
    localStorage.setItem('mri-viewer-theme', isLight ? 'light' : 'dark');
    syncThemeIcons();
    drawSparkline();
    drawHistogram();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => html.classList.remove('light-switching'));
    });
  });
}

function hideHover() {
  $('hover-readout').classList.remove('visible');
}

function step(delta) {
  stepSlice(delta);
}

function applyPreset(p) {
  const next = applyViewerPreset(p);
  if (p.lowT !== undefined) $('s-low').value = next.lowT;
  if (p.highT !== undefined) $('s-high').value = next.highT;
  if (p.intensity !== undefined) $('s-gain').value = next.intensity;
  if (p.clipMin) { $('s-xmin').value = next.clipMin[0]; $('s-ymin').value = next.clipMin[1]; }
  if (p.clipMax) { $('s-xmax').value = next.clipMax[0]; $('s-ymax').value = next.clipMax[1]; }
  syncPanelRangeFills();
}

initVolume3D({
  renderVolumes,
  hideHover,
  is3dActive,
  isMprActive,
  drawMPR,
  updateClipReadouts,
});

initSliceView({
  ensureVoxels,
  hideHover,
  isMprActive,
});

const viewerBridge = {
  resetTransform,
  zoomToFit,
  is3dActive,
  isMprActive,
  setMode,
  renderFindings,
  renderScrubTicks,
  renderRegionLegend,
  renderFusionPicker,
  renderRoiResults,
  syncModalityPresets,
  syncOverlayOpacityUI,
  syncToolbarReadyState,
  drawSlice,
  drawMeasurements,
  sync3DScrubber,
  applyThreeDPresetForSeries,
  renderMicroscopyHyperstackControls,
  buildVolume,
  updateUniforms,
  updateClipReadouts,
  ensureVoxels,
  ensureThree,
  syncThreeSurfaceState,
  syncMprSliceIndex,
  drawMPR,
};

async function selectSeries(i, opts) {
  const series = state.manifest.series[i];
  if (series) await expandFolderForSeries(series.slug);
  return runSelectSeries(i, viewerBridge, opts);
}
