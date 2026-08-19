import { storageJsonGet, storageJsonSet } from '../derived-objects.js';
import { seriesPersistenceKey } from '../core/series-identity.js';
import { state as appState } from '../core/state.js';
import {
  setAngleMeasurementMapEntry,
  setMeasurementMapEntry,
  setNoteMapEntry,
  setRoiMapEntry,
} from '../core/state/viewer-commands.js';
import { isLiveViewerHost } from '../runtime/viewer-runtime.js';

const LIVE_BUCKET_WRITERS = {
  measurements: setMeasurementMapEntry,
  angleMeasurements: setAngleMeasurementMapEntry,
  rois: setRoiMapEntry,
  notes: setNoteMapEntry,
};

export const MEASUREMENT_STORAGE_KEY = 'mri-viewer/measurements/v2';
export const ANGLE_STORAGE_KEY = 'mri-viewer/angles/v2';
export const ROI_STORAGE_KEY = 'mri-viewer/rois/v2';
export const NOTE_STORAGE_KEY = 'mri-viewer/annotations/v2';

function resolveSeries(host, seriesOrSlug) {
  if (seriesOrSlug && seriesOrSlug?.constructor !== String) return seriesOrSlug;
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

function standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list, writes) {
  if (hostOrSeries?.constructor === String) {
    return { host: appState, series: hostOrSeries, sliceIdx: seriesOrSlice, list: sliceOrList, writes: list };
  }
  return { host: hostOrSeries, series: seriesOrSlice, sliceIdx: sliceOrList, list, writes };
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

function listForSlice(hostBucket, ctx, sliceIdx) {
  const value = hostBucket?.[memoryKey(ctx, sliceIdx)];
  return Array.isArray(value) ? value : [];
}

function writeEntriesForSlice(host, bucketName, storageKey, ctx, sliceIdx, list, writes) {
  if (!ctx) return [];
  const next = Array.isArray(list) ? list : [];
  const key = memoryKey(ctx, sliceIdx);
  const writer = LIVE_BUCKET_WRITERS[bucketName];
  if (isLiveViewerHost(host)) {
    writer(key, next);
    writeSliceBucket(storageKey, ctx, sliceIdx, next);
    return next;
  }
  if (!writes?.runtimeMapEntry) {
    return listForSlice(host?.[bucketName], ctx, sliceIdx);
  }
  const value = next.length ? next.map((entry) => ({ ...entry })) : undefined;
  writes.runtimeMapEntry(host, bucketName, key, value);
  return next;
}

function hydrateStorageBucket(storageKey, setter) {
  const all = readBucket(storageKey);
  for (const [key, list] of Object.entries(all || {})) {
    if (Array.isArray(list) && list.length) setter(key, list);
  }
}

export function hydrateDrawingBags() {
  hydrateStorageBucket(MEASUREMENT_STORAGE_KEY, setMeasurementMapEntry);
  hydrateStorageBucket(ANGLE_STORAGE_KEY, setAngleMeasurementMapEntry);
  hydrateStorageBucket(ROI_STORAGE_KEY, setRoiMapEntry);
  hydrateStorageBucket(NOTE_STORAGE_KEY, setNoteMapEntry);
}

function pushSeriesEntries(out, ctx, bucket, kind, mapEntry) {
  const prefix = JSON.stringify([ctx.identity]).slice(0, -1);
  for (const [key, entries] of Object.entries(bucket || {})) {
    if (!key.startsWith(prefix)) continue;
    let parsed;
    try { parsed = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parsed) || parsed[0] !== ctx.identity) continue;
    const sliceIdx = Number(parsed[1] || 0);
    for (const [index, entry] of (entries || []).entries()) out.push(mapEntry(entry, sliceIdx, index));
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
  for (const [kind, hostBucket] of [
    ['line', host?.measurements],
    ['angle', host?.angleMeasurements],
  ]) {
    pushSeriesEntries(out, ctx, hostBucket, kind, (entry, sliceIdx, index) => ({
      kind, id: entryId(kind === 'line' ? 'measure' : 'angle', ctx.slug, sliceIdx, entry, index), sliceIdx, data: entry,
    }));
  }
  pushSeriesEntries(out, ctx, host?.rois, 'roi', (entry, sliceIdx, index) => ({
    kind: ['ellipse', 'polygon', 'polyline', 'point'].includes(entry["shape"]) ? entry["shape"] : 'polygon',
    id: `roi:${ctx.slug}|${sliceIdx}:${entry.id ?? index}`, sliceIdx, data: entry,
  }));
  pushSeriesEntries(out, ctx, host?.notes, 'note', (entry, sliceIdx, index) => ({
    kind: 'note', id: `note:${ctx.slug}|${sliceIdx}:${entry.id ?? index}`, sliceIdx, data: entry,
  }));
  return out.sort((a, b) => a.sliceIdx - b.sliceIdx);
}

export function measurementEntriesForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  return ctx ? listForSlice(host?.measurements, ctx, sliceIdx) : [];
}

