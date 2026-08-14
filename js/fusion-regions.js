// Fusion overlay peer picker + anatomical region legend (right sidebar).
import { state } from './core/state.js';
import { $, escapeHtml, colorSwatchSvg } from './dom.js';
import { getGroupPeers } from './series/compare.js';
import { enhanceSelectLikeDropdowns } from './select-like-dropdown.js';
import { anatomyDisclaimer } from './region-source.js';

export function renderFusionPicker() {
  const panel = $('fusion-panel');
  const sel = $('fusion-select');
  if (!panel || !sel) return;
  const peers = getGroupPeers().filter(
    (p) => p.slug !== state.manifest.series[state.seriesIdx].slug,
  );
  if (peers.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.classList.remove('panel-init-hidden');
  panel.hidden = false;
  sel.innerHTML = `<option value="">None</option>`
    + peers.map((p) => `<option value="${p.slug}" ${p.slug === state.fusionSlug ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  enhanceSelectLikeDropdowns(panel);
}

export function renderRegionLegend() {
  const panel = $('regions-panel');
  const host = $('regions-legend');
  if (!panel || !host) return;
  if (!state.regionMeta || !state.regionMeta.regions) {
    panel.hidden = true;
    return;
  }
  panel.classList.remove('panel-init-hidden');
  panel.hidden = false;
  const rs = state.regionMeta.regions;
  const rows = Object.entries(rs)
    .filter(([, r]) => r.mL >= 0.1)
    .sort((a, b) => (b[1].mL || 0) - (a[1].mL || 0))
    .map(([, r]) => {
      return `
        <div class="legend-row">
          ${colorSwatchSvg('swatch', r.color)}
          <span class="lk">${escapeHtml(r.name)}</span>
          <span class="lv">${r.mL.toFixed(1)} mL</span>
        </div>
      `;
    }).join('');
  const series = state.manifest?.series?.[state.seriesIdx];
  const legendDisclaimer = `
    <div class="info-line">${escapeHtml(anatomyDisclaimer(series))}</div>
  `;
  if (!rows) {
    host.innerHTML = `
      <p class="rp-empty-minimal" role="status">No regions above the display threshold.</p>
      ${legendDisclaimer}`;
    return;
  }
  host.innerHTML = rows + legendDisclaimer;
}
