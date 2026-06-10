// Main 2D canvas: pan/zoom/window, hover, tool routing (wired from wire-controls.js).

import { $ } from './dom.js';
import { state } from './core/state.js';
import {
  isROIMode,
  currentROIMode,
  onROIDown,
  onROIMove,
} from './roi.js';
import { onMeasureClick, drawMeasurements } from './roi/measure.js';
import { isAngleMode, onAngleClick } from './roi/angle.js';
import { isSlimSAMMode, onSlimSAMClick } from './overlay/slimsam-tool.js';
import {
  onAnnotateClick,
  pinAtClient, showAnnotHover, hideAnnotHover,
} from './overlay/annotation.js';
import { hideAskReticle } from './ask-mode.js';
import {
  applyTransform, resetTransform, zoomAt,
} from './view-transform.js';
import { updateScaleBar } from './overlay/scale-bar.js';
import { showHoverAt } from './slice-view.js';
import { setWindowLevel } from './core/state/viewer-commands.js';

/**
 * @param {object} deps
 * @param {(cx: number, cy: number) => [number, number]} deps.clientToCanvasPx
 * @param {(d: number) => void} deps.step
 * @param {() => void} deps.hideHover
 */
export function wireViewCanvas(deps) {
  const { clientToCanvasPx, step, hideHover } = deps;
  let wlFramePending = false;
  let pendingWindow = state.window;
  let pendingLevel = state.level;

  const wrap = $('canvas-wrap');
  wrap.addEventListener('wheel', (e) => {
    if (state.mode !== '2d' && state.mode !== 'cmp') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(e.clientX, e.clientY, factor);
    } else {
      step(e.deltaY > 0 ? 1 : -1);
    }
  }, { passive: false });

  const canvas = $('view');
  let dragging = false; let panning = false; let lastX = 0; let lastY = 0;
  const xform = $('view-xform');
  // Controls are zoom-independent: drag pans (grab), Shift adjusts window/level
  // (ew-resize). Keeping this fixed avoids datasets that load at fit-zoom <= 1.01
  // (e.g. large CT) silently inverting the default drag.
  const syncPassiveCursor = (e = {}) => {
    xform.classList.toggle('wl-ready', !!e.shiftKey);
    xform.classList.toggle('pan-ready', !e.shiftKey);
  };
  canvas.addEventListener('mousedown', async (e) => {
    if (isROIMode() && state.mode === '2d') {
      const [px, py] = clientToCanvasPx(e.clientX, e.clientY);
      onROIDown(px, py);
      e.preventDefault();
      return;
    }
    if (state.measureMode) { onMeasureClick(e); return; }
    if (isAngleMode()) { onAngleClick(e); drawMeasurements(); return; }
    if (isSlimSAMMode()) { onSlimSAMClick(e, clientToCanvasPx); return; }
    if (state.annotateMode) { onAnnotateClick(e); return; }
    if (state.askMode) {
      e.preventDefault();
      const { handleAskPointerDown } = await import('./consult-ask.js');
      handleAskPointerDown(e);
      return;
    }
    const hit = pinAtClient(e.clientX, e.clientY);
    if (hit && state.mode === '2d') {
      e.preventDefault();
      onAnnotateClick(e);
      return;
    }
    lastX = e.clientX; lastY = e.clientY;
    const wantsPan = e.metaKey || e.ctrlKey || !e.shiftKey;
    if (wantsPan) {
      panning = true;
      e.preventDefault();
      xform.classList.add('panning');
    } else {
      pendingWindow = state.window;
      pendingLevel = state.level;
      dragging = true;
      xform.classList.add('wl-dragging');
    }
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    xform.classList.remove('wl-dragging');
    if (panning) {
      panning = false;
      xform.classList.remove('panning');
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      pendingWindow = Math.max(1, Math.min(512, pendingWindow + (e.clientX - lastX)));
      pendingLevel = Math.max(0, Math.min(255, pendingLevel - (e.clientY - lastY)));
      lastX = e.clientX; lastY = e.clientY;
      if (!wlFramePending) {
        wlFramePending = true;
        requestAnimationFrame(() => {
          wlFramePending = false;
          setWindowLevel(pendingWindow, pendingLevel);
        });
      }
    } else if (panning) {
      state.tx += (e.clientX - lastX);
      state.ty += (e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
      applyTransform();
    }
  });
  canvas.addEventListener('dblclick', () => {
    pendingWindow = 255;
    pendingLevel = 128;
    setWindowLevel(255, 128);
    resetTransform();
  });

  canvas.addEventListener('mousemove', (e) => {
    if (isROIMode() && currentROIMode() === 'ellipse' && state.mode === '2d') {
      const [px, py] = clientToCanvasPx(e.clientX, e.clientY);
      if (onROIMove(px, py)) drawMeasurements();
    }
    if (state.askMode && state.mode === '2d' && !dragging && !panning) {
      hideAnnotHover();
      hideHover();
      canvas.style.cursor = 'crosshair';
      return;
    }
    hideAskReticle();
    if (dragging || panning || state.mode !== '2d') {
      hideHover(); hideAnnotHover();
      return;
    }
    const hit = pinAtClient(e.clientX, e.clientY);
    if (hit) {
      hideHover();
      showAnnotHover(hit.pin, hit.index, e.clientX, e.clientY);
      canvas.style.cursor = 'pointer';
    } else {
      hideAnnotHover();
      canvas.style.cursor = '';
      syncPassiveCursor(e);
      showHoverAt(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('mouseleave', () => {
    hideHover();
    hideAnnotHover();
    hideAskReticle();
    canvas.style.cursor = '';
    xform.classList.remove('pan-ready');
  });

  window.addEventListener('resize', () => {
    updateScaleBar();
    drawMeasurements();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      updateScaleBar();
      drawMeasurements();
    }));
  });
}