export function setMeasurementEntriesForSlice(host, seriesOrSlug, sliceIdx, list, writes) {
  const ctx = context(host, seriesOrSlug);
  return writeEntriesForSlice(host, 'measurements', MEASUREMENT_STORAGE_KEY, ctx, sliceIdx, list, writes);
}

export function angleEntriesForSlice(host, seriesOrSlug, sliceIdx) {
  const ctx = context(host, seriesOrSlug);
  return ctx ? listForSlice(host?.angleMeasurements, ctx, sliceIdx) : [];
}

export function setAngleEntriesForSlice(host, seriesOrSlug, sliceIdx, list, writes) {
  const ctx = context(host, seriesOrSlug);
  return writeEntriesForSlice(host, 'angleMeasurements', ANGLE_STORAGE_KEY, ctx, sliceIdx, list, writes);
}

export function roiEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList);
  const ctx = context(args.host, args.series);
  return ctx ? listForSlice(args.host?.rois, ctx, args.sliceIdx) : [];
}

export function setRoiEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList, list, writes) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list, writes);
  return writeEntriesForSlice(args.host, 'rois', ROI_STORAGE_KEY, context(args.host, args.series), args.sliceIdx, args.list, args.writes);
}

export function noteEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList);
  const ctx = context(args.host, args.series);
  return ctx ? listForSlice(args.host?.notes, ctx, args.sliceIdx) : [];
}

export function setNoteEntriesForSlice(hostOrSeries, seriesOrSlice, sliceOrList, list, writes) {
  const args = standaloneSliceArgs(hostOrSeries, seriesOrSlice, sliceOrList, list, writes);
  return writeEntriesForSlice(args.host, 'notes', NOTE_STORAGE_KEY, context(args.host, args.series), args.sliceIdx, args.list, args.writes);
}

export function nextDrawingEntryId(list) {
  return (list.reduce((max, entry) => Math.max(max, Number(entry?.id || 0)), 0) || 0) + 1;
}

export function deleteDrawingEntryById(list, id) {
  return (list || []).filter((entry) => Number(entry?.id || 0) !== Number(id));
}

export function annotatedSlicesForSeries(hostOrSeries, seriesOrSlug) {
  const host = hostOrSeries?.constructor === String ? appState : hostOrSeries;
  const series = hostOrSeries?.constructor === String ? hostOrSeries : seriesOrSlug;
  const ctx = context(host, series);
  const out = new Set();
  if (!ctx) return out;
  pushSeriesEntries([], ctx, host?.notes, 'note', (_entry, sliceIdx) => {
    out.add(sliceIdx);
    return null;
  });
  return out;
}

export function clearDrawingEntriesForSlice(host, seriesOrSlug, sliceIdx, writes) {
  const ctx = context(host, seriesOrSlug);
  if (!ctx) return;
  setMeasurementEntriesForSlice(host, ctx.series, sliceIdx, [], writes);
  setAngleEntriesForSlice(host, ctx.series, sliceIdx, [], writes);
  setRoiEntriesForSlice(host, ctx.series, sliceIdx, [], writes);
  setNoteEntriesForSlice(host, ctx.series, sliceIdx, [], writes);
}
