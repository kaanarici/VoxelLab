// Cine: advances state.sliceIdx at state.cineFps; redraws come from state subscribers.

import { $ } from './dom.js';
import { state } from './core/state.js';
import { stepSlice } from './core/state/viewer-commands.js';

// Update the filled portion of the custom slider track via CSS var.
// Called anywhere state.sliceIdx changes.
export function updateScrubFill() {
  const scrub = $('scrub');
  if (!scrub) return;
  const max = +scrub.max || 0;
  const pct = max > 0 ? (state.sliceIdx / max) * 100 : 0;
  scrub.style.setProperty('--fill', pct + '%');
  scrub.parentElement?.style.setProperty('--fill', pct + '%');
}

export function setPlayIcon(playing) {
  const use = document.querySelector('#btn-play use');
  if (use) use.setAttribute('href', playing ? 'icons.svg#i-pause' : 'icons.svg#i-play');
}

export function startCine() {
  if (state.cineTimer) return;
  setPlayIcon(true);
  $('btn-play').classList.add('active');
  let lastFrameTime = 0;
  const loop = (timestamp) => {
    if (!state.cineTimer) return;
    if (!lastFrameTime) lastFrameTime = timestamp;
    const interval = 1000 / state.cineFps;
    const elapsed = timestamp - lastFrameTime;
    if (elapsed >= interval) {
      const total = state.manifest.series[state.seriesIdx].slices;
      // Advance by however many whole intervals have elapsed so playback holds the
      // requested rate even when a redraw can't keep up at the display refresh —
      // N slices play in N/fps seconds (frames are dropped, not slowed). Resync on
      // a huge gap (e.g. a backgrounded tab) so it doesn't fire a catch-up storm.
      let steps = Math.floor(elapsed / interval);
      if (steps >= total) {
        lastFrameTime = timestamp;
        steps = 1;
      } else {
        lastFrameTime += steps * interval;
      }
      const next = (state.sliceIdx + steps) % total;
      stepSlice(next - state.sliceIdx);
    }
    state.cineTimer = requestAnimationFrame(loop);
  };
  state.cineTimer = requestAnimationFrame(loop);
}

export function stopCine() {
  if (state.cineTimer) {
    cancelAnimationFrame(state.cineTimer);
    state.cineTimer = null;
  }
  setPlayIcon(false);
  $('btn-play').classList.remove('active');
}

export function toggleCine() {
  if (state.cineTimer) stopCine();
  else startCine();
}
