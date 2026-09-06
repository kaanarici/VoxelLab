import { state } from './state.js';

export function isMprActive() {
  return state.mode === 'mpr' || state.mode === 'mpr3d';
}

export function is3dActive() {
  return state.mode === '3d' || state.mode === 'mpr3d';
}
