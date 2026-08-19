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

    // Shape: { x: 0, y: 0, z: 0, projectionMode: "thin", slabThicknessMm: 0, viewports: { ax: { zoom: 1, tx: 0, ty: 0 } } }.
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

    // Shape: { viewport: { zoom: 1, tx: 0, ty: 0 } } for linked Compare panes.
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
    // Anatomy-label isolate/lock selection. lockedLabels persists per-series;
    // previewLabel is transient but remains visible to overlay snapshots.
    lockedLabels: new Set(),
    previewLabel: null,

    colormap: 'grayscale',

    // null = auto-group by geometry; string[] = user-picked series slugs
    cmpManualSlugs: null,
  };
}
