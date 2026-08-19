// Compare mode — renders every series in the same DICOM registration
// group side-by-side at the shared slice index.
//
// Compare cells still render peer-specific overlays, but primary-series
// changes now flow through the canonical selectSeries() path so cache
// resets and redraw state stay consistent.

import { $, escapeHtml } from '../dom.js';
import { deletePassthroughRootEntry, setPassthroughRootEntry, state } from '../core/state.js';
import { drawAnnotationPins } from '../overlay/annotation.js';
import { cachedFetchJson } from '../cached-fetch.js';
import {
  closestSliceIndexForPatientPoint,
  inPlaneDisplaySize,
  inPlanePixelSpacing,
  patientPointAtSlice,
  seriesCompareGroup,
} from '../core/geometry.js';
import { readImageByteData } from '../overlay/overlay-data.js';
import { COLORMAPS, getFusedWLLut, getFusedWLU32 } from '../colormap.js';
import { softFail } from '../core/error.js';
import { renderInspectionReadout, resolveVoxelInspection } from '../inspection-readout.js';
import { drawCompositeSlice } from '../slice-compositor.js';
import { getRegistrationRecord } from '../metadata.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_KIND, overlayBytesFromCaches, overlayBytesPresent } from '../runtime/overlay-cache-keys.js';
import { selectionRegionColors } from '../runtime/region-color-isolation.js';
import { overlaySessionForSeries } from '../runtime/review-readiness.js';
import { resetCompareViewport, setComparePeers, setCompareViewport, setWindowLevel } from '../core/state/viewer-commands.js';
import { setSpinnerPending } from '../spinner.js';
import { loadImageStack, regionMetaUrlForSeries } from './series-image-stack.js';

let _selectSeries = () => {};
let _step = () => {};
let _hideHover = () => {};
const SLICE_WINDOW_RADIUS = 5;
let _comparePendingToken = 0;
let _comparePendingKey = '';
let _comparePendingPromise = null;

// Shape: { "series_slug": { seg: Image[], sym: Image[], regions: Image[], regionMeta: object|null } }.
const peerOverlays = {};

function compareViewport() {
  return state.compare?.viewport || { zoom: 1, tx: 0, ty: 0 };
}

function applyCompareViewport(host = $('cmp-grid')) {
  const view = compareViewport();
  host?.querySelectorAll?.('.cmp-cell canvas').forEach((canvas) => {
    canvas.style.transformOrigin = '50% 50%';
    canvas.style.transform = `translate(${view.tx || 0}px, ${view.ty || 0}px) scale(${view.zoom || 1})`;
  });
  host?.classList?.toggle?.('pannable', (view.zoom || 1) > 1.01);
}

function showCompareHover(cell, clientX, clientY) {
  const slug = cell?.dataset?.slug || '';
  const series = state.manifest.series.find((entry) => entry.slug === slug);
  if (!series) { _hideHover(); return; }
  const primary = state.manifest.series[state.seriesIdx];
  const match = matchPeerSlice(series, primary, state.sliceIdx, compareUsesIndexSync(getGroupPeers(), primary));
  if (match.outOfRange) { _hideHover(); return; }
  const stack = state.cmpStacks[slug];
  const zi = match.index;
  const img = stack?.[zi];
  if (!img?.complete || img.naturalWidth === 0) { _hideHover(); return; }
  const canvas = cell.querySelector('canvas');
  const rect = canvas?.getBoundingClientRect?.();
  if (!canvas || !rect) { _hideHover(); return; }
  const vx = Math.floor((clientX - rect.left) / rect.width * canvas.width);
  const vy = Math.floor((clientY - rect.top) / rect.height * canvas.height);
  if (vx < 0 || vx >= series.width || vy < 0 || vy >= series.height) { _hideHover(); return; }

  const baseBytes = readImageByteData(img, series.width, series.height);
  if (!baseBytes) { _hideHover(); return; }
  const po = peerOverlays[slug] || {};
  const overlays = activeOverlayStateForSeries(series);
  const segLabel = overlays.tissue.enabled && po.seg?.[zi]?.complete
    ? readImageByteData(po.seg[zi], series.width, series.height)?.[vy * series.width + vx] ?? null
    : null;
  const regionLabel = overlays.labels.enabled && po.regions?.[zi]?.complete
    ? readImageByteData(po.regions[zi], series.width, series.height)?.[vy * series.width + vx] ?? null
    : null;
  const inspection = resolveVoxelInspection(series, vx, vy, zi, {
    intensity: baseBytes[vy * series.width + vx],
    tissueLabel: segLabel,
    regionLabel,
    regionMeta: po.regionMeta || null,
    useLiveOverlays: false,
  });

  const hov = $('hover-readout');
  hov.innerHTML = renderInspectionReadout(inspection, { coordLabel: 'px', includeSlice: true });
  hov.classList.add('visible');
  const wrap = $('canvas-wrap').getBoundingClientRect();
  let x = clientX - wrap.left + 14;
  let y = clientY - wrap.top + 14;
  const hw = hov.offsetWidth;
  const hh = hov.offsetHeight;
  if (x + hw > wrap.width - 8) x = clientX - wrap.left - hw - 10;
  if (y + hh > wrap.height - 8) y = clientY - wrap.top - hh - 10;
  hov.style.left = `${x}px`;
  hov.style.top = `${y}px`;
}

