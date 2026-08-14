import { storageJsonGet, storageJsonSet } from '../derived-objects.js';
import { seriesPersistenceKey } from '../series/series-identity.js';
import { state as appState } from '../core/state.js';

export const MEASUREMENT_STORAGE_KEY = 'mri-viewer/measurements/v2';
export const ANGLE_STORAGE_KEY = 'mri-viewer/angles/v2';
export const ROI_STORAGE_KEY = 'mri-viewer/rois/v2';
export const NOTE_STORAGE_KEY = 'mri-viewer/annotations/v2';

function resolveSeries(host, seriesOrSlug) {
  if (seriesOrSlug && typeof seriesOrSlug === 'object') return seriesOrSlug;
  const active = host?.manifest?.series?.[host?.seriesIdx];
  if (active?.slug === seriesOrSlug) return active;
  const matches = (host?.manifest?.series || []).filter((series) => series?.slug === seriesOrSlug);
  if (matches.length === 1) return matches[0];
  // Test and isolated utility callers without a manifest remain usable. Real
  // viewer callers pass the selected series object, so an ambiguous slug never
  // becomes a durable identity.
  return matches.length ? null : { slug: String(seriesOrSlug || '') };
}

function context(host, seriesOrSlug) {
  const series = resolveSeries(host, seriesOrSlug);
  const identity = seriesPersistenceKey(series, host?.manifest || {});
  return series?.slug && identity ? { series, slug: series.slug, identity } : null;
}

function standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list) {
  if (typeof hostOrSeries === 'string') {
    return { host: appState, series: hostOrSeries, sliceIdx: seriesOrSlice, list: sliceOrList };
  }
  return { host: hostOrSeries, series: seriesOrSlice, sliceIdx: sliceOrList, list };
}

function sliceKey(ctx, sliceIdx) {
  return JSON.stringify([ctx.identity, Number(sliceIdx) || 0]);
}

function readBucket(key) {
  return storageJsonGet(key, {});
}

function writeBucket(key, value) {
  return storageJsonSet(key, value);
}

function readSliceBucket(storageKey, ctx, sliceIdx) {
  if (!ctx) return [];
  const all = readBucket(storageKey);
  const value = all[sliceKey(ctx, sliceIdx)];
  return Array.isArray(value) ? value : [];
}

function writeSliceBucket(storageKey, ctx, sliceIdx, list) {
  if (!ctx) return [];
  const all = readBucket(storageKey);
  const key = sliceKey(ctx, sliceIdx);
  if (Array.isArray(list) && list.length) all[key] = list;
  else delete all[key];
  writeBucket(storageKey, all);
  return list;
}

function memoryKey(ctx, sliceIdx) {
  return sliceKey(ctx, sliceIdx);
}

function listForSlice(hostBucket, storageKey, ctx, sliceIdx) {
  const storageList = readSliceBucket(storageKey, ctx, sliceIdx);
  if (storageList.length) return storageList;
  return Array.isArray(hostBucket?.[memoryKey(ctx, sliceIdx)]) ? hostBucket[memoryKey(ctx, sliceIdx)] : [];
}

function writeHostSlice(hostBucket, ctx, sliceIdx, list) {
  if (!hostBucket || !ctx) return;
  const key = memoryKey(ctx, sliceIdx);
  if (Array.isArray(list) && list.length) hostBucket[key] = list.map((entry) => ({ ...entry }));
  else delete hostBucket[key];
}

function pushSeriesEntries(out, ctx, bucket, kind, mapEntry) {
  const prefix = JSON.stringify([ctx.identity]).slice(0, -1);
  for (const [key, entries] of Object.entries(bucket || {})) {
    if (!key.startsWith(prefix)) continue;
    let parsed;
    try { parsed = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parsed) || parsed[0] !== ctx.identity) continue;
    const sliceIdx = Number(parsed[1] || 0);
    for (const entry of entries || []) out.push(mapEntry(entry, sliceIdx));
  }
}

function entryId(kind, slug, sliceIdx, entry, index) {
  return `${kind}:${slug}|${sliceIdx}:${entry?.id ?? index}`;
}

// Shape: { measurements: 1, angles: 0, rois: 2, notes: 1, total: 4 }.
export function drawingCountsForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  if (!ctx) return { measurements: 0, angles: 0, rois: 0, notes: 0, total: 0 };
  const measurements = measurementEntriesForSlice(host, ctx.series, sliceIdx).length;
  const angles = angleEntriesForSlice(host, ctx.series, sliceIdx).length;
  const rois = roiEntriesForSlice(host, ctx.series, sliceIdx).length;
  const notes = noteEntriesForSlice(host, ctx.series, sliceIdx).length;
  return { measurements, angles, rois, notes, total: measurements + angles + rois + notes };
}

