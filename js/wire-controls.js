// DOM event wiring: toolbar, canvas, MPR panels, keyboard shortcuts.
import { state } from './core/state.js';
import { $, escapeHtml, showDialog, initModals } from './dom.js';
import { toggleAskMode } from './ask-mode.js';
import {
  setCTWindow,
  toggle3D,
  toggleMPR,
  toggleCompare,
} from './view-modes.js';
import {
  toggleROI, isROIMode, currentROIMode, cancelROI,
} from './roi.js';
import {
  updateScrubFill as _updateScrubFill, startCine, stopCine, toggleCine,
} from './cine.js';
import { initScrubberMarkers, magnetizeSliceValue } from './scrubber-markers.js';
import { updateScaleBar } from './overlay/scale-bar.js';
import { toggleMeasure } from './roi/measure.js';
import { drawCompare, loadComparePeers, buildCompareMenu, getGroupPeers } from './series/compare.js';
import {
  toggleAnnotate,
  renderAnnotationList,
} from './overlay/annotation.js';
import { toggleInvert, zoomToFit, applyMRPreset } from './shell/viewport.js';
import { toggleAngle, isAngleMode } from './roi/angle.js';
import { COLORMAPS, setColormap } from './colormap.js';
import { is3dActive, isMprActive } from './core/mode-flags.js';
import { clearCurrentSliceDrawings } from './clear-slice-drawings.js';
import { ensureOverlayStack } from './overlay/overlay-stack.js';
import { loadImageStack } from './series/series-image-stack.js';
import { rememberPreferredOverlay, forgetPreferredOverlay } from './overlay/overlay-preferences.js';
import { syncOverlays } from './sync.js';
import { initSlimSAMTool, isSlimSAMMode, toggleSlimSAM } from './overlay/slimsam-tool.js';
import {
  sync3DScrubber as _sync3DScrubber,
  updateUniforms,
  setThreeDView,
  ensureVoxels,
  ensureHRVoxels,
  buildVolume,
  syncThreeSurfaceState,
  updateLabelTexture,
} from './volume/volume-3d.js';
import {
  updateSliceDisplay as _updateSliceDisplay,
  drawSlice,
  drawMPR,
} from './slice-view.js';
import { drawSparkline as _drawSparkline } from './sparkline.js';
import { drawMeasurements as _drawMeasurements } from './roi/measure.js';
import { wireKeyboardShortcuts } from './wire-controls-keyboard.js';
import { wireMprPanel } from './wire-controls-mpr-panel.js';
import { wireViewCanvas } from './wire-controls-view-canvas.js';
import {
  setBrainStack,
  setCineFps,
  setClipAxis,
  setFusionOpacity,
  setLoaded,
  resetCompareViewport,
  resetMprViewport,
  setOverlayEnabled,
  setOverlayOpacity,
  setRenderMode,
  setSliceIndex,
  setVolumeTransfer,
} from './core/state/viewer-commands.js';
import { syncMrPresetActiveState, syncToolbarReadyState } from './shell/toolbar-chrome.js';
import { invalidateVoxelCache } from './runtime/viewer-runtime.js';
import { beginPerfTrace } from './core/perf-trace.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';

function wireDesktopBridgeIfAvailable(selectSeries) {
  if (!globalThis.voxellabDesktop) return;
  import('./desktop-bridge.js')
    .then(({ wireDesktopBridge }) => wireDesktopBridge(selectSeries))
    .catch((e) => showDialog('Desktop bridge failed', escapeHtml(e.message || String(e))));
}

