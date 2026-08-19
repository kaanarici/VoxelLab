import { seriesIdentityKey } from '../core/series-identity.js';
import { mergeSeriesRecordPatch } from '../core/state/viewer-commands.js';

function hostSeriesRecord(host, series) {
  const list = host?.manifest?.series;
  if (!Array.isArray(list) || !series) return series;
  const direct = list.indexOf(series);
  if (direct >= 0) return list[direct];
  const key = seriesIdentityKey(series, host.manifest);
  if (!key) return series;
  return list.find((item) => seriesIdentityKey(item, host.manifest) === key) || series;
}

export function writeHostSeriesRecord(host, series, patch) {
  const target = hostSeriesRecord(host, series);
  if (!target) return series;
  Object.assign(target, mergeSeriesRecordPatch(target, patch));
  return target;
}

export function writeHostSliceIndex(host, sliceIdx) {
  const next = Math.max(0, Math.floor(Number(sliceIdx) || 0));
  host.sliceIdx = next;
  return next;
}

export function writeHostInvertDisplay(host, enabled) {
  host.invertDisplay = !!enabled;
  return !!enabled;
}

export function writeHostWindowLevel(host, windowValue, levelValue) {
  host.window = Math.max(1, Math.min(512, Number(windowValue) || 1));
  host.level = Math.max(0, Math.min(255, Number(levelValue) || 0));
  return { window: host.window, level: host.level };
}

export function writeHostColormap(host, name) {
  if (!name) return host.colormap;
  host.colormap = name;
  return host.colormap;
}

export function writeHostDisplayStack(host, slug, stack, sliceIdx) {
  const images = Array.isArray(stack) ? stack : [];
  const max = Math.max(0, images.length - 1);
  const nextSlice = Math.max(0, Math.min(Math.floor(Number(sliceIdx) || 0), max));
  if (slug) {
    if (!host._localStacks || Object.getPrototypeOf(host._localStacks) !== Object.prototype) host._localStacks = {};
    host._localStacks[slug] = images;
  }
  host.imgs = images;
  host.sliceIdx = nextSlice;
  return true;
}

export function writeHostRuntimeMapEntry(host, mapKey, entryKey, value) {
  const key = String(entryKey || '');
  if (!key) return false;
  if (value === undefined) {
    if (host[mapKey]) delete host[mapKey][key];
    return true;
  }
  if (!host[mapKey] || Object.getPrototypeOf(host[mapKey]) !== Object.prototype) host[mapKey] = {};
  host[mapKey][key] = value;
  return true;
}

export function replaceHostRuntimeMap(host, mapKey, next = {}) {
  host[mapKey] = next && Object.getPrototypeOf(next) === Object.prototype ? next : {};
  return host[mapKey];
}

export function isolatedHostWrites() {
  return {
    patchSeries: writeHostSeriesRecord,
    sliceIndex: writeHostSliceIndex,
    invertDisplay: writeHostInvertDisplay,
    windowLevel: writeHostWindowLevel,
    colormap: writeHostColormap,
    displayStack: writeHostDisplayStack,
    runtimeMapEntry: writeHostRuntimeMapEntry,
    replaceRuntimeMap: replaceHostRuntimeMap,
  };
}
