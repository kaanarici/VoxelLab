import { $ } from '../dom.js';
import { inPlanePixelSpacing } from '../core/geometry.js';
import { lengthUnitToMm, preferredLengthUnit } from '../core/physical-units.js';
import { state } from '../core/state.js';

const TARGET_PX = 96;
const MIN_PX = 64;
const MAX_PX = 150;
const EDGE_INSET_PX = 14;
const OVER_IMAGE_CLASS = 'scale-bar-over-image';
const CHROME_SELECTORS = [
  '#wl-overlay',
  '#toolbar-root',
  '.toolbox.open .toolbox-panel',
  '#overlay-svg .roi-group',
  '.orient-marker:not(:empty)',
];

function niceLengthMm(idealMm) {
  if (!(idealMm > 0)) return 0;
  const power = 10 ** Math.floor(Math.log10(idealMm));
  const candidates = [1, 2, 5, 10].map(factor => factor * power);
  return candidates.reduce((best, next) =>
    Math.abs(next - idealMm) < Math.abs(best - idealMm) ? next : best, candidates[0]);
}

function formatScaleLabel(lengthMm, series) {
  const unit = preferredLengthUnit(series);
  const value = lengthMm / lengthUnitToMm(unit);
  const rounded = Math.abs(value - Math.round(value)) < 1e-6 ? String(Math.round(value)) : value.toPrecision(2);
  return `${rounded} ${unit}`;
}

function intersects(a, b) {
  return Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
}