function wireCompareInteractions() {
  const host = $('cmp-grid');
  if (!host || host._compareWired) return;
  host._compareWired = true;
  let dragging = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let pendingWindow = state.window;
  let pendingLevel = state.level;
  let wlFramePending = false;

  host.addEventListener('wheel', (e) => {
    if (state.mode !== 'cmp') return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const view = compareViewport();
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const oldZoom = view.zoom || 1;
      const newZoom = Math.max(1, Math.min(8, oldZoom * factor));
      if (newZoom === oldZoom) return;
      setCompareViewport({
        zoom: newZoom,
        tx: cx - (cx - (view.tx || 0)) * (newZoom / oldZoom),
        ty: cy - (cy - (view.ty || 0)) * (newZoom / oldZoom),
      });
      applyCompareViewport(host);
      return;
    }
    _step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  host.addEventListener('mousedown', (e) => {
    if (state.mode !== 'cmp') return;
    lastX = e.clientX;
    lastY = e.clientY;
    const view = compareViewport();
    // Pan only when zoomed in — at 1x the image fits, so a drag (or accidental
    // cmd-drag) would just shove it off-centre and "lose" it. At 1x, drag = W/L.
    const wantsPan = (view.zoom || 1) > 1.01;
    if (wantsPan) {
      panning = true;
      host.classList.add('panning');
      e.preventDefault();
      return;
    }
    pendingWindow = state.window;
    pendingLevel = state.level;
    dragging = true;
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    if (panning) {
      panning = false;
      host.classList.remove('panning');
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.mode !== 'cmp') return;
    if (dragging) {
      pendingWindow = Math.max(1, Math.min(512, pendingWindow + (e.clientX - lastX)));
      pendingLevel = Math.max(0, Math.min(255, pendingLevel - (e.clientY - lastY)));
      lastX = e.clientX;
      lastY = e.clientY;
      if (!wlFramePending) {
        wlFramePending = true;
        requestAnimationFrame(() => {
          wlFramePending = false;
          setWindowLevel(pendingWindow, pendingLevel);
        });
      }
    } else if (panning) {
      const view = compareViewport();
      setCompareViewport({
        zoom: view.zoom,
        tx: (view.tx || 0) + (e.clientX - lastX),
        ty: (view.ty || 0) + (e.clientY - lastY),
      });
      lastX = e.clientX;
      lastY = e.clientY;
      applyCompareViewport(host);
    }
  });

  host.addEventListener('dblclick', () => {
    resetCompareViewport();
    applyCompareViewport(host);
    _hideHover();
  });
  host.addEventListener('mousemove', (e) => {
    if (state.mode !== 'cmp' || dragging || panning) {
      _hideHover();
      return;
    }
    const cell = e.target?.closest?.('.cmp-cell');
    if (!cell) {
      _hideHover();
      return;
    }
    showCompareHover(cell, e.clientX, e.clientY);
  });
  host.addEventListener('mouseleave', () => _hideHover());
}

export function trimCompareCaches(keepSlugs = []) {
  const keep = new Set(keepSlugs);
  for (const slug of Object.keys(state.cmpStacks)) {
    if (!keep.has(slug)) deletePassthroughRootEntry('cmpStacks', slug);
  }
  for (const slug of Object.keys(peerOverlays)) {
    if (!keep.has(slug)) delete peerOverlays[slug];
  }
}

export function initCompare({ selectSeries, step = () => {}, hideHover = () => {} }) {
  if (selectSeries instanceof Function) _selectSeries = selectSeries;
  if (step instanceof Function) _step = step;
  if (hideHover instanceof Function) _hideHover = hideHover;
  wireCompareInteractions();
}

function compareSpinner(pending, token = _comparePendingToken) {
  if (token !== _comparePendingToken) return;
  // Keep the scrubber live while peers stream in — locking it is a big part of
  // "the scrubber doesn't help you". The pending spinner is feedback enough.
  setSpinnerPending('compare', !!pending);
}

function resolvedGroupKey(series) {
  const g = resolvedCompareGroup(series);
  return g == null ? null : g;
}

// One matching mode for the WHOLE compare session, decided by geometry — never a
// per-pane mix (which would show some panes anatomically aligned and others not).
//   ALIGNED (patient space): the set is homogeneously co-registered with the primary,
//     so slice N is the same anatomy in every pane; a pane that does not cover that
//     location stays honestly blank ("no aligned slice"), never the wrong anatomy.
//   INDEX-SYNCED: any pane is not co-registered, so there is no shared anatomy — scroll
//     every stack together by proportional index (the Fiji "synchronize windows" model).
//     Never "out of range": scrubbing always shows a slice.
export function compareUsesIndexSync(peers, primary) {
  const pg = resolvedGroupKey(primary);
  if (pg == null) return true;
  return peers.some((peer) => resolvedGroupKey(peer) !== pg);
}

function matchPeerSlice(peer, primary, z, indexSync) {
  if (!peer || !primary) return { index: 0, outOfRange: true, distanceMm: Infinity, toleranceMm: 0 };
  if (peer.slug === primary.slug) return { index: z, outOfRange: false, distanceMm: 0, toleranceMm: 0 };
  if (indexSync) {
    const primarySlices = Math.max(1, Number(primary.slices) || 1);
    const peerSlices = Math.max(1, Number(peer.slices) || 1);
    const idx = primarySlices > 1
      ? Math.round((z / (primarySlices - 1)) * (peerSlices - 1))
      : Math.min(z, peerSlices - 1);
    return { index: Math.max(0, Math.min(idx, peerSlices - 1)), outOfRange: false, distanceMm: 0, toleranceMm: 0 };
  }
  return closestSliceIndexForPatientPoint(peer, patientPointAtSlice(primary, z));
}

// Shape: { "peer_slug": { index: 17, outOfRange: false, distanceMm: 0.2, toleranceMm: 0.5 } }.
function compareSliceMatches(peers, primarySeries, z) {
  const indexSync = compareUsesIndexSync(peers, primarySeries);
  return Object.fromEntries(peers.map((peer) => [peer.slug, matchPeerSlice(peer, primarySeries, z, indexSync)]));
}

function comparePendingKey(peers, z, matches = {}) {
  return [
    z,
    state.overlays.useBrain ? 'brain' : 'base',
    ...Object.values(OVERLAY_CACHE_BY_KIND)
      .filter((cache) => !cache.refuseInOverlayStack)
      .map((cache) => (state.overlays[cache.kind] ? cache.type : '')),
    ...Object.values(OVERLAY_CACHE_BY_KIND)
      .filter((cache) => cache.peerSlugField)
      .map((cache) => state.overlays[cache.peerSlugField] || ''),
    state.manifest.series[state.seriesIdx]?.slug || '',
    ...peers.map((peer) => {
      const match = matches[peer.slug];
      return `${peer.slug}:${match?.index ?? 0}:${match?.outOfRange ? 'x' : ''}`;
    }),
  ].join('|');
}

function registrationQualityForPair(series, primary) {
  const record = getRegistrationRecord(series?.slug);
  const reference = String(record?.referenceSlug || '').trim();
  const primaryIds = [primary?.slug, primary?.sourceSeriesUID, primary?.seriesInstanceUID]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return reference && primaryIds.includes(reference) ? record.quality : null;
}

function registrationLabel(series, primary, indexSync) {
  if (!series) return '';
  const parts = [series.name];
  if (!inPlanePixelSpacing(series).known) parts.push('uncalibrated');
  if (series.slug === primary?.slug) return parts.join(' · ');
  if (indexSync) parts.push('index sync', 'not registered');
  const quality = registrationQualityForPair(series, primary);
  if (!quality) return parts.join(' · ');
  if (quality.verdict) parts.push(quality.verdict);
  else if (quality.grade && quality.grade !== 'unknown') parts.push(quality.grade);
  if (Number.isFinite(quality.mm)) parts.push(`${quality.mm.toFixed(quality.mm >= 10 ? 1 : 2)} mm`);
  return parts.join(' · ');
}

function compareSeriesDetail(series) {
  const spacing = inPlanePixelSpacing(series);
  const matrix = `${series.width || '?'} × ${series.height || '?'}`;
  const calibration = spacing.known
    ? `${spacing.rowMm.toFixed(2)} × ${spacing.colMm.toFixed(2)} mm/px`
    : 'spacing unknown';
  return [series.description || series.sourceFolder || '', matrix, calibration].filter(Boolean).join(' · ');
}

function sharedCompareMmScale(cells) {
  let scale = Infinity;
  let calibrated = 0;
  for (const cell of cells) {
    const series = state.manifest.series.find((entry) => entry.slug === cell.dataset.slug);
    const spacing = inPlanePixelSpacing(series);
    if (!series || !spacing.known) continue;
    const width = Number(cell.clientWidth);
    const height = Number(cell.clientHeight);
    if (!(width > 0 && height > 0)) return null;
    scale = Math.min(
      scale,
      width / (series.width * spacing.colMm),
      height / (series.height * spacing.rowMm),
    );
    calibrated += 1;
  }
  return calibrated > 0 && Number.isFinite(scale) && scale > 0 ? scale : null;
}

function comparePeerOverlayStack(cache, po, slug, primarySlug, overlays) {
  if (cache.peerSlugField) {
    const overlay = overlays[cache.kind];
    return slug === primarySlug && overlay.enabled
      ? (state.cmpStacks[state.overlays[cache.peerSlugField]] || overlay.imgs)
      : null;
  }
  return po[cache.type];
}

function ensureCompareCurrentSlice(peers, z, primarySlug, matches = {}) {
  const tasks = [];
  for (const series of peers) {
    const match = matches[series.slug];
    if (match?.outOfRange) continue;
    const zi = match?.index ?? Math.min(z, series.slices - 1);
    const overlays = activeOverlayStateForSeries(series);
    const po = peerOverlays[series.slug] || {};
    const stacks = {};
    for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
      stacks[cache.kind] = comparePeerOverlayStack(cache, po, series.slug, primarySlug, overlays);
    }
    const overlaySession = overlaySessionForSeries(series, {
      sliceIdx: zi,
      overlays,
      stacks,
    });
    const stack = state.cmpStacks[series.slug];
    if (stack?.ensureIndex && !stack[zi]?.complete) {
      tasks.push(stack.ensureIndex(zi, { priority: 'high' }));
    }
    for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
      const overlayStack = stacks[cache.kind];
      const session = overlaySession[cache.kind];
      if (session?.enabled && !overlayStack?.[zi]?.complete && overlayStack?.ensureIndex) {
        tasks.push(overlayStack.ensureIndex(zi, { priority: 'high' }));
      }
      if (cache.needsRegionMeta && session?.enabled && !session.metaReady && !po.regionMeta) {
        tasks.push(
          softFail(
            cachedFetchJson(regionMetaUrlForSeries(series)).then((data) => { if (data) po.regionMeta = data; }),
            `${series.slug} compare anatomy metadata`,
          ),
        );
      }
    }
  }
  if (!tasks.length) return null;
  const key = comparePendingKey(peers, z, matches);
  if (_comparePendingPromise && _comparePendingKey === key) return _comparePendingPromise;
  const token = ++_comparePendingToken;
  _comparePendingKey = key;
  compareSpinner(true, token);
  _comparePendingPromise = Promise.all(tasks)
    .then(() => {
      if (token !== _comparePendingToken) return false;
      if (state.mode === 'cmp' && state.sliceIdx === z) drawCompare();
      return true;
    })
    .finally(() => {
      if (token !== _comparePendingToken) return;
      _comparePendingPromise = null;
      _comparePendingKey = '';
      compareSpinner(false, token);
    });
  return _comparePendingPromise;
}

