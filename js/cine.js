import { $ } from './dom.js';
import { state } from './core/state.js';
import { stepSlice } from './core/state/viewer-commands.js';

let cineTimer = null;

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
  if (cineTimer) return;
  setPlayIcon(true);
  $('btn-play').classList.add('active');
  let lastFrameTime = 0;
  const loop = (timestamp) => {
    if (!cineTimer) return;
    if (!lastFrameTime) lastFrameTime = timestamp;
    const interval = 1000 / state.cineFps;
    const elapsed = timestamp - lastFrameTime;
    if (elapsed >= interval) {
      const total = state.manifest.series[state.seriesIdx].slices;

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
    cineTimer = requestAnimationFrame(loop);
  };
  cineTimer = requestAnimationFrame(loop);
}

export function stopCine() {
  if (cineTimer) {
    cancelAnimationFrame(cineTimer);
    cineTimer = null;
  }
  setPlayIcon(false);
  $('btn-play').classList.remove('active');
}

export function isCinePlaying() {
  return cineTimer != null;
}

export function toggleCine() {
  if (cineTimer) stopCine();
  else startCine();
}
