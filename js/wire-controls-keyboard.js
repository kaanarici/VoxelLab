// Global keyboard shortcuts for the viewer (wired from wire-controls.js).

import { $, closeTopModal } from './dom.js';
import { cancelAskQuestionIfOpen } from './consult-ask.js';
import { state } from './state.js';
import { toggleAskMode } from './consult-ask.js';
import { drawMeasurements, toggleMeasure } from './measure.js';
import { toggleCine } from './cine.js';
import { stepMicroscopyStackPosition } from './microscopy-hyperstack-controls.js';
import { runShortcutEvent } from './keyboard-shortcuts.js';
import {
  cancelROI,
  currentROIMode,
  finalizePolygonROI,
  isROIMode,
  toggleROI,
} from './roi.js';
import { toggleAnnotate } from './annotation.js';
import { setSliceIndex } from './state/viewer-commands.js';
import { setMeasurePending } from './state/viewer-tool-commands.js';

const REPEATABLE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function eventElement(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  return path.find((node) => node?.nodeType === 1)
    || (e.target?.nodeType === 1 ? e.target : e.target?.parentElement)
    || null;
}

function shouldIgnoreShortcut(e) {
  const el = eventElement(e);
  return !!el?.closest?.('input, select, textarea, button, [contenteditable]');
}

function handleMicroscopyStackShortcut(e, key) {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || series?.imageDomain !== 'microscopy') return false;
  if (key === 'ArrowLeft') stepMicroscopyStackPosition({ channelDelta: -1 });
  else if (key === 'ArrowRight') stepMicroscopyStackPosition({ channelDelta: 1 });
  else if (key === 'ArrowUp') stepMicroscopyStackPosition({ timeDelta: -1 });
  else if (key === 'ArrowDown') stepMicroscopyStackPosition({ timeDelta: 1 });
  else return false;
  e.preventDefault();
  return true;
}

/**
 * @param {object} deps
 * @param {HTMLInputElement} deps.scrub
 * @param {(d: number) => void} deps.step
 * @param {(i: number) => void} deps.selectSeries
 */
export function wireKeyboardShortcuts(deps) {
  const {
    scrub,
    step,
    selectSeries,
  } = deps;

  window.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (key === 'Escape') {
      if (cancelAskQuestionIfOpen()) return;
      if (closeTopModal()) return;
      if (state.measurePending) { setMeasurePending(null); drawMeasurements(); return; }
      if (state.measureMode) { toggleMeasure(); return; }
      if (state.annotateMode) { toggleAnnotate(); return; }
      if (state.askMode) { toggleAskMode(); return; }
      if (isROIMode()) {
        cancelROI(); toggleROI(currentROIMode()); $('view-xform').classList.remove('roi-mode'); return;
      }
    }
    if (shouldIgnoreShortcut(e)) return;
    if (e.repeat && !REPEATABLE_KEYS.has(e.key)) return;
    if (key === 'Enter' && isROIMode() && currentROIMode() === 'polygon') {
      finalizePolygonROI();
      return;
    }
    if (handleMicroscopyStackShortcut(e, key)) return;
    if (key === 'ArrowUp') { step(-1); e.preventDefault(); return; }
    if (key === 'ArrowDown') { step(1); e.preventDefault(); return; }
    if (key === 'ArrowLeft') { selectSeries((state.seriesIdx - 1 + state.manifest.series.length) % state.manifest.series.length); return; }
    if (key === 'ArrowRight') { selectSeries((state.seriesIdx + 1) % state.manifest.series.length); return; }
    if (key === 'Home') { setSliceIndex(0); $('scrub').value = 0; scrub.dispatchEvent(new Event('input')); return; }
    if (key === 'End') {
      const max0 = state.manifest.series[state.seriesIdx].slices - 1;
      setSliceIndex(max0); $('scrub').value = max0; scrub.dispatchEvent(new Event('input'));
      return;
    }
    if (key === ' ') { toggleCine(); e.preventDefault(); return; }
    runShortcutEvent(e);
  });
}
