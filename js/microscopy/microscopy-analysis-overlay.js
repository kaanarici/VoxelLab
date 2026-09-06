import { state } from '../core/state.js';
import { setMicroscopyAnalysisOverlay } from '../overlay/post-composite-overlays.js';
import { overlayMask } from '../overlay/slimsam-overlay.js';

let current = null;

const LABEL_PALETTE = [
  [255, 80, 80], [80, 200, 120], [80, 160, 255],
  [240, 200, 60], [200, 120, 255], [255, 150, 80],
];

export function setThresholdOverlay({ mask, width, height, c, z, t }) {
  current = { ...(current || {}), thresholdMask: mask, labeledMask: current?.labeledMask ?? null, width, height, c, z, t };
}

export function setParticleOverlay({ labeledMask, width, height, c, z, t }) {
  current = { thresholdMask: current?.thresholdMask ?? null, labeledMask, width, height, c, z, t };
}

export function clearAnalysisOverlay() { current = null; }

export function analysisOverlayState() { return current; }

export function analysisOverlayStale(overlay, host = state, series = host?.manifest?.series?.[host?.seriesIdx]) {
  if (!overlay || (!overlay.thresholdMask && !overlay.labeledMask)) return true;
  if (!series || series.imageDomain !== 'microscopy') return true;
  const c = series.microscopy?.channelIndex || 0;
  const t = series.microscopy?.timeIndex || 0;
  const z = host?.sliceIdx || 0;
  return overlay.c !== c || overlay.t !== t || overlay.z !== z;
}

export function renderAnalysisOverlay(ctx, host = state, series = host?.manifest?.series?.[host?.seriesIdx]) {
  const overlay = current;
  if (analysisOverlayStale(overlay, host, series)) return false;
  if (overlay.thresholdMask) {
    overlayMask(ctx, { mask: overlay.thresholdMask, width: overlay.width, height: overlay.height }, { r: 80, g: 160, b: 255, a: 0.3 });
  }
  if (overlay.labeledMask) {
    const { labeledMask, width, height } = overlay;
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    const a = 0.4, invA = 1 - a;
    for (let i = 0; i < labeledMask.length; i++) {
      const lab = labeledMask[i];
      if (!lab) continue;
      const [r, g, b] = LABEL_PALETTE[(lab - 1) % LABEL_PALETTE.length];
      const p = i * 4;
      d[p] = Math.round(d[p] * invA + r * a);
      d[p + 1] = Math.round(d[p + 1] * invA + g * a);
      d[p + 2] = Math.round(d[p + 2] * invA + b * a);
    }
    ctx.putImageData(img, 0, 0);
  }
  return true;
}

let overlayBound = false;
export function initAnalysisOverlay() {
  if (overlayBound) return;
  overlayBound = true;
  setMicroscopyAnalysisOverlay((ctx) => renderAnalysisOverlay(ctx));
}
