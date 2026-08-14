import { state, subscribe } from './core/state.js';
import { $ } from './dom.js';
import { viewerAiFlags } from './config.js';
import { setAskMarquee, setAskMode } from './core/state/viewer-tool-commands.js';

let _cancelPendingOpen = null;

function cancelPendingOpen() {
  if (!_cancelPendingOpen) return;
  _cancelPendingOpen();
  _cancelPendingOpen = null;
}

function openStudyAskWhenReady() {
  cancelPendingOpen();
  const open = () => {
    if (!state.askMode || state.mode !== '2d' || !state.loaded) return;
    import('./consult-ask.js')
      .then((m) => m.openStudyAsk())
      .catch((err) => console.error('[ask] failed to open composer', err));
  };
  if (state.loaded) {
    open();
    return;
  }
  _cancelPendingOpen = subscribe('loaded', (loaded) => {
    if (!loaded) return;
    cancelPendingOpen();
    open();
  });
}

export function toggleAskMode() {
  const flags = viewerAiFlags();
  if (state.mode !== '2d' || !flags.localAiActionsEnabled) {
    cancelPendingOpen();
    setAskMode(false);
    $('btn-ask').classList.remove('active');
    syncAskPickingUi();
    return false;
  }
  const on = setAskMode(!state.askMode);
  $('btn-ask').classList.toggle('active', on);
  syncAskPickingUi();
  if (on) openStudyAskWhenReady();
  else cancelPendingOpen();
  return on;
}

// The crosshair / marquee / hint only show while the pen sub-tool is armed; in
// plain ask mode the viewer keeps its normal pan/window-level cursors.
export function syncAskPickingUi() {
  const wrap = $('canvas-wrap');
  const xform = $('view-xform');
  const picking = state.askMode && state.askPen && state.mode === '2d' && state.loaded;
  if (wrap) wrap.classList.toggle('ask-picking', picking);
  if (xform) xform.classList.toggle('measuring', picking || state.measureMode || state.annotateMode);
  const hint = $('ask-mode-hint');
  if (hint) hint.hidden = !picking;
  if (!picking) {
    setAskMarquee(null);
    hideAskReticle();
  }
}

export function syncAskModeAfterViewChange() {
  syncAskPickingUi();
}

export function hideAskReticle() {
  const el = $('ask-reticle');
  if (el) el.hidden = true;
}
