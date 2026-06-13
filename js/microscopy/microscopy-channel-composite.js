import { mapWindowLevelByte } from '../colormap.js';
import { finiteDisplayRange } from './microscopy-display-range.js';

const FALLBACK_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00', '#FFFFFF'];

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mapDisplayRangeByte(value, range) {
  if (!range) return null;
  const [lo, hi] = range;
  return clampByte((Number(value) - lo) / (hi - lo) * 255);
}

export function channelDisplayColor(channel = {}, index = 0) {
  const color = String(channel.displayColor || channel.color || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) return color.toUpperCase();
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export function hexColorToRgb(color) {
  const hex = String(color || '').replace(/^#/, '');
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return [255, 255, 255];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function ensureMicroscopyComposite(series = {}, sizeC = 1) {
  const microscopy = series.microscopy || (series.microscopy = {});
  const previous = microscopy.composite || {};
  const channelCount = Math.max(1, Math.floor(Number(sizeC) || 1));
  const channels = Array.from({ length: channelCount }, (_, index) => previous.channels?.[index] !== false);
  microscopy.composite = {
    enabled: !!previous.enabled && channelCount > 1,
    channels,
  };
  return microscopy.composite;
}

export function setMicroscopyCompositeEnabled(series, enabled, sizeC = 1) {
  const composite = ensureMicroscopyComposite(series, sizeC);
  composite.enabled = !!enabled && composite.channels.length > 1;
  return composite.enabled;
}

export function setMicroscopyCompositeChannelEnabled(series, index, enabled, sizeC = 1) {
  const composite = ensureMicroscopyComposite(series, sizeC);
  const channelIndex = Math.max(0, Math.floor(Number(index) || 0));
  if (channelIndex >= composite.channels.length) return false;
  if (!enabled && composite.channels.filter(Boolean).length <= 1) return false;
  composite.channels[channelIndex] = !!enabled;
  return true;
}

export function drawMicroscopyChannelComposite(ctx, width, height, {
  sources = [],
  window = 255,
  level = 128,
  invert = false,
} = {}) {
  const active = sources.filter(source => source?.enabled !== false && source.bytes?.length === width * height);
  if (active.length < 1) return false;
  const image = ctx.createImageData(width, height);
  const out = image.data;
  const colors = active.map((source, index) => hexColorToRgb(channelDisplayColor(source.channel, source.index ?? index)));
  const displayRanges = active.map(source => finiteDisplayRange(source.displayRange));
  for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let c = 0; c < active.length; c += 1) {
      let value = mapDisplayRangeByte(active[c].bytes[i], displayRanges[c])
        ?? mapWindowLevelByte(active[c].bytes[i], window, level);
      if (invert) value = 255 - value;
      const [cr, cg, cb] = colors[c];
      r += value * cr / 255;
      g += value * cg / 255;
      b += value * cb / 255;
    }
    out[p] = clampByte(r);
    out[p + 1] = clampByte(g);
    out[p + 2] = clampByte(b);
    out[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

export function drawMicroscopyChannelSplit(ctx, width, height, {
  sources = [],
  window = 255,
  level = 128,
  invert = false,
  tileGap = 1,
} = {}) {
  const active = sources.filter(source => source?.enabled !== false && source.bytes?.length === width * height);
  if (active.length < 1) return false;
  const gap = Math.max(0, Math.floor(Number(tileGap) || 0));
  for (let c = 0; c < active.length; c += 1) {
    const image = ctx.createImageData(width, height);
    const out = image.data;
    const [cr, cg, cb] = hexColorToRgb(channelDisplayColor(active[c].channel, active[c].index ?? c));
    const displayRange = finiteDisplayRange(active[c].displayRange);
    for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
      let value = mapDisplayRangeByte(active[c].bytes[i], displayRange)
        ?? mapWindowLevelByte(active[c].bytes[i], window, level);
      if (invert) value = 255 - value;
      out[p] = clampByte(value * cr / 255);
      out[p + 1] = clampByte(value * cg / 255);
      out[p + 2] = clampByte(value * cb / 255);
      out[p + 3] = 255;
    }
    ctx.putImageData(image, c * (width + gap), 0);
  }
  return true;
}
