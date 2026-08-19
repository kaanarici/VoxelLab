import { beginPerfTrace } from '../core/perf-trace.js';
import { state } from '../core/state.js';
import { rememberSeriesViewState } from '../core/state/series-view-memory.js';
import { setOverlayEnabled } from '../core/state/viewer-commands.js';
import { OVERLAY_ENABLE_KINDS } from '../core/viewer-session-shape.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { OVERLAY_CACHE_BY_KIND } from '../runtime/overlay-cache-keys.js';
import { forgetPreferredOverlay, rememberPreferredOverlay } from './overlay-preferences.js';
import { ensureOverlayStack } from './overlay-stack.js';

const OVERLAY_ENABLE_KIND_SET = new Set(OVERLAY_ENABLE_KINDS);

export function toggleSeriesOverlay(kind, exclusive = []) {
  if (!OVERLAY_ENABLE_KIND_SET.has(kind)) return null;
  const series = state.manifest?.series?.[state.seriesIdx];
  const overlays = activeOverlayStateForSeries(series);
  if (!overlays[kind]?.available) return null;
  const next = !state.overlays[kind];
  setOverlayEnabled(kind, next, exclusive);
  if (next) {
    beginPerfTrace('overlay-toggle-paint', {
      slug: series?.slug || '',
      overlay: kind,
    });
    rememberPreferredOverlay(series.modality, kind);
    const cache = OVERLAY_CACHE_BY_KIND[kind];
    if (cache) ensureOverlayStack(cache.type);
  } else {
    forgetPreferredOverlay(series.modality, kind);
  }
  rememberSeriesViewState();
  return activeOverlayStateForSeries(series);
}