function resolvedCompareGroup(series) {
  if (series?.frameOfReferenceUIDConsistent === false || series?.slicePositionsDistinct === false) {
    return null;
  }
  const stats = series?.sliceSpacingStatsMm || series?.sliceSpacingStats || {};
  if (Number(series?.slices || series?.dimensions?.depth || 0) > 1 && Number(stats.min) === 0) {
    return null;
  }
  return seriesCompareGroup(series) ?? series?.group ?? null;
}

export function getGroupPeers() {
  const series = state.manifest.series;
  // Manual selection overrides auto-grouping
  const manual = state.cmpManualSlugs;
  if (manual && manual.length >= 2) {
    const set = new Set(manual);
    return series.filter((s) => set.has(s.slug));
  }
  const cur = series[state.seriesIdx];
  const group = resolvedCompareGroup(cur);
  if (group === undefined || group === null) return [];
  return series.filter((item) => resolvedCompareGroup(item) === group);
}

/** Build checkbox menu items inside the compare dropdown. */
export function buildCompareMenu(menuEl, { onSelectionChanged = null, onStop = null } = {}) {
  menuEl.innerHTML = '';
  const series = state.manifest.series;
  if (series.length < 2) return;
  // Which slugs are currently selected (manual or auto-group)
  const peers = getGroupPeers();
  const activeSlugs = new Set(peers.map((p) => p.slug));

  const head = document.createElement('div');
  head.className = 'cmp-menu-head';
  const indexSync = state.mode === 'cmp' && compareUsesIndexSync(peers, state.manifest.series[state.seriesIdx]);
  head.textContent = indexSync ? 'Compare series · index sync' : 'Compare series';
  menuEl.appendChild(head);

  const primary = state.manifest.series[state.seriesIdx];
  const primaryGroup = resolvedGroupKey(primary);
  const aligned = series.filter((item) => item.slug === primary.slug
    || (primaryGroup != null && resolvedGroupKey(item) === primaryGroup));
  const alignedSlugs = new Set(aligned.map((item) => item.slug));
  const sections = [
    ['Aligned series', aligned],
    ['Other or unknown study · not registered', series.filter((item) => !alignedSlugs.has(item.slug))],
  ];
  for (const [sectionLabel, entries] of sections) {
    if (!entries.length) continue;
    const section = document.createElement('div');
    section.className = 'cmp-menu-section';
    section.textContent = sectionLabel;
    menuEl.appendChild(section);
    for (const s of entries) {
      const item = document.createElement('label');
      item.className = 'dd-item cmp-pick ui-checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ui-checkbox-input';
      cb.value = s.slug;
      cb.checked = activeSlugs.has(s.slug);
      const box = document.createElement('span');
      box.className = 'ui-checkbox-box';
      box.setAttribute('aria-hidden', 'true');
      const toggle = document.createElement('span');
      toggle.className = 'ui-checkbox-toggle';
      toggle.appendChild(cb);
      toggle.appendChild(box);
      const copy = document.createElement('span');
      copy.className = 'cmp-pick-copy';
      const name = document.createElement('span');
      name.className = 'cmp-pick-name';
      name.textContent = s.name;
      const detail = document.createElement('span');
      detail.className = 'cmp-pick-detail';
      detail.textContent = compareSeriesDetail(s);
      copy.appendChild(name);
      copy.appendChild(detail);
      item.appendChild(toggle);
      item.appendChild(copy);
      item.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const result = applyMenuSelection(menuEl);
        onSelectionChanged?.(result);
      });
      menuEl.appendChild(item);
    }
  }

  if (onStop) {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'cmp-stop';
    stop.textContent = 'Stop comparing';
    stop.hidden = state.mode !== 'cmp';
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      onStop();
    });
    menuEl.appendChild(stop);
  }
}

