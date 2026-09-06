import { $ } from './dom.js';
import { state } from './core/state.js';
import { readImageByteData } from './overlay/overlay-data.js';

function barColor(alpha) {
  const isLight = document.documentElement.classList.contains('light');
  return isLight ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
}

function panelBackgroundColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  return v || '#111111';
}

function histogramBandFill(isLight) {
  return isLight ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.08)';
}
function histogramBandStroke(isLight) {
  return isLight ? 'rgba(0, 0, 0, 0.32)' : 'rgba(255, 255, 255, 0.35)';
}

let getAnnotatedSlices = () => new Set();

export function initSparkline(hook) {
  if (hook instanceof Function) getAnnotatedSlices = hook;
}

let _sparkBase = null;

const _sparkCache = {
  w: 0,
  h: 22,
  dpr: 0,
  n: 0,
  scoresRef: null,
  maxV: 1,
  annotKey: '',
  theme: '',
};

function annotationKey(set) {
  if (!set || set.size === 0) return '';
  const vals = Array.from(set).sort((a, b) => a - b);
  return vals.join(',');
}

export function drawSparkline() {
  const c = $('sparkline');
  if (!c) return;

  const scores = state.overlays.stats?.symmetryScores;
  const hasData = scores && scores.length > 0;
  c.hidden = !hasData;
  if (!hasData) return;

  const n = scores.length;

  const w = c.clientWidth || c.parentElement.clientWidth || 400;
  const h = 22;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.max(1, Math.round(w * dpr));
  const pxH = Math.max(1, Math.round(h * dpr));
  if (c.width !== pxW || c.height !== pxH) {
    c.width = pxW;
    c.height = pxH;
  }
  if (c.style.height !== h + 'px') c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const annotated = getAnnotatedSlices();
  const annotKey = annotationKey(annotated);

  const currentTheme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const needsBaseRebuild =
    !_sparkBase ||
    _sparkCache.w !== w ||
    _sparkCache.h !== h ||
    _sparkCache.dpr !== dpr ||
    _sparkCache.scoresRef !== scores ||
    _sparkCache.n !== n ||
    _sparkCache.annotKey !== annotKey ||
    _sparkCache.theme !== currentTheme;

  if (needsBaseRebuild) {
    let maxV = 1;
    for (let i = 0; i < n; i++) if (scores[i] > maxV) maxV = scores[i];

    if (!_sparkBase) _sparkBase = document.createElement('canvas');
    _sparkBase.width = pxW;
    _sparkBase.height = pxH;
    const bctx = _sparkBase.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, w, h);

    const barW = w / n;
    for (let i = 0; i < n; i++) {
      const v = scores[i] / maxV;
      const bh = v * (h - 2);
      bctx.fillStyle = barColor(0.18 + v * 0.5);
      bctx.fillRect(i * barW + 0.5, h - 1 - bh, Math.max(1, barW - 1), bh);
    }

    bctx.fillStyle = barColor(0.85);
    annotated.forEach((z) => {
      const x = (z + 0.5) * barW;
      bctx.beginPath();
      bctx.arc(x, 3, 2, 0, Math.PI * 2);
      bctx.fill();
    });

    _sparkCache.w = w;
    _sparkCache.h = h;
    _sparkCache.dpr = dpr;
    _sparkCache.n = n;
    _sparkCache.scoresRef = scores;
    _sparkCache.maxV = maxV;
    _sparkCache.annotKey = annotKey;
    _sparkCache.theme = currentTheme;
  }

  ctx.drawImage(_sparkBase, 0, 0, w, h);

  const maxV = _sparkCache.maxV || 1;
  const barW = w / n;
  const idx = state.sliceIdx | 0;
  if (idx >= 0 && idx < n) {
    const v = scores[idx] / maxV;
    const bh = v * (h - 2);
    ctx.fillStyle = barColor(0.9);
    ctx.fillRect(idx * barW + 0.5, h - 1 - bh, Math.max(1, barW - 1), bh);
  }

  ctx.strokeStyle = barColor(0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cx = Math.max(0, Math.min(w - 1, (state.sliceIdx + 0.5) * barW));
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();
}

const _histCache = { image: null, width: 0, height: 0, bins: null, max: 0 };

export function syncHistogramPanel() {
  const c = $('histogram');
  const block = $('histogram-block');
  const emptyEl = $('histogram-empty');
  const hintEl = $('histogram-empty-hint');
  const titleEl = $('histogram-empty-title');
  if (!c || !block || !emptyEl) return false;

  const series = state.manifest?.series[state.seriesIdx];
  const setEmpty = (title, hint) => {
    block.classList.add('histogram-block--empty');
    emptyEl.hidden = false;
    if (titleEl) titleEl.textContent = title;
    if (hintEl) hintEl.textContent = hint;
  };

  if (state.mode !== '2d') {
    block.hidden = true;
    return false;
  }
  block.hidden = false;

  if (!series) {
    setEmpty('Slice histogram', 'Open 2D slice view to see intensity distribution for the current slice.');
    return false;
  }

  const img = state.imgs[state.sliceIdx];
  if (!img || !img.complete) {
    setEmpty('Slice histogram', 'Waiting for the slice image…');
    return false;
  }

  block.classList.remove('histogram-block--empty');
  emptyEl.hidden = true;
  return true;
}

export function drawHistogram() {
  const c = $('histogram');
  if (!c || !syncHistogramPanel()) return;
  const series = state.manifest.series[state.seriesIdx];
  const img = state.imgs[state.sliceIdx];

  let bins, max;
  const cacheHit =
    _histCache.bins &&
    _histCache.image === img &&
    _histCache.width === series.width &&
    _histCache.height === series.height;

  if (cacheHit) {
    bins = _histCache.bins;
    max = _histCache.max;
  } else {
    const data = readImageByteData(img, series.width, series.height);
    if (!data) return;

    bins = new Uint32Array(256);
    for (const v of data) {
      if (v < 4) continue;
      bins[v]++;
    }
    max = 0;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];

    _histCache.image = img;
    _histCache.width = series.width;
    _histCache.height = series.height;
    _histCache.bins = bins;
    _histCache.max = max;
  }

  const w = c.clientWidth || 240;
  const h = 52;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const isLight = document.documentElement.classList.contains('light');
  ctx.fillStyle = panelBackgroundColor();
  ctx.fillRect(0, 0, w, h);

  const binW = w / 256;
  ctx.fillStyle = barColor(isLight ? 0.52 : 0.6);
  for (let i = 0; i < 256; i++) {
    if (bins[i] === 0) continue;

    const bh = (Math.log(1 + bins[i]) / Math.log(1 + max)) * h;
    ctx.fillRect(i * binW, h - bh, Math.max(1, binW), bh);
  }

  const lo = state.level - state.window / 2;
  const hi = state.level + state.window / 2;
  ctx.fillStyle = histogramBandFill(isLight);
  ctx.fillRect(lo * binW, 0, Math.max(1, (hi - lo) * binW), h);
  ctx.strokeStyle = histogramBandStroke(isLight);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lo * binW, 0); ctx.lineTo(lo * binW, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hi * binW, 0); ctx.lineTo(hi * binW, h); ctx.stroke();
}
