// Custom reactive markers + magnetic detents for the main slice scrubber.
//
// The native <input type=range> stays the interaction + accessibility backbone
// (keyboard stepping, focus, value/max sync). This module layers finding /
// microbleed markers ON TOP of the track and gives a pointer drag a magnetic
// "catch" at flagged slices, so reviewers land exactly on the slices the
// analysis flagged instead of scrubbing past them.
import { $ } from './dom.js';

// All thresholds are in CSS pixels along the track, converted to slice units per
// drag so the feel is identical whether a series has 30 slices or 300.
const CATCH_PX = 7;     // pointer distance at which a marker grabs the thumb
const RELEASE_PX = 12;  // must pull this far past a caught marker to break free (hysteresis = the "stuck" feel)
const ACTIVE_PX = 18;   // marker lights up when the thumb is this close
const UNDER_PX = 9;     // thumb is sitting on the marker — fade it so the knob absorbs it
const HOVER_PX = 8;     // cursor proximity that lights a marker on hover

const SEV_COLOR = {
  attention: 'var(--color-attention)',
  abnormal: 'var(--color-abnormal)',
  microbleed: 'var(--color-microbleed)',
};

let markers = [];          // [{ slice, severity, el }]
const geom = { width: 0, max: 0 };
let dragging = false;
let stuck = null;          // slice index the thumb is currently caught on
let hoverEl = null;

const scrubEl = () => $('scrub');

function refreshGeom() {
  const scrub = scrubEl();
  if (!scrub) return;
  geom.width = scrub.getBoundingClientRect().width;
  geom.max = +scrub.max || 0;
}

// Called by renderScrubTicks after it rebuilds the marker DOM.
export function setScrubMarkers(list) {
  markers = Array.isArray(list) ? list : [];
  stuck = null;
  hoverEl = null;
  refreshGeom();
}

function writeValue(v) {
  const scrub = scrubEl();
  if (scrub && +scrub.value !== v) scrub.value = String(v);
}

// Transform the raw slider value mid-drag so the thumb catches on markers.
// No-op for keyboard / cine (dragging === false) so single-slice stepping is
// never blocked by a detent.
export function magnetizeSliceValue(raw) {
  if (!dragging || markers.length === 0) { stuck = null; return raw; }
  if (geom.width === 0) refreshGeom();
  const slicesPerPx = geom.max > 0 && geom.width > 0 ? geom.max / geom.width : 0;
  if (slicesPerPx === 0) return raw;
  const catchR = CATCH_PX * slicesPerPx;
  const releaseR = RELEASE_PX * slicesPerPx;

  if (stuck != null) {
    if (Math.abs(raw - stuck) <= releaseR) { writeValue(stuck); return stuck; }
    stuck = null;
  }
  let best = null;
  let bestD = Infinity;
  for (const m of markers) {
    const d = Math.abs(raw - m.slice);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (best && bestD <= catchR) { stuck = best.slice; writeValue(stuck); return stuck; }
  return raw;
}

// Light the marker under/near the thumb and tint the knob when parked on one.
// Driven from syncSliceUI, so it tracks drag, keyboard, and cine alike.
export function updateScrubMarkers(currentSlice) {
  const scrub = scrubEl();
  if (markers.length === 0) { scrub?.classList.remove('scrub--on-marker'); return; }
  if (geom.width === 0 || geom.max === 0) refreshGeom();
  const pxPer = geom.max > 0 && geom.width > 0 ? geom.width / geom.max : 0;

  let onMarker = null;
  for (const m of markers) {
    const dPx = pxPer ? Math.abs(m.slice - currentSlice) * pxPer
      : (m.slice === currentSlice ? 0 : Infinity);
    const under = dPx < UNDER_PX;
    m.el.classList.toggle('under-thumb', under);
    m.el.classList.toggle('active', !under && dPx < ACTIVE_PX);
    m.el.classList.toggle('passed', m.slice <= currentSlice);
    if (m.slice === currentSlice) onMarker = m;
  }

  if (!scrub) return;
  if (onMarker) {
    scrub.style.setProperty('--knob-accent', SEV_COLOR[onMarker.severity] || 'var(--text)');
    scrub.classList.add('scrub--on-marker');
  } else {
    scrub.classList.remove('scrub--on-marker');
  }
}

function clearHover() {
  if (hoverEl) { hoverEl.classList.remove('hover'); hoverEl = null; }
}

// Light the nearest marker to the cursor while hovering the track (not dragging).
function onScrubberMove(e) {
  if (dragging || markers.length === 0) return;
  const scrub = scrubEl();
  if (!scrub) return;
  const r = scrub.getBoundingClientRect();
  const max = +scrub.max || 0;
  if (r.width === 0 || max === 0) return;
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const at = frac * max;
  const pxPer = r.width / max;

  let best = null;
  let bestD = Infinity;
  for (const m of markers) {
    const d = Math.abs(m.slice - at);
    if (d < bestD) { bestD = d; best = m; }
  }
  const near = best && bestD * pxPer <= HOVER_PX ? best.el : null;
  if (near !== hoverEl) {
    clearHover();
    if (near) { near.classList.add('hover'); hoverEl = near; }
  }
}

export function initScrubberMarkers() {
  const scrub = scrubEl();
  if (!scrub) return;
  const scrubber = scrub.closest('.scrubber') || scrub.parentElement;

  scrub.addEventListener('pointerdown', () => { dragging = true; stuck = null; refreshGeom(); });
  const endDrag = () => { if (dragging) { dragging = false; stuck = null; } };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  if (scrubber) {
    scrubber.addEventListener('pointermove', onScrubberMove);
    scrubber.addEventListener('pointerleave', clearHover);
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refreshGeom).observe(scrub);
  }
  window.addEventListener('resize', refreshGeom);
  refreshGeom();
}
