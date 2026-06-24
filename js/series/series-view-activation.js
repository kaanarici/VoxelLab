const MPR_MODES = new Set(['mpr', 'mpr3d']);
const THREE_MODES = new Set(['3d', 'mpr3d']);

export function activateSeriesViewMode(selection, series, viewer) {
  const mode = selection?.mode || '2d';
  viewer.setMode(mode);
  if (MPR_MODES.has(mode)) {
    viewer.syncMprSliceIndex?.(series);
  }
  if (THREE_MODES.has(mode)) {
    viewer.ensureThree?.();
    viewer.syncThreeSurfaceState?.(series);
    viewer.updateClipReadouts?.();
  }
  return {
    mode,
    mprActive: MPR_MODES.has(mode),
    threeActive: THREE_MODES.has(mode),
  };
}
