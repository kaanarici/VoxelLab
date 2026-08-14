// Viewport utilities: orientation markers, invert toggle, zoom-to-fit,
// and MR window/level presets. Pure DOM/CSS operations — no Three.js,
// no canvas pixel manipulation.

import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { MR_PRESETS } from '../core/constants.js';
import { DEFAULT_IOP, geometryFromSeries, inPlaneDisplaySize } from '../core/geometry.js';
import { viewPresetAnatomy, NEUTRAL_VIEW_LABELS } from '../core/view-orientation.js';
import { updateScaleBar } from '../overlay/scale-bar.js';
import { setFitZoom, setWindowLevel, setVolumeTransfer } from '../core/state/viewer-commands.js';

// L/R/A/P/S/I corner labels from ImageOrientationPatient (2D mode).

const DIRS = { L: 'L', R: 'R', A: 'A', P: 'P', S: 'S', I: 'I' };
const OPPOSITE = { L: 'R', R: 'L', A: 'P', P: 'A', S: 'I', I: 'S' };

const UI_FADE = 'ui-fade-in';

let _last2dOrientSig = '';
let _lastMprOrientSig = '';

/** Same 0.38s fade as studies rail / skeletons; skips when reduced-motion is set. */
function restartOrientationFade(elements) {
  const list = elements.filter(Boolean);
  if (!list.length) return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of list) el.classList.remove(UI_FADE);
  void list[0].offsetWidth;
  requestAnimationFrame(() => {
    for (const el of list) el.classList.add(UI_FADE);
  });
}

function majorAxis(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? DIRS.L : DIRS.R;  // +X LPS = Left
  if (ay >= ax && ay >= az) return y > 0 ? DIRS.P : DIRS.A;  // +Y LPS = Posterior
  return z > 0 ? DIRS.S : DIRS.I;                              // +Z LPS = Superior
}

/** @param {object} [series] — when omitted, uses manifest series at `state.seriesIdx`. */
export function updateOrientationMarkers(series) {
  const els = {
    left:   $('orient-left'),
    right:  $('orient-right'),
    top:    $('orient-top'),
    bottom: $('orient-bottom'),
  };
  if (!els.left) return;

  const s = series ?? state.manifest?.series?.[state.seriesIdx];
  // Only label sides when the series has a REAL patient frame. Microscopy,
  // secondary captures and plain image stacks have no patient orientation (some
  // are assigned an identity IOP at import), so labeling them L/R/A/P would be
  // false precision — clear the markers instead of guessing.
  const hasPatientFrame = !!s
    && s.orientation?.length >= 6
    && s.imageDomain !== 'microscopy';
  if (!hasPatientFrame) {
    _last2dOrientSig = '';
    for (const el of Object.values(els)) {
      el.textContent = '';
      el.classList.remove(UI_FADE);
    }
    return;
  }
  const [r0, r1, r2, c0, c1, c2] = s.orientation;

  // Row direction (IOP first triplet) = direction of increasing column index
  // → points toward the RIGHT side of the displayed image.
  const rightLabel = majorAxis(r0, r1, r2);
  const leftLabel  = OPPOSITE[rightLabel];

  // Column direction (IOP second triplet) = direction of increasing row index
  // → points toward the BOTTOM of the displayed image.
  const bottomLabel = majorAxis(c0, c1, c2);
  const topLabel    = OPPOSITE[bottomLabel];

  const sig = `${leftLabel}|${rightLabel}|${topLabel}|${bottomLabel}`;
  if (sig === _last2dOrientSig) return;
  _last2dOrientSig = sig;

  els.left.textContent   = leftLabel;
  els.right.textContent  = rightLabel;
  els.top.textContent    = topLabel;
  els.bottom.textContent = bottomLabel;
  restartOrientationFade([els.left, els.right, els.top, els.bottom]);
}

/**
 * Relabel the 3D view-preset buttons (Top/Front/L/R/…) with the anatomy each
 * camera direction actually reveals for THIS series, so non-axial / flipped
 * acquisitions don't get a confident wrong-side label. Neutral view-axis labels
 * when the series has no patient frame.
 */
