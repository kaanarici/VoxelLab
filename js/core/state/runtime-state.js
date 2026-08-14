import { createViewerSessionState } from '../../runtime/viewer-session-shape.js';

export function createInitialRuntimeState() {
  return {
    imgs: [],

    cmpStacks: {},

    // Shape: { slug: "", seriesIdx: -1, readiness: { stage: "idle" } }.
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
    // Shape: { [slug]: { "c|t": [{ pixels: Float32Array, width, height }] z-sorted } }.
    // Raw single-channel plane samples retained for microscopy analysis (threshold/particles).
    // Null per-slug when retention exceeds the byte budget (fail-closed, no lossy fallback).
    _localMicroscopyPlanes: {},
    // Shape: { [seriesPersistenceKey]: AnalysisOpDescriptor[] } for deterministic recipe replay + Tier-2 cross-validation.
    _microscopyAnalysisLog: {},
    // Shape: { [seriesPersistenceKey]: { lineProfile?, colocalization? } }; derived Analyze-panel results.
    _microscopyAnalysisResults: {},
    _localRawVolumes: {},
    // Shape: ["local_ct_a", "local_ct_b"] ordered least -> most recently used.
    _localRawVolumeOrder: [],
    _localRegionMetaBySlug: {},
    _localRegionLabelSlicesBySlug: {},
    _localDerivedObjects: {},
    _localRtDoseBySlug: {},
    // Parsed local SEG/RTSTRUCT/RTDOSE/SR objects waiting for their source series.
    // Session-only by design: these may contain image-derived data and are never persisted.
    _pendingDerivedObjects: [],
    // Shape: [{ key: "t2_axial|base", slug: "t2_axial", variant: "base", voxels, hrVoxels, segVoxels, ... }].
    _seriesVolumeCacheEntries: [],

    segImgs: [],
    segVoxels: null,
    symImgs: [],
    symVoxels: null,
    regionImgs: [],
    regionVoxels: null,
    fusionImgs: null,
    fusionVoxels: null,

    voxels: null,
    voxelsKey: '',

    hrVoxels: null,
    hrKey: '',
    hrLoading: null,
    hrLoadingKey: '',
    hrAbortController: null,
  };
}
