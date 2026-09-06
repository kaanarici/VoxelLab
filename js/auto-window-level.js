import { state } from './core/state.js';
import { setWindowLevel } from './core/state/viewer-commands.js';
import { readImageByteData } from './overlay/overlay-data.js';

function percentileFromHist(hist, total, percentile) {
  const target = Math.max(0, Math.min(total - 1, Math.floor(total * percentile)));
  let seen = 0;
  for (let v = 0; v < hist.length; v += 1) {
    seen += hist[v];
    if (seen > target) return v;
  }
  return hist.length - 1;
}

export function autoWindowLevelFromRgba(data, {
  minForeground = 8,
  lowPercentile = 0.005,
  highPercentile = 0.995,
  minWindow = 16,
} = {}) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let p = 0; p < data.length; p += 4) {
    const v = data[p];
    if (v < minForeground) continue;
    hist[v] += 1;
    n += 1;
  }
  if (n < 100) return null;
  const lo = percentileFromHist(hist, n, lowPercentile);
  const hi = percentileFromHist(hist, n, highPercentile);
  return {
    window: Math.round(Math.max(minWindow, hi - lo)),
    level: Math.round((lo + hi) / 2),
    low: lo,
    high: hi,
    samples: n,
  };
}

export function autoWindowLevelFromBytes(data, options = {}) {
  const {
    minForeground = 8,
    lowPercentile = 0.005,
    highPercentile = 0.995,
    minWindow = 16,
  } = options;
  const hist = new Uint32Array(256);
  let n = 0;
  for (const v of data) {
    if (v < minForeground) continue;
    hist[v] += 1;
    n += 1;
  }
  if (n < 100) return null;
  const lo = percentileFromHist(hist, n, lowPercentile);
  const hi = percentileFromHist(hist, n, highPercentile);
  return {
    window: Math.round(Math.max(minWindow, hi - lo)),
    level: Math.round((lo + hi) / 2),
    low: lo,
    high: hi,
    samples: n,
  };
}

export function autoWindowLevel() {
  if (!state.loaded) return;
  const series = state.manifest.series[state.seriesIdx];
  const img = state.imgs[state.sliceIdx];
  if (!img || !img.complete) return;
  const data = readImageByteData(img, series.width, series.height);
  if (!data) return;
  const next = autoWindowLevelFromBytes(data);
  if (!next) return;
  setWindowLevel(next.window, next.level);
  return next;
}