export function wireControls(deps) {
  const {
    selectSeries,
    autoWindowLevel,
    toggleHelp,
    hideHover,
    applyPreset,
    step,
    clientToCanvasPx,
  } = deps;

  initModals();

  const scrub = $('scrub');
  initScrubberMarkers();
  let _scrubRAF = 0;
  let _pendingSliceIdx = state.sliceIdx;
  scrub.addEventListener('input', () => {
    _pendingSliceIdx = magnetizeSliceValue(+scrub.value);
    stopCine();
    if (_scrubRAF) return;           // coalesce: one redraw per frame
    _scrubRAF = requestAnimationFrame(() => {
      _scrubRAF = 0;
      setSliceIndex(_pendingSliceIdx);
    });
  });

  const zScrub = $('s-zscrub');
  if (zScrub) {
    let _zScrubRAF = 0;
    let _pendingZIdx = state.sliceIdx;
    zScrub.addEventListener('input', () => {
      _pendingZIdx = +zScrub.value;
      stopCine();
      if (_zScrubRAF) return;
      _zScrubRAF = requestAnimationFrame(() => {
        _zScrubRAF = 0;
        setSliceIndex(_pendingZIdx);
      });
    });
  }

  $('sparkline').addEventListener('click', (e) => {
    if (!state.stats || !state.stats.symmetryScores) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    const n = state.stats.symmetryScores.length;
    setSliceIndex(Math.max(0, Math.min(n - 1, Math.floor(frac * n))));
  });

  $('btn-play').onclick = toggleCine;
  $('fps').addEventListener('input', (e) => {
    setCineFps(e.target.value);
    $('fps-val').textContent = state.cineFps;
    if (state.cineTimer) { stopCine(); startCine(); }
  });

  $('btn-upload').onclick = async () => {
    try {
      const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
      await showStudyUploadModal(selectSeries);
    } catch (e) {
      showDialog('Upload failed', escapeHtml(e.message || String(e)));
    }
  };
  wireDesktopBridgeIfAvailable(selectSeries);

  $('btn-auto').onclick = autoWindowLevel;
  $('btn-invert').onclick = toggleInvert;

  const cmapTrigger = $('cmap-trigger');
  const cmapMenu = $('cmap-menu');
  const cmapDropdown = $('cmap-dropdown');
  // Sample the 256-entry RGBA LUT at a few stops into a CSS gradient preview.
  const swatchGradient = (lut) => {
    const stops = [];
    for (let i = 0; i <= 6; i++) {
      const idx = Math.round((i / 6) * 255) * 4;
      stops.push(`rgb(${lut[idx]},${lut[idx + 1]},${lut[idx + 2]}) ${Math.round((i / 6) * 100)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(',')})`;
  };
  for (const [name, cm] of Object.entries(COLORMAPS)) {
    const item = document.createElement('div');
    item.className = 'dd-item cmap-pick' + (name === 'grayscale' ? ' active' : '');
    item.dataset.value = name;
    const swatch = document.createElement('span');
    swatch.className = 'cmap-swatch';
    swatch.style.background = swatchGradient(cm.lut);
    const label = document.createElement('span');
    label.className = 'cmap-name';
    label.textContent = cm.label;
    item.append(swatch, label);
    item.addEventListener('click', () => {
      setColormap(name);
      $('cmap-label').textContent = cm.label;
      cmapMenu.querySelectorAll('.dd-item').forEach((el) => el.classList.toggle('active', el.dataset.value === name));
      cmapDropdown.classList.remove('open');
      cmapTrigger.setAttribute('aria-expanded', 'false');
      syncOverlays();
    });
    cmapMenu.appendChild(item);
  }
  const closePopups = () => {
    document.querySelectorAll('.custom-dropdown.open, .toolbox.open')
      .forEach((el) => el.classList.remove('open'));
    cmapTrigger.setAttribute('aria-expanded', 'false');
    document.getElementById('btn-compare')?.setAttribute('aria-expanded', 'false');
  };

  cmapTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = cmapDropdown.classList.contains('open');
    closePopups();
    if (!wasOpen) {
      cmapDropdown.classList.add('open');
      cmapTrigger.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('click', closePopups);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopups();
  });

  // Toolbox panels are centered over their trigger; clamp to the viewport so a
  // far-right trigger (e.g. Tools) doesn't spill off-screen, and slide the caret
  // back over the trigger by the same amount.
  const EDGE = 8;
  const clampToolboxPanel = (box) => {
    const panel = box.querySelector('.toolbox-panel');
    if (!panel) return;
    panel.style.transform = 'translateX(-50%)';
    panel.style.removeProperty('--toolbox-caret-x');
    const r = panel.getBoundingClientRect();
    let shift = 0;
    if (r.right > window.innerWidth - EDGE) shift = (window.innerWidth - EDGE) - r.right;
    else if (r.left < EDGE) shift = EDGE - r.left;
    if (shift) {
      panel.style.transform = `translateX(calc(-50% + ${shift}px))`;
      panel.style.setProperty('--toolbox-caret-x', `calc(50% - ${shift}px)`);
    }
  };

  // Toolbox triggers — click to toggle floating panel
  document.querySelectorAll('.toolbox-trigger').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = trigger.closest('.toolbox');
      const wasOpen = box.classList.contains('open');
      closePopups();
      if (!wasOpen) {
        box.classList.add('open');
        clampToolboxPanel(box);
        requestAnimationFrame(() => updateScaleBar());
      }
    });
  });
  // Clicks inside a toolbox panel should not close it
  document.querySelectorAll('.toolbox-panel').forEach((panel) => {
    panel.addEventListener('click', (e) => e.stopPropagation());
  });

  // Keep toolbox trigger dot badges in sync when panel tools gain/lose .active.
  // Only .toolbox-panel .icon-btn count — avoids stray .icon-btn nodes and matches
  // the “something in this flyout is on” intent. Skips mutations on triggers only
  // (has-active toggles) to limit feedback loops.
  const syncToolboxBadges = () => {
    document.querySelectorAll('.toolbox').forEach((box) => {
      const trigger = box.querySelector('.toolbox-trigger');
      const panel = box.querySelector('.toolbox-panel');
      if (!trigger || !panel) return;
      const anyActive = [...panel.querySelectorAll('.icon-btn')].some((b) =>
        b.classList.contains('active') && !b.classList.contains('hidden'));
      trigger.classList.toggle('has-active', anyActive);
    });
  };
  let _badgeRaf = 0;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => m.target.closest?.('.toolbox-trigger'))) return;
    if (_badgeRaf) return;
    _badgeRaf = requestAnimationFrame(() => { _badgeRaf = 0; syncToolboxBadges(); });
  }).observe(
    document.querySelector('.controls'),
    { subtree: true, attributes: true, attributeFilter: ['class'] },
  );
  syncToolboxBadges();
  requestAnimationFrame(() => syncToolboxBadges());

  $('overlay-opacity').addEventListener('input', (e) => {
    setOverlayOpacity(e.target.value);
  });

  document.querySelectorAll('#mr-presets [data-mrpreset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyMRPreset(btn.dataset.mrpreset);
      syncMrPresetActiveState();
    });
  });
  const fitActiveView = () => {
    if (state.mode === 'cmp') {
      resetCompareViewport();
      drawCompare();
      return;
    }
    if (isMprActive()) {
      ['ax', 'co', 'sa', 'ob'].forEach((pane) => resetMprViewport(pane));
      drawMPR();
    }
    if (is3dActive()) {
      void setThreeDView('reset');
      return;
    }
    if (!isMprActive()) zoomToFit();
  };
  $('btn-zoomfit').onclick = fitActiveView;
  $('btn-clear').onclick = clearCurrentSliceDrawings;
  $('btn-angle').onclick = () => {
    deactivateOthers('angle');
    toggleAngle();
  };
  $('btn-shot').onclick = async () => {
    try {
      const { takeScreenshot } = await import('./screenshot.js');
      await takeScreenshot();
    } catch (e) {
      showDialog('Screenshot failed', escapeHtml(e.message || String(e)));
    }
  };
  $('btn-consult').onclick = async () => {
    const { runConsult } = await import('./consult-ask.js');
    await runConsult(false);
  };
  $('btn-sr').onclick = async () => {
    try {
      const { exportDicomSR } = await import('./dicom/dicom-sr.js');
      const { count, filename } = await exportDicomSR(state);
      showDialog('DICOM SR exported', `
        <div class="dlg-body">Saved ${count} measurement${count > 1 ? 's' : ''} as <code>${escapeHtml(filename)}</code>.</div>
        <div class="dlg-sub">TID 1500-style research export for downstream inspection. Validate semantics in your target viewer before relying on round-trip interoperability.</div>
      `);
    } catch (err) {
      showDialog('Export failed', `
        <div class="dlg-body-err">${escapeHtml(err.message)}</div>
      `);
    }
  };

  // Init SlimSAM tool
  initSlimSAMTool({ drawSlice });
  const slimsamBtn = $('btn-slimsam');
  if (slimsamBtn) {
    slimsamBtn.onclick = () => {
      deactivateOthers('slimsam');
      toggleSlimSAM();
    };
  }

  const deactivateOthers = (except) => {
    if (except !== 'measure' && state.measureMode) toggleMeasure();
    if (except !== 'angle' && isAngleMode()) toggleAngle();
    if (except !== 'slimsam' && isSlimSAMMode()) toggleSlimSAM();
    if (except !== 'annotate' && state.annotateMode) toggleAnnotate();
    if (except !== 'ask' && state.askMode) toggleAskMode();
    if (except !== 'roi' && isROIMode()) { cancelROI(); toggleROI(currentROIMode()); }
  };
  $('btn-measure').onclick = () => {
    deactivateOthers('measure');
    toggleMeasure();
  };
  $('btn-annot').onclick = () => {
    deactivateOthers('annotate');
    toggleAnnotate();
    renderAnnotationList();
  };
  $('btn-ask').onclick = () => {
    deactivateOthers('ask');
    if (toggleAskMode()) void import('./consult-ask.js');
  };
  $('btn-roi-ell').onclick = () => {
    deactivateOthers('roi');
    toggleROI('ellipse');
    $('btn-roi-ell').classList.toggle('active', currentROIMode() === 'ellipse');
    $('btn-roi-poly').classList.toggle('active', false);
    $('btn-roi-point').classList.toggle('active', false);
    $('view-xform').classList.toggle('roi-mode', isROIMode());
  };
  $('btn-roi-poly').onclick = () => {
    deactivateOthers('roi');
    toggleROI('polygon');
    $('btn-roi-poly').classList.toggle('active', currentROIMode() === 'polygon');
    $('btn-roi-ell').classList.toggle('active', false);
    $('btn-roi-point').classList.toggle('active', false);
    $('view-xform').classList.toggle('roi-mode', isROIMode());
  };
  $('btn-roi-point').onclick = () => {
    deactivateOthers('roi');
    toggleROI('point');
    $('btn-roi-point').classList.toggle('active', currentROIMode() === 'point');
    $('btn-roi-ell').classList.toggle('active', false);
    $('btn-roi-poly').classList.toggle('active', false);
    $('view-xform').classList.toggle('roi-mode', isROIMode());
  };

  $('btn-help').onclick = toggleHelp;

  // Seg and regions are mutually exclusive; sym is independent.
  // Shared toggle: flip state, deactivate the rival if exclusive, load stack, redraw.
  const toggleLabelOverlay = (type, stateKey, hasKey, exclusive) => {
    const s = state.manifest.series[state.seriesIdx];
    const overlays = activeOverlayStateForSeries(s);
    const kind = {
      hasSeg: 'tissue',
      hasRegions: 'labels',
      hasSym: 'heatmap',
    }[hasKey];
    if (!kind || !overlays[kind]?.available) return;
    const next = !state[stateKey];
    setOverlayEnabled(stateKey, next, exclusive);
    if (next) {
      beginPerfTrace('overlay-toggle-paint', {
        slug: s?.slug || '',
        overlay: type,
      });
    }
    // Track preferred overlays per modality for prefetch on later series opens.
    if (next) {
      rememberPreferredOverlay(s.modality, type);
    } else {
      forgetPreferredOverlay(s.modality, type);
    }
    syncOverlays();
    if (next) {
      ensureOverlayStack(type)?.then(() => {
        if (state[stateKey]) syncOverlays();
      });
    }
    const nextOverlays = activeOverlayStateForSeries(s);
    $('btn-seg')?.classList.toggle('active', nextOverlays.tissue.enabled);
    $('btn-regions')?.classList.toggle('active', nextOverlays.labels.enabled);
    $('btn-sym')?.classList.toggle('active', nextOverlays.heatmap.enabled);
    if (is3dActive()) { invalidateVoxelCache(); if (ensureVoxels()) void updateLabelTexture(); }
    if (state.mode === 'cmp') {
      loadComparePeers().then(() => drawCompare());
    }
  };
  $('btn-regions').onclick = () => toggleLabelOverlay('regions', 'useRegions', 'hasRegions', ['useSeg']);
  $('btn-seg').onclick     = () => toggleLabelOverlay('seg',     'useSeg',     'hasSeg',     ['useRegions']);
  $('btn-sym').onclick     = () => toggleLabelOverlay('sym',     'useSym',     'hasSym');

  $('fusion-select').addEventListener('change', async (e) => {
    const { loadFusion } = await import('./fusion-loader.js');
    await loadFusion(e.target.value || null);
  });
  $('fusion-opacity').addEventListener('input', (e) => {
    setFusionOpacity(e.target.value);
    $('fusion-opacity-val').textContent = Math.round(state.fusionOpacity * 100) + '%';
  });

  document.querySelectorAll('#render-mode .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#render-mode .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      setRenderMode(pill.dataset.mode);
    });
  });

  document.querySelectorAll('#ct-window .pill').forEach((pill) => {
    pill.addEventListener('click', () => setCTWindow(pill.dataset.window));
  });

  document.querySelectorAll('.preset-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => { void setThreeDView(btn.dataset.view); });
  });

  $('btn-3d').onclick = toggle3D;
  $('btn-mpr').onclick = toggleMPR;
  const cmpDropdown = $('cmp-dropdown');
  const cmpMenu = $('cmp-menu');
  const cmpButton = $('btn-compare');
  const syncCmpStop = () => {
    const stop = cmpMenu.querySelector('.cmp-stop');
    if (stop) stop.hidden = state.mode !== 'cmp';
  };
  const rebuildCmpMenu = () => {
    buildCompareMenu(cmpMenu, {
      onSelectionChanged({ checked }) {
        // Decide on the user's CHECKED count, not the auto-group fallback — so
        // clearing below 2 cleanly exits compare instead of resurrecting the group.
        if (state.mode !== 'cmp') {
          if (checked.length >= 2) toggleCompare();
        } else if (checked.length < 2) {
          toggleCompare();
        }
        syncCmpStop();
      },
      onStop() {
        if (state.mode === 'cmp') toggleCompare();
        closePopups();
      },
    });
  };
  const openComparePicker = ({ focusFirst = false, autoStart = false } = {}) => {
    if (state.manifest.series.length < 2) return;
    rebuildCmpMenu();
    closePopups();
    cmpDropdown.classList.add('open');
    cmpButton.setAttribute('aria-expanded', 'true');
    if (autoStart && state.mode !== 'cmp' && getGroupPeers().length >= 2) toggleCompare();
    syncCmpStop();
    if (focusFirst) {
      requestAnimationFrame(() => cmpMenu.querySelector('input[type="checkbox"]')?.focus());
    }
  };
  cmpButton.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.manifest.series.length < 2) return;
    if (cmpDropdown.classList.contains('open')) {
      closePopups();
      return;
    }
    openComparePicker({ autoStart: true });
  });
  cmpButton.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (cmpDropdown.classList.contains('open')) {
      closePopups();
      return;
    }
    openComparePicker();
  });
  cmpButton.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    openComparePicker({ focusFirst: true });
  });
  $('btn-brain').onclick = async () => {
    const s = state.manifest.series[state.seriesIdx];
    if (!s.hasBrain) return;
    const requestId = state.selectRequestId;
    const slug = s.slug;
    const nextUseBrain = !state.useBrain;
    const variant = nextUseBrain ? `${s.slug}_brain` : s.slug;
    const { imgs, loaders } = loadImageStack(variant, s.slices, state.imgs, s);
    setBrainStack({ nextUseBrain, imgs });
    $('btn-brain').classList.toggle('active', state.useBrain);
    if (is3dActive()) syncThreeSurfaceState(s);
    const isCurrentBrainStack = () => (
      state.selectRequestId === requestId
      && state.manifest.series[state.seriesIdx]?.slug === slug
      && state.useBrain === nextUseBrain
    );

    try {
      if (loaders.length) await loaders[Math.min(state.sliceIdx, loaders.length - 1)];
    } finally {
      if (isCurrentBrainStack()) {
        setLoaded(true);
        syncToolbarReadyState();
      }
    }

    Promise.all(loaders).then(async () => {
      if (!isCurrentBrainStack()) return;
      if (is3dActive()) {
        if (ensureVoxels()) await buildVolume();
        updateUniforms();
      }
      if (state.mode === 'cmp') {
        await loadComparePeers();
        drawCompare();
      }
      await ensureHRVoxels();
    }).catch((err) => {
      console.warn('brain stack refresh failed:', err);
    }).finally(() => {
      if (isCurrentBrainStack()) syncThreeSurfaceState(s);
    });
  };
  wireMprPanel({ hideHover });

  const bind = (id, apply) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      apply(+el.value);
    });
  };
  bind('s-low', (v) => { setVolumeTransfer({ lowT: v }); });
  bind('s-high', (v) => { setVolumeTransfer({ highT: v }); });
  bind('s-gain', (v) => { setVolumeTransfer({ intensity: v }); });
  bind('s-xmin', (v) => { setClipAxis('min', 0, v); });
  bind('s-xmax', (v) => { setClipAxis('max', 0, v); });
  bind('s-ymin', (v) => { setClipAxis('min', 1, v); });
  bind('s-ymax', (v) => { setClipAxis('max', 1, v); });

  $('preset-full').onclick = () => applyPreset({ lowT: 0.08, highT: 1.0, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-surface').onclick = () => applyPreset({ lowT: 0.25, highT: 1.0, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-inside').onclick = () => applyPreset({ lowT: 0.08, highT: 0.6, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });
  $('preset-halfx').onclick = () => applyPreset({ lowT: state.lowT, highT: state.highT, clipMin: [0, 0, 0], clipMax: [0.5, 1, 1] });
  $('preset-halfy').onclick = () => applyPreset({ lowT: state.lowT, highT: state.highT, clipMin: [0, 0, 0], clipMax: [1, 0.5, 1] });
  $('preset-reset').onclick = () => applyPreset({ lowT: 0.08, highT: 1.0, intensity: 1.6, clipMin: [0, 0, 0], clipMax: [1, 1, 1] });

  wireViewCanvas({ clientToCanvasPx, step, hideHover });

  wireKeyboardShortcuts({
    scrub,
    step,
    selectSeries,
    toggleHelp,
    autoWindowLevel,
    fitActiveView,
  });
}