export function updateThreeDViewLabels(series) {
  const labels = viewPresetAnatomy(series) || NEUTRAL_VIEW_LABELS;
  for (const view in labels) {
    const btn = document.querySelector(`.preset-btn[data-view="${view}"]`);
    if (!btn) continue;
    btn.textContent = labels[view].short;
    btn.dataset.tip = labels[view].tip;
  }
}

/** Per-MPR-pane L/R/A/P/S/I markers (2D markers are hidden in MPR mode). */
export function updateMprOrientationMarkers(series) {
  if (!series) return;
  const iop = series.orientation?.length >= 6 ? series.orientation : DEFAULT_IOP;
  const [r0, r1, r2, c0, c1, c2] = iop;
  const geo = geometryFromSeries(series);
  const sd = geo.sliceDir;

  const right2d = majorAxis(r0, r1, r2);
  const bottom2d = majorAxis(c0, c1, c2);
  const top2d = OPPOSITE[bottom2d];
  const left2d = OPPOSITE[right2d];

  const coR = right2d;
  const coT = majorAxis(sd[0], sd[1], sd[2]);
  const saR = majorAxis(c0, c1, c2);
  const saT = coT;

  const cells = [
    ['mpr-ax', left2d, right2d, top2d, bottom2d],
    ['mpr-co', OPPOSITE[coR], coR, coT, OPPOSITE[coT]],
    ['mpr-sa', OPPOSITE[saR], saR, saT, OPPOSITE[saT]],
  ];
  const sig = cells.map(([, L, R, T, B]) => [L, R, T, B].join('')).join('|');
  if (sig === _lastMprOrientSig) return;
  _lastMprOrientSig = sig;

  const fadeEls = [];
  for (const [prefix, L, R, T, B] of cells) {
    const ol = $(`${prefix}-ol`);
    const or = $(`${prefix}-or`);
    const ot = $(`${prefix}-ot`);
    const ob = $(`${prefix}-ob`);
    if (ol) {
      ol.textContent = L;
      fadeEls.push(ol);
    }
    if (or) {
      or.textContent = R;
      fadeEls.push(or);
    }
    if (ot) {
      ot.textContent = T;
      fadeEls.push(ot);
    }
    if (ob) {
      ob.textContent = B;
      fadeEls.push(ob);
    }
  }
  restartOrientationFade(fadeEls);
}

export function toggleInvert() {
  state.invertDisplay = !state.invertDisplay;
  const btn = $('btn-invert');
  if (btn) btn.classList.toggle('active', state.invertDisplay);
  return state.invertDisplay;
}
export function isInverted() { return !!state.invertDisplay; }

// Fit canvas pixels inside the stage (ignores CSS scale; uses canvas width/height).
export function zoomToFit() {
  const canvas = $('view');
  const stage = $('view-stage');
  const xf = $('view-xform');
  if (!canvas || !stage || !xf) return;

  const imgW = canvas.width;
  const imgH = canvas.height;
  if (imgW <= 0 || imgH <= 0) return;
  const series = state.manifest?.series?.[state.seriesIdx];
  const displaySize = series ? inPlaneDisplaySize(series) : { width: imgW, height: imgH };

  const stageR = stage.getBoundingClientRect();
  const padX = Math.max(40, stageR.width * 0.1);
  const padY = Math.max(40, stageR.height * 0.1);
  const availW = stageR.width - padX * 2;
  const availH = stageR.height - padY * 2;
  if (availW <= 0 || availH <= 0) return;

  const scale = Math.min(availW / displaySize.width, availH / displaySize.height);
  const next = setFitZoom(scale);

  xf.style.setProperty('--zoom', String(next.zoom));
  xf.style.setProperty('--tx', '0px');
  xf.style.setProperty('--ty', '0px');
  const badge = $('zoom-badge');
  if (badge) {
    badge.textContent = next.zoom.toFixed(2) + 'x';
    badge.classList.toggle('visible', Math.abs(next.zoom - 1) > 0.01);
  }
  updateScaleBar();
}

export function applyMRPreset(name) {
  const p = MR_PRESETS[name];
  if (!p) return;
  setWindowLevel(p.window, p.level);
  setVolumeTransfer({
    lowT: Math.max(0, (p.level - p.window / 2) / 255),
    highT: Math.min(1, (p.level + p.window / 2) / 255),
  });
}
