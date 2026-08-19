import { COLORMAPS } from '../colormap-registry.js';
import { SEG_PALETTE } from '../core/constants.js';
import { state } from '../core/state.js';
import { OVERLAY_CACHE_BY_KIND } from './overlay-cache-keys.js';
import { overlayAvailabilityForKind } from './overlay-kinds.js';

// Shape: { available: true, enabled: false, ready: false, voxels: Uint8Array(...) }.
function describeOverlayKind(cache, base = {}) {
  const kind = cache.kind;
  const imgs = state[cache.imgs];
  const voxels = state[cache.voxels];
  if (cache.peerSlugField) {
    const bound = !!state.overlays[cache.peerSlugField];
    return {
      available: bound,
      enabled: bound,
      ready: !!voxels,
      voxels,
      imgs,
      meta: null,
    };
  }
  const available = !!base.available;
  const meta = cache.needsRegionMeta ? state.overlays.regionMeta : null;
  return {
    available,
    enabled: available && !!state.overlays[kind],
    ready: available && !!voxels && (!cache.needsRegionMeta || !!meta),
    voxels,
    imgs,
    meta,
  };
}

function colorsFromLut(lut) {
  const colors = {};
  for (let i = 1; i < 256; i++) {
    const base = i * 4;
    colors[i] = [lut[base], lut[base + 1], lut[base + 2]];
  }
  return colors;
}

function opacityTable(alpha) {
  const value = Math.max(0, Math.min(1, Number(alpha) || 0));
  const opacities = {};
  for (let i = 1; i < 256; i++) opacities[i] = value;
  return opacities;
}

let tissueColors = null;
let hotLutColors = null;

function getTissueColors() {
  if (!tissueColors) tissueColors = Object.fromEntries(Object.entries(SEG_PALETTE).map(([key, value]) => [key, value.slice(0, 3)]));
  return tissueColors;
}

function getHotLutColors() {
  if (!hotLutColors) hotLutColors = colorsFromLut(COLORMAPS.hot.lut);
  return hotLutColors;
}


// Shape: { tissue: { available: true }, labels: { available: false } }.
export function activeOverlayStateForSeries(series = state.manifest?.series?.[state.seriesIdx]) {
  const overlays = {};
  for (const cache of Object.values(OVERLAY_CACHE_BY_KIND)) {
    overlays[cache.kind] = describeOverlayKind(cache, {
      available: overlayAvailabilityForKind(series, cache.kind),
    });
  }
  return overlays;
}

// Shape: { mode: 2, source: Uint8Array(...), colors: { 4: [255, 0, 0] } }.
export function activeThreeLabelOverlay(series = state.manifest?.series?.[state.seriesIdx]) {
  const overlays = activeOverlayStateForSeries(series);
  if (overlays.labels.enabled && overlays.labels.voxels && overlays.labels.meta) {
    return {
      mode: 2,
      source: overlays.labels.voxels,
      colors: overlays.labels.meta.colors || {},
      opacities: null,
      legend: overlays.labels.meta.regions || null,
    };
  }
  if (overlays.tissue.enabled && overlays.tissue.voxels) {
    return {
      mode: 1,
      source: overlays.tissue.voxels,
      colors: getTissueColors(),
      opacities: null,
      legend: null,
    };
  }
  if (overlays.fusion.enabled && overlays.fusion.voxels) {
    return {
      mode: 3,
      source: overlays.fusion.voxels,
      colors: getHotLutColors(),
      opacities: opacityTable(state.overlays.fusionOpacity),
      opacity: state.overlays.fusionOpacity,
      legend: null,
    };
  }
  if (overlays.heatmap.enabled && overlays.heatmap.voxels) {
    return {
      mode: 3,
      source: overlays.heatmap.voxels,
      colors: getHotLutColors(),
      opacities: opacityTable(state.overlays.overlayOpacity),
      opacity: state.overlays.overlayOpacity,
      legend: null,
    };
  }
  return { mode: 0, source: null, colors: null, opacities: null, legend: null };
}
