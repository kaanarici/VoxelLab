// Anatomy labels over the 2D slice. A screen-space SVG overlay (it does NOT
// take over the view — pan/zoom, slice number, and all chrome stay live): region
// callouts sit in two anti-collision columns at the viewport edges with leader
// lines to a dot on each structure. Anchors are the current slice's region
// centroids projected through the #view canvas's live rect, so the dots stay
// glued to structures as you pan, zoom, and scrub. Same visual language as 3D.

import { state } from '../core/state.js';
import { $ } from '../dom.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { regionsForSlice, invalidateRegionIndex } from './region-index.js';
import { layoutAtlasLabels } from './atlas-layout.js';
import { ROW_H } from './atlas-svg.js';
import { renderAtlasPills, clearAtlasPills } from './atlas-render.js';
import { anatomyBadge } from '../region-source.js';
import { volumeTip } from './label-inspect.js';
import { installSelectionUI, teardownSelectionUI } from './atlas-selection-ui.js';

const PAD = 16;
const COL_GAP = 18;
const COL_W_FRAC = 0.16;
const COL_W_MIN = 120;
const COL_W_MAX = 200;
const MAX_VISIBLE = 36;

let _enabled = false;
let _raf = 0;
let _sig = '';

function hiddenSig(hidden) {
  return hidden && hidden.size ? [...hidden].sort((a, b) => a - b).join(',') : '';
}

function render() {
  const svg = $('atlas2d-svg');
  if (!svg) return;
  if (state.mode !== '2d') { clearAtlasPills(svg); _sig = ''; return; }
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) { clearAtlasPills(svg); _sig = ''; return; }
  const overlays = activeOverlayStateForSeries(series);
  const labels = overlays.labels;
  // Independent of the colour overlay (labels.enabled): only the region data
  // (available + meta) is required, so labels can show without Anatomy colour.
  if (!labels.available || !labels.meta) { clearAtlasPills(svg); _sig = ''; return; }

  const canvas = $('view');
  const wrap = $('canvas-wrap');
  if (!canvas || !wrap) return;
  const cr = canvas.getBoundingClientRect(); // bakes in pan/zoom
  const wr = wrap.getBoundingClientRect();
  const w = Math.round(wr.width);
  const h = Math.round(wr.height);
  if (w < 2 || h < 2 || cr.width < 2 || cr.height < 2) return;

  const ox = cr.left - wr.left;
  const oy = cr.top - wr.top;
  // Labels only ever HIDE for the user's manual hidden set (legend checkboxes).
  // Isolation (hover/lock) FADES non-active pills instead of removing them, so
  // every label stays visible + clickable for multi-select and the column never
  // re-packs (no jitter); only the model's COLOUR isolates (region-color-isolation).
  const manualHidden = state.hiddenLabels instanceof Set ? state.hiddenLabels : new Set();
  const locked = state.lockedLabels instanceof Set ? state.lockedLabels : new Set();
  // NOTE: previewLabel (hover) is deliberately NOT in the signature — hover
  // fade + lock reveal are pure CSS, so the pills must NOT rebuild on hover
  // (rebuilding would kill the transitions). Hover still drives model isolation
  // via state.previewLabel through the sync redraw path.
  const sig = `${state.sliceIdx}|${Math.round(ox)},${Math.round(oy)},${Math.round(cr.width)},${Math.round(cr.height)}|${w}x${h}|${hiddenSig(manualHidden)}|${hiddenSig(locked)}`;
  if (sig === _sig && svg.childNodes.length) return;
  _sig = sig;

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  // When something is locked, show ONLY the locked structures' labels — the rest
  // would just float pointing at hidden geometry. Otherwise show all (minus the
  // user's manual hidden set); hover-fade is pure CSS.
  const show = (label) => (locked.size > 0 ? locked.has(label) : !manualHidden.has(label));
  const regions = regionsForSlice(series, state.sliceIdx).filter((r) => show(r.label));
  if (!regions.length) { clearAtlasPills(svg); _sig = ''; return; } // re-check next frame until loaded

  const W = series.width;
  const H = series.height;
  const visible = [];
  for (const r of regions) {
    const ax = ox + (r.cx / W) * cr.width;
    const ay = oy + (r.cy / H) * cr.height;
    if (ax < -24 || ax > w + 24 || ay < -24 || ay > h + 24) continue; // off-screen when zoomed in
    visible.push({ label: r.label, name: r.name, color: r.color, areaPx: r.areaPx, anchorX: ax, anchorY: ay });
  }
  if (visible.length > MAX_VISIBLE) {
    visible.sort((p, q) => q.areaPx - p.areaPx);
    visible.length = MAX_VISIBLE;
  }

  let colW = Math.min(COL_W_MAX, Math.max(COL_W_MIN, w * COL_W_FRAC));
  colW = Math.max(80, Math.min(colW, (w - 2 * PAD - 2 * COL_GAP - 120) / 2));
  const placed = layoutAtlasLabels({
    items: visible,
    bounds: { top: PAD, bottom: h - PAD },
    centerX: w / 2,
    rowH: ROW_H,
  });
  // Aligned columns sit just outside the actual image (cr), not at the screen
  // edge, so labels stay close to it. Outer edges line up; inner edges hug it.
  const outerL = Math.max(PAD, ox - COL_GAP - colW);
  const outerR = Math.min(w - PAD, ox + cr.width + COL_GAP + colW);

  const items = placed.map((it) => ({
    label: it.label,
    name: it.name,
    color: it.color,
    side: it.side,
    pillOuterX: it.side === 'left' ? outerL : outerR,
    anchorX: it.anchorX,
    anchorY: it.anchorY,
    pillCenterY: it.y,
    colW,
    locked: locked.has(it.label),
    tip: volumeTip(series, state.regionMeta, it.label),
  }));
  renderAtlasPills(svg, items, items.length ? anatomyBadge(series) : '', w, h);
}

function frame() {
  _raf = 0;
  if (!_enabled) return;
  render();
  _raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 33))(frame);
}

export function setAtlas2DActive(on) {
  if (on === _enabled) return;
  _enabled = on;
  $('canvas-wrap')?.classList.toggle('atlas2d', on);
  const svg = $('atlas2d-svg');
  if (on) {
    _sig = '';
    if (svg) installSelectionUI(svg, { is3d: false });
    if (!_raf) _raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 33))(frame);
  } else {
    if (_raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_raf);
    _raf = 0;
    if (svg) { teardownSelectionUI(svg); clearAtlasPills(svg); }
  }
}

/** Drop cached regions + force a re-render (e.g. when the region volume/meta loads). */
export function invalidateAtlas2D() {
  _sig = '';
  invalidateRegionIndex();
}
