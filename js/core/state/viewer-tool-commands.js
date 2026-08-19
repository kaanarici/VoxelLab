import { batch, state } from '../state.js';
import { rememberSeriesViewState } from './series-view-memory.js';
import { scheduleSessionPersist } from './session-persistence.js';

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

export function setAnnotateMode(enabled) {
  batch(() => {
    state.annotateMode = !!enabled;
  });
  return state.annotateMode;
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
