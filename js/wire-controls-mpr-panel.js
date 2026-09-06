import { $ } from './dom.js';
import { initHorizontalScrollFades } from './shell/horizontal-scroll-fades.js';
import { isMprActive } from './core/mode-flags.js';
import { state } from './core/state.js';
import {
  drawMPR,
  drawObliqueCell,
  beginObliqueInteraction,
  beginMprInteraction,
  mprClickToVoxel,
  showMprHover,
  syncMprCrosshairBounds,
} from './slice-view.js';
import {
  getMprViewport,
  nudgeMprAxis,
  resetMprViewport as resetMprViewportState,
  setMprGpuEnabled,
  setMprProjection,
  setMprViewport,
  setObliqueAngles,
} from './core/state/viewer-commands.js';

function canUseGpuMpr() {
  return Boolean(globalThis.document && globalThis.WebGL2RenderingContext);
}

function paneForCanvas(canvas) {
  return {
    'mpr-ax': 'ax',
    'mpr-co': 'co',
    'mpr-sa': 'sa',
    'mpr-ob': 'ob',
  }[canvas?.id] || '';
}

let activePan = null;

function ensureMprViewport(canvas) {
  return getMprViewport(paneForCanvas(canvas)) || { zoom: 1, tx: 0, ty: 0 };
}

