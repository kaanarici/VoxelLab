import { getStateSnapshot } from './core/state.js';

const overlayRegistry = new Map();

export function addOverlay({ id, render }) {
  if (!id || typeof render !== 'function' || overlayRegistry.has(id)) return () => {};
  overlayRegistry.set(id, { id, render });
  return () => overlayRegistry.delete(id);
}

export function drawPluginOverlays(ctx) {
  if (!overlayRegistry.size) return;
  const snapshot = getStateSnapshot();
  for (const overlay of overlayRegistry.values()) {
    try {
      overlay.render(ctx, snapshot);
    } catch (error) {
      console.error(`[plugin overlay:${overlay.id}]`, error);
    }
  }
}