/** Read checked state from the menu and update cmpManualSlugs. */
function applyMenuSelection(menuEl) {
  const checked = [...menuEl.querySelectorAll('input:checked')].map((cb) => cb.value);
  setComparePeers(checked);
  // Only refresh the live grid while the user still has a valid (>=2) manual set.
  // Dropping below 2 is handled by the caller (it exits compare) — never silently
  // fall back to the auto-group while the user is editing the selection.
  if (state.mode === 'cmp' && checked.length >= 2) {
    // Invariant: the primary (the scrubber's anchor) is always a visible pane. If the
    // user unchecked the current primary, promote the first remaining selection.
    const primarySlug = state.manifest.series[state.seriesIdx]?.slug;
    if (!checked.includes(primarySlug)) {
      const idx = state.manifest.series.findIndex((s) => s.slug === checked[0]);
      if (idx >= 0) { _selectSeries(idx, { preserveSlice: true }); return { checked, peers: getGroupPeers() }; }
    }
    buildCompareGrid();
    loadComparePeers().then(() => drawCompare());
  }
  return { checked, peers: getGroupPeers() };
}

export async function loadComparePeers() {
  const peers = getGroupPeers();
  trimCompareCaches(peers.map(peer => peer.slug));
  const currentIndex = state.sliceIdx;
  const primarySeries = state.manifest.series[state.seriesIdx];
  const matches = compareSliceMatches(peers, primarySeries, currentIndex);
  const currentLoaders = [];
  const backgroundLoaders = [];
  for (const p of peers) {
    const overlays = activeOverlayStateForSeries(p);
    const variant = state.overlays.useBrain && p.hasBrain ? `${p.slug}_brain` : p.slug;
    const match = matches[p.slug];
    const initialIndex = match?.index ?? Math.min(currentIndex, p.slices - 1);
    const base = loadImageStack(variant, p.slices, state.cmpStacks[p.slug], p, {
      label: `${p.slug} compare stack`,
      windowRadius: SLICE_WINDOW_RADIUS,
      initialIndex,
    });
    setPassthroughRootEntry('cmpStacks', p.slug, base.imgs);
    if (!match?.outOfRange) currentLoaders.push(base.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
    backgroundLoaders.push(...base.loaders);

    if (!peerOverlays[p.slug]) peerOverlays[p.slug] = {};
    const po = peerOverlays[p.slug];

    for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
      if (cache.refuseInOverlayStack || !overlays[cache.kind]?.enabled) continue;
      const loaded = loadImageStack(`${p.slug}_${cache.type}`, p.slices, po[cache.type], p, {
        label: `${p.slug} compare ${cache.kind} overlay`,
        windowRadius: SLICE_WINDOW_RADIUS,
        initialIndex,
      });
      po[cache.type] = loaded.imgs;
      if (!match?.outOfRange) currentLoaders.push(loaded.imgs.ensureIndex?.(initialIndex) || Promise.resolve(true));
      backgroundLoaders.push(...loaded.loaders);
      if (cache.needsRegionMeta && !po.regionMeta) {
        currentLoaders.push(
          softFail(
            cachedFetchJson(regionMetaUrlForSeries(p)).then((d) => { if (d) po.regionMeta = d; }),
            `${p.slug} compare anatomy metadata`,
          ),
        );
      }
    }
  }
  Promise.all(backgroundLoaders).then(() => {
    if (state.mode === 'cmp') drawCompare();
  });
  if (!currentLoaders.length) return;
  const token = ++_comparePendingToken;
  _comparePendingKey = comparePendingKey(peers, currentIndex, matches);
  compareSpinner(true, token);
  try {
    await Promise.all(currentLoaders);
  } finally {
    if (token === _comparePendingToken) {
      _comparePendingKey = '';
      _comparePendingPromise = null;
      compareSpinner(false, token);
    }
  }
}

