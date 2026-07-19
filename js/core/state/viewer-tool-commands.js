import { batch, state } from '../state.js';
import {
  angleEntriesForSlice,
  deleteDrawingEntryById,
  measurementEntriesForSlice,
  nextDrawingEntryId,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
} from '../../overlay/annotation-graph.js';
import { rememberSeriesViewState } from './series-view-memory.js';
import { scheduleSessionPersist } from './session-persistence.js';

function parseSliceKey(key) {
  const [slug = '', slicePart = '0'] = String(key || '').split('|');
  return { slug, sliceIdx: Number(slicePart || 0) };
}

export function setMeasureMode(enabled) {
  batch(() => {
    state.measureMode = !!enabled;
    state.measurePending = null;
  });
  return state.measureMode;
}

export function setMeasurePending(point) {
  state.measurePending = point ? { ...point } : null;
  return state.measurePending;
}

export function appendMeasurement(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const series = state.manifest?.series?.[state.seriesIdx];
  const target = series?.slug === slug ? series : slug;
  const list = measurementEntriesForSlice(state, target, sliceIdx);
  // Shape: { id: 3, x1: 10, y1: 20, x2: 40, y2: 20, mm: 12.4 }.
  const { _new, ...persisted } = measurement || {};
  const next = [...list, { ...persisted, id: persisted?.id ?? nextDrawingEntryId(list) }];
  return setMeasurementEntriesForSlice(state, target, sliceIdx, next);
}

export function deleteMeasurementAt(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const series = state.manifest?.series?.[state.seriesIdx];
  const target = series?.slug === slug ? series : slug;
  const list = measurementEntriesForSlice(state, target, sliceIdx);
  const next = measurement?.id != null
    ? deleteDrawingEntryById(list, measurement.id)
    : list.filter((entry) => entry !== measurement);
  setMeasurementEntriesForSlice(state, target, sliceIdx, next);
}

export function setAngleMode(enabled) {
  batch(() => {
    state.angleMode = !!enabled;
    state.anglePending = null;
  });
  return state.angleMode;
}

export function setAnglePending(points) {
  state.anglePending = Array.isArray(points) ? points.map((point) => ({ ...point })) : null;
  return state.anglePending;
}

export function appendAngleMeasurement(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const series = state.manifest?.series?.[state.seriesIdx];
  const target = series?.slug === slug ? series : slug;
  const list = angleEntriesForSlice(state, target, sliceIdx);
  // Shape: { id: 2, p1: {x,y}, vertex: {x,y}, p3: {x,y}, deg: 42.1 }.
  const next = [...list, { ...measurement, id: measurement?.id ?? nextDrawingEntryId(list) }];
  return setAngleEntriesForSlice(state, target, sliceIdx, next);
}

export function deleteAngleMeasurementAt(key, measurement) {
  const { slug, sliceIdx } = parseSliceKey(key);
  const series = state.manifest?.series?.[state.seriesIdx];
  const target = series?.slug === slug ? series : slug;
  const list = angleEntriesForSlice(state, target, sliceIdx);
  const next = measurement?.id != null
    ? deleteDrawingEntryById(list, measurement.id)
    : list.filter((entry) => entry !== measurement);
  setAngleEntriesForSlice(state, target, sliceIdx, next);
}

export function setAnnotateMode(enabled) {
  batch(() => {
    state.annotateMode = !!enabled;
    state.annotationEdit = null;
  });
  return state.annotateMode;
}

export function setAskMode(enabled) {
  batch(() => {
    state.askMode = !!enabled;
    if (!enabled) { state.askMarquee = null; state.askPen = false; }
  });
  return state.askMode;
}

// The pen is a transient sub-tool of ask mode: while on, a drag selects a region;
// off (the default), the viewer pans/scrubs/zooms normally.
export function setAskPen(enabled) {
  state.askPen = !!enabled && state.askMode;
  return state.askPen;
}

export function setAskMarquee(marquee) {
  state.askMarquee = marquee ? { ...marquee } : null;
  return state.askMarquee;
}

export function setAskHistory(entries) {
  state.askHistory = Array.isArray(entries) ? entries : [];
  return state.askHistory;
}

export function setHiddenLabels(hidden) {
  state.hiddenLabels = hidden instanceof Set ? new Set(hidden) : new Set(hidden || []);
  return state.hiddenLabels;
}

function normalizeLabelSet(labels) {
  const out = new Set();
  for (const value of labels instanceof Set ? labels : (labels || [])) {
    const n = Number(value);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

// Locked structures isolate the 3D/2D views to a persistent selection. REPLACE
// the Set reference (don't mutate in place) so state subscribers fire, then
// persist immediately so a lock made just before a refresh survives.
export function setLockedLabels(locked) {
  state.lockedLabels = normalizeLabelSet(locked);
  rememberSeriesViewState();
  scheduleSessionPersist();
  return state.lockedLabels;
}

export function toggleLockedLabel(id) {
  const label = Number(id);
  if (!Number.isFinite(label)) return state.lockedLabels;
  const next = normalizeLabelSet(state.lockedLabels);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  return setLockedLabels(next);
}

// Transient hover preview: a single assignment so the proxy notifies; never
// persisted.
export function setPreviewLabel(id) {
  const label = id == null ? null : Number(id);
  state.previewLabel = Number.isFinite(label) ? label : null;
  return state.previewLabel;
}
