export function createInitialAppModel() {
  return {
    manifest: null,
    seriesIdx: 0,
    sliceIdx: 0,
    loaded: false,
    window: 255,
    level: 128,
    invertDisplay: false,
    mode: '2d',

    mpr: {
      x: 0,
      y: 0,
      z: 0,
      quality: 'quality',
      gpuEnabled: true,
      projectionMode: 'thin',
      slabThicknessMm: 0,
      obYaw: 0,
      obPitch: 30,
      viewports: {
        ax: { zoom: 1, tx: 0, ty: 0 },
        co: { zoom: 1, tx: 0, ty: 0 },
        sa: { zoom: 1, tx: 0, ty: 0 },
        ob: { zoom: 1, tx: 0, ty: 0 },
      },
    },

    three: {
      lowT: 0.08,
      highT: 1.0,
      intensity: 1.6,
      clipMin: [0, 0, 0],
      clipMax: [1, 1, 1],
      clipPlaneEnabled: false,
      clipPlaneDepth: 0.5,
      clipPlaneInvert: false,
      renderMode: 'alpha',
    },

    overlays: {
      useBrain: false,
      tissue: false,
      labels: false,
      heatmap: false,
      regionMeta: null,
      stats: null,
      analysis: null,
      analysisBusy: false,
      fusionSlug: null,
      fusionOpacity: 0.5,
      overlayOpacity: 0.55,
    },

    compare: {
      viewport: { zoom: 1, tx: 0, ty: 0 },
    },

    annotateMode: false,

    selectRequestId: 0,
    seriesViewMemory: {},

    zoom: 1,
    tx: 0,
    ty: 0,

    cineFps: 12,

    measureMode: false,
    measurePending: null,
    measurements: {},
    angleMode: false,
    anglePending: null,
    angleMeasurements: {},
    rois: {},
    notes: {},
    hiddenLabels: new Set(),
    lockedLabels: new Set(),

    colormap: 'grayscale',

    cmpManualSlugs: null,
  };
}