// Shape: [{ kind: "line", id: "measure:brain_ax|12:0", sliceIdx: 12, data: {...} }].
export function drawingEntriesForSeries(host, seriesOrSlug) {
  const ctx = context(host, seriesOrSlug);
  if (!ctx) return [];
  const out = [];
  const seen = new Set();
  const pushUnique = (entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };
  for (const [kind, storageKey, hostBucket] of [
    ['line', MEASUREMENT_STORAGE_KEY, host?.measurements],
    ['angle', ANGLE_STORAGE_KEY, host?.angleMeasurements],
  ]) {
    const persisted = [];
    pushSeriesEntries(persisted, ctx, readBucket(storageKey), kind, (entry, sliceIdx) => ({
      kind, id: entryId(kind === 'line' ? 'measure' : 'angle', ctx.slug, sliceIdx, entry, 0), sliceIdx, data: entry,
    }));
    for (const entry of persisted) pushUnique(entry);
    const keyPrefix = JSON.stringify([ctx.identity]).slice(0, -1);
    for (const [key, entries] of Object.entries(hostBucket || {})) {
      if (!key.startsWith(keyPrefix)) continue;
      let parsed;
      try { parsed = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parsed) || parsed[0] !== ctx.identity) continue;
      const sliceIdx = Number(parsed[1] || 0);
      for (const [index, entry] of (entries || []).entries()) {
        pushUnique({ kind, id: entryId(kind === 'line' ? 'measure' : 'angle', ctx.slug, sliceIdx, entry, index), sliceIdx, data: entry });
      }
    }
  }
  pushSeriesEntries(out, ctx, readBucket(ROI_STORAGE_KEY), 'roi', (entry, sliceIdx) => ({
    kind: ['ellipse', 'polygon', 'polyline', 'point'].includes(entry.shape) ? entry.shape : 'polygon',
    id: `roi:${ctx.slug}|${sliceIdx}:${entry.id ?? 0}`, sliceIdx, data: entry,
  }));
  pushSeriesEntries(out, ctx, readBucket(NOTE_STORAGE_KEY), 'note', (entry, sliceIdx) => ({
    kind: 'note', id: `note:${ctx.slug}|${sliceIdx}:${entry.id ?? 0}`, sliceIdx, data: entry,
  }));
  return out.sort((a, b) => a.sliceIdx - b.sliceIdx);
}

export function measurementEntriesForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  return ctx ? listForSlice(host?.measurements, MEASUREMENT_STORAGE_KEY, ctx, sliceIdx) : [];
}

export function setMeasurementEntriesForSlice(host, seriesOrSlug, sliceIdx, list) {
  const ctx = context(host, seriesOrSlug);
  const next = writeSliceBucket(MEASUREMENT_STORAGE_KEY, ctx, sliceIdx, list);
  writeHostSlice(host?.measurements, ctx, sliceIdx, next);
  return next;
}

export function angleEntriesForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  return ctx ? listForSlice(host?.angleMeasurements, ANGLE_STORAGE_KEY, ctx, sliceIdx) : [];
}

export function setAngleEntriesForSlice(host, seriesOrSlug, sliceIdx, list) {
  const ctx = context(host, seriesOrSlug);
  const next = writeSliceBucket(ANGLE_STORAGE_KEY, ctx, sliceIdx, list);
  writeHostSlice(host?.angleMeasurements, ctx, sliceIdx, next);
  return next;
}

export function roiEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList);
  const ctx = context(args.host, args.series);
  return ctx ? readSliceBucket(ROI_STORAGE_KEY, ctx, args.sliceIdx) : [];
}

export function setRoiEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList, list) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list);
  return writeSliceBucket(ROI_STORAGE_KEY, context(args.host, args.series), args.sliceIdx, args.list);
}

export function noteEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList);
  const ctx = context(args.host, args.series);
  return ctx ? readSliceBucket(NOTE_STORAGE_KEY, ctx, args.sliceIdx) : [];
}

export function setNoteEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList, list) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list);
  return writeSliceBucket(NOTE_STORAGE_KEY, context(args.host, args.series), args.sliceIdx, args.list);
}

export function nextDrawingEntryId(list) {
  return (list.reduce((max, entry) => Math.max(max, Number(entry?.id || 0)), 0) || 0) + 1;
}

export function deleteDrawingEntryById(list, id) {
  return (list || []).filter((entry) => Number(entry?.id || 0) !== Number(id));
}

export function annotatedSlicesForSeries(hostOrSeries, seriesOrSlug) {
  const host = typeof hostOrSeries === 'string' ? appState : hostOrSeries;
  const series = typeof hostOrSeries === 'string' ? hostOrSeries : seriesOrSlug;
  const ctx = context(host, series);
  const out = new Set();
  if (!ctx) return out;
  pushSeriesEntries([], ctx, readBucket(NOTE_STORAGE_KEY), 'note', (_entry, sliceIdx) => {
    out.add(sliceIdx);
    return null;
  });
  return out;
}

export function clearDrawingEntriesForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  if (!ctx) return;
  setMeasurementEntriesForSlice(host, ctx.series, sliceIdx, []);
  setAngleEntriesForSlice(host, ctx.series, sliceIdx, []);
  setRoiEntriesForSlice(host, ctx.series, sliceIdx, []);
  setNoteEntriesForSlice(host, ctx.series, sliceIdx, []);
}