export function buildCompareGrid() {
  const host = $('cmp-grid');
  host.innerHTML = '';
  const peers = getGroupPeers();
  if (!peers.length) return;
  for (const p of peers) {
    const cell = document.createElement('div');
    const isPrimary = p.slug === state.manifest.series[state.seriesIdx].slug;
    cell.className = 'cmp-cell' + (isPrimary ? ' primary' : '');
    cell.dataset.slug = p.slug;
    cell.innerHTML = `
      <canvas></canvas>
      <div class="cmp-lbl">${escapeHtml(p.name)}</div>
    `;
    const canvas = cell.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('mouseleave', () => _hideHover());
    }
    cell.addEventListener('click', async () => {
      const idx = state.manifest.series.findIndex(s => s.slug === p.slug);
      if (idx < 0 || idx === state.seriesIdx) return;
      await _selectSeries(idx, { preserveSlice: true });
    });
    host.appendChild(cell);
  }
  applyCompareViewport(host);
}

function warmCompareOverlay(stack, z) {
  if (!stack || stack[z]?.complete) return;
  stack.ensureWindow?.(z, 0)?.then(() => {
    if (state.mode === 'cmp' && state.sliceIdx === z) drawCompare();
  });
}

export function drawCompare() {
  const host = $('cmp-grid');
  const cells = host.querySelectorAll('.cmp-cell');
  const z = state.sliceIdx;
  const peers = getGroupPeers();
  const primarySeries = state.manifest.series[state.seriesIdx];
  const indexSync = compareUsesIndexSync(peers, primarySeries);
  const matches = compareSliceMatches(peers, primarySeries, z);
  const primarySlug = state.manifest.series[state.seriesIdx]?.slug;
  const hotLut = COLORMAPS.hot.lut;
  const wlLut = getFusedWLLut();
  if (ensureCompareCurrentSlice(peers, z, primarySlug, matches)) return;
  compareSpinner(false);
  const mmScale = sharedCompareMmScale(cells);

  cells.forEach((cell) => {
    const slug = cell.dataset.slug;
    const series = state.manifest.series.find(s => s.slug === slug);
    if (!series) return;
    const overlays = activeOverlayStateForSeries(series);
    const stack = state.cmpStacks[slug];
    if (!stack) return;
    const canvas = cell.querySelector('canvas');
    const label = cell.querySelector('.cmp-lbl');
    canvas.width = series.width;
    canvas.height = series.height;
    const spacing = inPlanePixelSpacing(series);
    const displaySize = mmScale && spacing.known
      ? {
          width: series.width * spacing.colMm * mmScale,
          height: series.height * spacing.rowMm * mmScale,
        }
      : inPlaneDisplaySize(series);
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;
    const match = matches[slug];
    if (match?.outOfRange) {
      cell.classList?.add?.('out-of-range');
      if (label) label.textContent = `${series.name} · out of range`;
      canvas.getContext('2d', { willReadFrequently: true })?.clearRect?.(0, 0, canvas.width, canvas.height);
      return;
    }
    cell.classList?.remove?.('out-of-range');
    if (label) label.textContent = registrationLabel(series, primarySeries, indexSync);
    const zi = match?.index ?? Math.min(z, series.slices - 1);
    warmCompareOverlay(stack, zi);
    const img = stack[zi];
    if (!img?.complete || img.naturalWidth === 0) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const baseBytes = readImageByteData(img, series.width, series.height);
    if (!baseBytes) return;

    const po = peerOverlays[slug] || {};
    const overlayBytes = overlayBytesFromCaches((cache) => {
      const overlayStack = comparePeerOverlayStack(cache, po, slug, primarySlug, overlays);
      warmCompareOverlay(overlayStack, zi);
      const ready = overlays[cache.kind]?.enabled
        && overlayStack?.[zi]?.complete
        && (cache.type !== 'regions' || po.regionMeta);
      return ready ? readImageByteData(overlayStack[zi], series.width, series.height) : null;
    });
    const anyOverlay = overlayBytesPresent(overlayBytes);

    if (!anyOverlay) {
      const imgData = canvas._cmpImageData?.width === series.width && canvas._cmpImageData?.height === series.height
        ? canvas._cmpImageData
        : ctx.createImageData(series.width, series.height);
      canvas._cmpImageData = imgData;
      const out32 = new Uint32Array(imgData.data.buffer);
      const fusedU32 = getFusedWLU32();
      for (let i = 0; i < out32.length; i++) out32[i] = fusedU32[baseBytes[i]];
      ctx.putImageData(imgData, 0, 0);
    } else {
      drawCompositeSlice(ctx, series.width, series.height, {
        baseBytes,
        overlayBytes,
        wlLut,
        regionColors: selectionRegionColors(po.regionMeta?.colors || null, state),
        regionAlpha: state.overlays.overlayOpacity,
        fusionAlpha: state.overlays.fusionOpacity,
        hotLut,
      });
    }
    drawAnnotationPins(ctx, { slug, sliceIdx: zi, series });
  });
  applyCompareViewport(host);
}
