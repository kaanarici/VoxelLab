import { state } from './core/state.js';
import { readOverlayData } from './overlay/overlay-data.js';

export function getRawSliceData(sliceIdx = state.sliceIdx, series = state.manifest?.series?.[state.seriesIdx]) {
  if (!series || !state.imgs?.[sliceIdx]?.complete) return null;
  try {
    return readOverlayData(state.imgs[sliceIdx], series.width, series.height);
  } catch {
    return null;
  }
}
