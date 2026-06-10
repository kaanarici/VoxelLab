import { state } from './core/state.js';
import { $ } from './dom.js';
import { viewerAiFlags } from './config.js';
import { setAskMarquee, setAskMode } from './core/state/viewer-tool-commands.js';

export function toggleAskMode() {
  const flags = viewerAiFlags();
  if (state.mode !== '2d' || !flags.localAiActionsEnabled) {
    setAskMode(false);
    $('btn-ask').classList.remove('active');
    $('view-xform').classList.toggle('measuring', state.measureMode || state.annotateMode);
    syncAskPickingUi();
    return false;
  }
  setAskMode(!state.askMode);
  $('btn-ask').classList.toggle('active', state.askMode);
  $('view-xform').classList.toggle(
    'measuring',
    state.askMode || state.measureMode || state.annotateMode,
  );
  syncAskPickingUi();
  return state.askMode;
}

function syncAskPickingUi() {
  const wrap = $('canvas-wrap');
  const hint = $('ask-mode-hint');
  if (!wrap || !hint) return;
  const show = state.askMode && state.mode === '2d' && state.loaded;
  wrap.classList.toggle('ask-picking', !!show);
  hint.hidden = !show;
  if (!show) {
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