function applyMprViewport(canvas) {
  const view = ensureMprViewport(canvas);
  canvas.style.transformOrigin = '50% 50%';
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`;
  canvas.style.cursor = activePan?.canvas === canvas ? 'grabbing' : view.zoom > 1.01 ? 'grab' : 'crosshair';
  syncMprCrosshairBounds();
}

function zoomMprViewport(canvas, clientX, clientY, factor) {
  const view = ensureMprViewport(canvas);
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left - rect.width / 2;
  const cy = clientY - rect.top - rect.height / 2;
  const nextZoom = Math.max(1, Math.min(8, view.zoom * factor));
  if (nextZoom === view.zoom) return;
  setMprViewport(paneForCanvas(canvas), {
    zoom: nextZoom,
    tx: cx - (cx - view.tx) * (nextZoom / view.zoom),
    ty: cy - (cy - view.ty) * (nextZoom / view.zoom),
  });
  applyMprViewport(canvas);
}

function resetMprViewport(canvas) {
  resetMprViewportState(paneForCanvas(canvas));
  applyMprViewport(canvas);
}

function stepMprViewport(canvas, factor) {
  const view = ensureMprViewport(canvas);
  const nextZoom = Math.max(1, Math.min(8, view.zoom * factor));
  if (nextZoom === view.zoom) return;
  setMprViewport(paneForCanvas(canvas), {
    zoom: nextZoom,
    tx: nextZoom === 1 ? 0 : view.tx,
    ty: nextZoom === 1 ? 0 : view.ty,
  });
  applyMprViewport(canvas);
}

let _focusedCanvas = null;

function setMprFocus(canvas) {
  if (_focusedCanvas === canvas) return;
  document.querySelectorAll('#mpr-grid > .mpr-cell').forEach(c => c.classList.remove('mpr-focused'));
  const cell = canvas.closest('.mpr-cell');
  if (cell) cell.classList.add('mpr-focused');
  _focusedCanvas = canvas;
  syncMprZoomLabel();
}

function syncMprZoomLabel() {
  const label = $('mpr-zoom-val');
  if (!label) return;
  const canvas = _focusedCanvas || $('mpr-ax');
  const view = ensureMprViewport(canvas);
  label.textContent = `${Math.round(view.zoom * 100)}%`;
}

export function wireMprPanel(deps) {
  const { hideHover } = deps;
  const gpuToggle = $('mpr-gpu-toggle');
  const syncGpuUi = () => {
    const available = canUseGpuMpr();
    gpuToggle.checked = !!state.mpr.gpuEnabled;
    gpuToggle.disabled = !available;
  };
  syncGpuUi();

  const setOb = (source = 'slider') => {
    const isNumber = source.endsWith('-number');
    const yawSource = source === 'yaw-number' ? $('ob-yaw-val') : $('ob-yaw');
    const pitchSource = source === 'pitch-number' ? $('ob-pitch-val') : $('ob-pitch');
    if (!yawSource.value.trim() || !pitchSource.value.trim()) return;
    const yaw = Number(yawSource.value);
    const pitch = Number(pitchSource.value);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    beginObliqueInteraction(source);
    if (!isNumber) {
      resetMprViewport($('mpr-ob'));
      syncMprZoomLabel();
    }
    setObliqueAngles({ yaw, pitch });
    if (isMprActive()) drawObliqueCell();
  };
  $('ob-yaw').addEventListener('input', () => setOb('yaw-slider'));
  $('ob-pitch').addEventListener('input', () => setOb('pitch-slider'));
  $('ob-yaw-val').addEventListener('input', () => setOb('yaw-number'));
  $('ob-pitch-val').addEventListener('input', () => setOb('pitch-number'));
  $('ob-yaw-val').addEventListener('change', () => { $('ob-yaw-val').value = state.mpr.obYaw; });
  $('ob-pitch-val').addEventListener('change', () => { $('ob-pitch-val').value = state.mpr.obPitch; });
  $('ob-reset').onclick = () => {
    $('ob-yaw').value = 0; $('ob-pitch').value = 30;
    setOb('reset');
  };

  const projBtns = document.querySelectorAll('.mpr-proj-btn');
  const slabSlider = $('mpr-slab');
  const slabVal = $('mpr-slab-val');
  const syncProjUi = () => {
    const mode = state.mpr.projectionMode || 'thin';
    projBtns.forEach((button) => {
      const active = button.dataset.proj === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (slabSlider) slabSlider.value = state.mpr.slabThicknessMm || 0;
    if (slabVal) slabVal.textContent = `${state.mpr.slabThicknessMm || 0} mm`;
  };
  syncProjUi();
  projBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setMprProjection({ mode: btn.dataset.proj });
      syncProjUi();
      if (isMprActive()) drawMPR();
    });
  });
  if (slabSlider) {
    slabSlider.addEventListener('input', () => {
      setMprProjection({ slabThicknessMm: Number(slabSlider.value) });
      syncProjUi();
      if (isMprActive()) drawMPR();
    });
  }

  $('mpr-zoom-in').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    stepMprViewport(c, 1.2);
    syncMprZoomLabel();
  });
  $('mpr-zoom-out').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    stepMprViewport(c, 1 / 1.2);
    syncMprZoomLabel();
  });
  $('mpr-zoom-fit').addEventListener('click', () => {
    const c = _focusedCanvas || $('mpr-ax');
    resetMprViewport(c);
    syncMprZoomLabel();
  });

  gpuToggle.addEventListener('change', () => {
    if (!canUseGpuMpr()) { syncGpuUi(); return; }
    setMprGpuEnabled(gpuToggle.checked);
    syncGpuUi();
    if (isMprActive()) drawObliqueCell();
  });

  syncMprZoomLabel();
  initHorizontalScrollFades($('mpr-toolbar-wrap'), $('mpr-toolbar'));

  window.addEventListener('mouseup', () => {
    if (!activePan) return;
    const { canvas, moved } = activePan;
    canvas._mprIgnoreClick = moved;
    activePan = null;
    applyMprViewport(canvas);
  });
  window.addEventListener('mousemove', (e) => {
    if (!activePan) return;
    const { canvas, lastX, lastY } = activePan;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (!dx && !dy) return;
    const view = ensureMprViewport(canvas);
    setMprViewport(paneForCanvas(canvas), {
      zoom: view.zoom,
      tx: view.tx + dx,
      ty: view.ty + dy,
    });
    activePan.lastX = e.clientX;
    activePan.lastY = e.clientY;
    activePan.moved = true;
    applyMprViewport(canvas);
  });

  for (const [id, axis] of [['mpr-ax', 'ax'], ['mpr-co', 'co'], ['mpr-sa', 'sa']]) {
    const c = $(id);
    c.addEventListener('click', (e) => {
      if (c._mprIgnoreClick) { c._mprIgnoreClick = false; return; }
      setMprFocus(c);
      mprClickToVoxel(c, e, axis);
    });
    c.addEventListener('mousemove', (e) => {
      if (activePan?.canvas === c) { hideHover(); return; }
      showMprHover(c, e, axis);
    });
    c.addEventListener('mouseleave', hideHover);
    c.addEventListener('mousedown', (e) => {
      setMprFocus(c);
      const view = ensureMprViewport(c);
      const wantsPan = e.button === 1 || e.metaKey || e.ctrlKey || view.zoom > 1.01;
      if (!wantsPan) return;
      e.preventDefault();
      activePan = { canvas: c, lastX: e.clientX, lastY: e.clientY, moved: false };
      applyMprViewport(c);
    });
    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetMprViewport(c);
      syncMprZoomLabel();
    });
    c.addEventListener('wheel', (e) => {
      if (!isMprActive()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        zoomMprViewport(c, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        syncMprZoomLabel();
        return;
      }
      const d = e.deltaY > 0 ? 1 : -1;
      if (axis === 'ax') {
        beginMprInteraction({ axis: 'z', reason: 'wheel' });
        nudgeMprAxis('z', d);
        return;
      }
      beginMprInteraction({ axis: axis === 'co' ? 'y' : 'x', reason: 'wheel' });
      nudgeMprAxis(axis === 'co' ? 'y' : 'x', d);
    }, { passive: false });
  }

  const obCanvas = $('mpr-ob');
  if (obCanvas) {
    obCanvas.addEventListener('mousedown', (e) => {
      setMprFocus(obCanvas);
      const view = ensureMprViewport(obCanvas);
      const wantsPan = e.button === 1 || e.metaKey || e.ctrlKey || view.zoom > 1.01;
      if (!wantsPan) return;
      e.preventDefault();
      activePan = { canvas: obCanvas, lastX: e.clientX, lastY: e.clientY, moved: false };
      applyMprViewport(obCanvas);
    });
    obCanvas.addEventListener('wheel', (e) => {
      if (!isMprActive()) return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        zoomMprViewport(obCanvas, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        syncMprZoomLabel();
      }
    }, { passive: false });
    obCanvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetMprViewport(obCanvas);
      syncMprZoomLabel();
    });
  }
}
