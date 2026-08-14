// Structures panel: per-region TRI-STATE control, available in 2D + 3D. Each row
// cycles shown → solo → hidden → shown:
//   • shown  — visible (part of the scene unless something else is soloed)
//   • solo   — "show only this" === locked from a label (state.lockedLabels)
//   • hidden — never visible (state.hiddenLabels)
// Solo is additive: soloing several rows shows exactly those — the same set the
// label-lock produces, so the two surfaces stay in sync. State derives ONLY from
// hidden/locked (not transient hover-preview), so the list never flips on hover.
// Toggles route through setHiddenLabels / setLockedLabels; their subscriptions
// repaint 2D + 3D and re-render this list (single source of truth). No Three dep.

import { $ } from '../dom.js';
import { state } from '../core/state.js';
import { setHiddenLabels, setLockedLabels } from '../core/state/viewer-tool-commands.js';
import { signalPanelReady } from '../collapsible-sidebar.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NEXT = { shown: 'solo', solo: 'hidden', hidden: 'shown' };
const TIP = {
  shown: 'Visible · click to show only this',
  solo: 'Showing only this · click to hide',
  hidden: 'Hidden · click to show',
};

function svgNode(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function swatch(rgb) {
  // width/height attrs (not just CSS) so a stale/missing stylesheet can never
  // render the swatch full-size.
  const svg = svgNode('svg', { class: 'll-swatch', viewBox: '0 0 10 10', width: '10', height: '10', 'aria-hidden': 'true' });
  svg.appendChild(svgNode('circle', { cx: 5, cy: 5, r: 5, fill: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }));
  return svg;
}

// Shape-coded state glyph (monochrome): ✓ shown · ◉ solo · — hidden.
function stateGlyph(s) {
  // stroke/fill set as attrs (currentColor) so the glyph is correct even before
  // the stylesheet loads; CSS refines per-state colour.
  const svg = svgNode('svg', { class: 'structure-state', viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'aria-hidden': 'true' });
  if (s === 'shown') {
    svg.appendChild(svgNode('path', { d: 'M3.5 8.5 6.7 11.7 12.5 4.6', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  } else if (s === 'solo') {
    svg.appendChild(svgNode('circle', { cx: '8', cy: '8', r: '5.4', fill: 'none', 'stroke-width': '1.5' }));
    svg.appendChild(svgNode('circle', { cx: '8', cy: '8', r: '2.2', class: 'structure-state-dot', fill: 'currentColor', stroke: 'none' }));
  } else {
    svg.appendChild(svgNode('path', { d: 'M4 8 12 8', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  }
  return svg;
}

function stateFor(id) {
  if (state.hiddenLabels instanceof Set && state.hiddenLabels.has(id)) return 'hidden';
  if (state.lockedLabels instanceof Set && state.lockedLabels.has(id)) return 'solo';
  return 'shown';
}

// Apply only the set(s) that actually changed so each click triggers one repaint.
function cycle(id, current) {
  const next = NEXT[current] || 'shown';
  const hidden = new Set(state.hiddenLabels || []);
  const locked = new Set(state.lockedLabels || []);
  const hadHidden = hidden.has(id);
  const hadLocked = locked.has(id);
  hidden.delete(id);
  locked.delete(id);
  if (next === 'solo') locked.add(id);
  else if (next === 'hidden') hidden.add(id);
  if (locked.has(id) !== hadLocked) setLockedLabels(locked);
  if (hidden.has(id) !== hadHidden) setHiddenLabels(hidden);
}

function buildRow(entry, color, st) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'structure-row';
  row.dataset.lid = String(entry.id);
  row.dataset.state = st;
  row.setAttribute('data-tip', TIP[st]);
  row.setAttribute('aria-label', `${entry.name || 'structure'} — ${st}`);
  row.appendChild(swatch(color || [85, 85, 85]));

  const textWrap = document.createElement('span');
  textWrap.className = 'label-list-text';
  const name = document.createElement('span');
  name.className = 'label-list-name';
  name.textContent = entry.name || '';
  textWrap.appendChild(name);
  if (entry.mL != null && entry.mL !== '') {
    const meta = document.createElement('span');
    meta.className = 'label-list-meta';
    meta.textContent = ` · ${entry.mL} mL`;
    textWrap.appendChild(meta);
  }
  row.appendChild(textWrap);

  const ind = document.createElement('span');
  ind.className = 'structure-toggle';
  ind.appendChild(stateGlyph(st));
  row.appendChild(ind);

  row.addEventListener('click', () => cycle(entry.id, row.dataset.state));
  return row;
}

let _resetWired = false;
function wireResetOnce() {
  if (_resetWired) return;
  const btn = $('structures-reset');
  if (!btn) return;
  _resetWired = true;
  // Reset = show everything: clear both the solo/lock set and the hidden set.
  btn.addEventListener('click', () => {
    setLockedLabels(new Set());
    setHiddenLabels(new Set());
  });
}

export function renderStructuresPanel() {
  const panel = $('structures-panel');
  const host = $('label-list');
  if (!panel || !host) return;

  const regions = state.regionMeta?.regions;
  if (!regions) { panel.hidden = true; return; }
  panel.classList.remove('panel-init-hidden');
  panel.hidden = false;

  const colors = state.regionMeta.colors || {};
  const entries = Object.entries(regions)
    .map(([k, r]) => ({ id: +k, ...r }))
    .sort((a, b) => (b.mL || 0) - (a.mL || 0));

  host.replaceChildren(...entries.map((e) => buildRow(e, colors[e.id], stateFor(e.id))));
  // Reset only appears when there's actually a selection to clear.
  const hidden = state.hiddenLabels instanceof Set ? state.hiddenLabels : new Set();
  const locked = state.lockedLabels instanceof Set ? state.lockedLabels : new Set();
  const actions = $('structures-actions');
  if (actions) actions.hidden = hidden.size === 0 && locked.size === 0;
  wireResetOnce();
  signalPanelReady('structures');
}
