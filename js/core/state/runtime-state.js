import { createViewerSessionState, overlayImgsResetValue, RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE } from '../viewer-session-shape.js';

function overlayCacheInitialState() {
  const out = {};
  for (const keys of Object.values(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)) {
    out[keys.imgs] = overlayImgsResetValue(keys);
    out[keys.voxels] = null;
  }
  return out;
}

export function createInitialRuntimeState() {
  return {
    imgs: [],

    cmpStacks: {},

    viewerSession: createViewerSessionState(),

    threeRuntime: {
      renderer: null,
      scene: null,
      camera: null,
      controls: null,
      mesh: null,
      startLoop: null,
      stopLoop: null,
      requestRender: null,
      renderNow: null,
      seriesIdx: -1,
      variant: '',
      dataKey: '',
      previewShown: false,
    },

    _localStacks: {},
    _localMicroscopyStacks: {},

    _localMicroscopyPlanes: {},

    _microscopyAnalysisLog: {},

    _microscopyAnalysisResults: {},
    _localRawVolumes: {},

    _localRawVolumeOrder: [],
    _localRegionMetaBySlug: {},
    _localRegionLabelSlicesBySlug: {},
    _localDerivedObjects: {},
    _localRtDoseBySlug: {},

    _seriesOverlayHints: {},

    _pendingDerivedObjects: [],

    _seriesVolumeCacheEntries: [],

    ...overlayCacheInitialState(),

    voxels: null,
    voxelsKey: '',

    hrVoxels: null,
    hrKey: '',
    hrLoading: null,
    hrLoadingKey: '',
    hrAbortController: null,
  };
}