function rectFromElement(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function scaleBarChromeRects() {
  return CHROME_SELECTORS.flatMap(selector =>
    Array.from(document.querySelectorAll?.(selector) || [])
      .map(rectFromElement)
      .filter(Boolean));
}

function setScaleBarCorner(root, candidate) {
  root.style.left = candidate.left == null ? '' : `${candidate.left}px`;
  root.style.right = candidate.right == null ? '' : `${candidate.right}px`;
  root.style.top = candidate.top == null ? '' : `${candidate.top}px`;
  root.style.bottom = candidate.bottom == null ? '' : `${candidate.bottom}px`;
}

function positionScaleBarOverImage(root, canvas) {
  const wrap = $('canvas-wrap');
  const wrapRect = wrap?.getBoundingClientRect?.();
  const canvasRect = canvas.getBoundingClientRect?.();
  const wrapRight = Number.isFinite(wrapRect?.right) ? wrapRect.right : (wrapRect?.left || 0) + (wrapRect?.width || 0);
  const wrapBottom = Number.isFinite(wrapRect?.bottom) ? wrapRect.bottom : (wrapRect?.top || 0) + (wrapRect?.height || 0);
  const canvasRight = Number.isFinite(canvasRect?.right) ? canvasRect.right : (canvasRect?.left || 0) + (canvasRect?.width || 0);
  const canvasBottom = Number.isFinite(canvasRect?.bottom) ? canvasRect.bottom : (canvasRect?.top || 0) + (canvasRect?.height || 0);
  if (!wrapRect || !canvasRect || !(canvasRect.width > 0) || !(canvasRect.height > 0)) {
    root.classList?.remove?.(OVER_IMAGE_CLASS);
    root.style.left = '';
    root.style.right = '';
    root.style.top = '';
    root.style.bottom = '';
    return;
  }
  const visibleLeft = Math.max(canvasRect.left || 0, wrapRect.left || 0);
  const visibleTop = Math.max(canvasRect.top || 0, wrapRect.top || 0);
  const visibleRight = Math.min(canvasRight, wrapRight);
  const visibleBottom = Math.min(canvasBottom, wrapBottom);
  const overImage = visibleRight > visibleLeft && visibleBottom > visibleTop;
  root.classList?.toggle?.(OVER_IMAGE_CLASS, overImage);
  const candidates = [
    { right: Math.max(EDGE_INSET_PX, wrapRight - visibleRight + EDGE_INSET_PX), bottom: Math.max(EDGE_INSET_PX, wrapBottom - visibleBottom + EDGE_INSET_PX) },
    { left: Math.max(EDGE_INSET_PX, visibleLeft - (wrapRect.left || 0) + EDGE_INSET_PX), bottom: Math.max(EDGE_INSET_PX, wrapBottom - visibleBottom + EDGE_INSET_PX) },
    { right: Math.max(EDGE_INSET_PX, wrapRight - visibleRight + EDGE_INSET_PX), top: Math.max(EDGE_INSET_PX, visibleTop - (wrapRect.top || 0) + EDGE_INSET_PX) },
    { left: Math.max(EDGE_INSET_PX, visibleLeft - (wrapRect.left || 0) + EDGE_INSET_PX), top: Math.max(EDGE_INSET_PX, visibleTop - (wrapRect.top || 0) + EDGE_INSET_PX) },
    { left: EDGE_INSET_PX, top: EDGE_INSET_PX },
    { right: EDGE_INSET_PX, top: EDGE_INSET_PX },
    { left: EDGE_INSET_PX, bottom: EDGE_INSET_PX },
    { right: EDGE_INSET_PX, bottom: EDGE_INSET_PX },
  ];
  const chromeRects = scaleBarChromeRects();
  for (const candidate of candidates) {
    setScaleBarCorner(root, candidate);
    const rect = rectFromElement(root);
    if (!rect || chromeRects.every(chrome => !intersects(rect, chrome))) return;
  }
  setScaleBarCorner(root, candidates[0]);
}

export function calibratedScaleBarModel(series, {
  canvasCssWidth = 0,
  imageWidth = 0,
  zoom = 1,
  targetPx = TARGET_PX,
} = {}) {
  const spacing = inPlanePixelSpacing(series);
  if (!spacing.known || !(canvasCssWidth > 0) || !(imageWidth > 0) || !(zoom > 0)) return null;
  const cssPxPerImagePx = canvasCssWidth / imageWidth;
  const mmPerScreenPx = spacing.colMm / (cssPxPerImagePx * zoom);
  const idealMm = targetPx * mmPerScreenPx;
  let lengthMm = niceLengthMm(idealMm);
  let widthPx = lengthMm / mmPerScreenPx;
  if (widthPx < MIN_PX) {
    lengthMm = niceLengthMm(MIN_PX * mmPerScreenPx);
    widthPx = lengthMm / mmPerScreenPx;
  } else if (widthPx > MAX_PX) {
    lengthMm = niceLengthMm(MAX_PX * mmPerScreenPx);
    widthPx = lengthMm / mmPerScreenPx;
  }
  if (!(widthPx > 0)) return null;
  return {
    widthPx: Math.max(1, Math.round(widthPx)),
    lengthMm,
    label: formatScaleLabel(lengthMm, series),
  };
}

export function updateScaleBar() {
  const root = $('scale-bar');
  if (!root) return null;
  const line = $('scale-bar-line');
  const label = $('scale-bar-label');
  const series = state.manifest?.series?.[state.seriesIdx];
  const canvas = $('view');
  if (!state.loaded || !series || state.mode !== '2d' || !canvas) {
    root.hidden = true;
    root.classList?.remove?.(OVER_IMAGE_CLASS);
    return null;
  }
  const cssWidth = Number.parseFloat(canvas.style?.width || '') || canvas.getBoundingClientRect?.().width || 0;
  const model = calibratedScaleBarModel(series, {
    canvasCssWidth: cssWidth,
    imageWidth: canvas.width,
    zoom: state.zoom,
  });
  if (!model) {
    root.hidden = true;
    root.classList?.remove?.(OVER_IMAGE_CLASS);
    return null;
  }
  root.hidden = false;
  root.setAttribute('aria-label', `Scale bar ${model.label}`);
  if (line) line.style.width = `${model.widthPx}px`;
  if (label) label.textContent = model.label;
  positionScaleBarOverImage(root, canvas);
  return model;
}
