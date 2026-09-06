export const RUNTIME_OVERLAY_KIND_BY_TYPE = {
  seg: 'tissue',
  regions: 'labels',
  sym: 'heatmap',
  fusion: 'fusion',
};

export const RUNTIME_OVERLAY_TYPE_BY_KIND = Object.fromEntries(
  Object.entries(RUNTIME_OVERLAY_KIND_BY_TYPE).map(([type, kind]) => [kind, type]),
);

export const RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE = Object.freeze({
  seg: Object.freeze({
    imgs: 'segImgs',
    voxels: 'segVoxels',
    bytes: 'segBytes',
    availableFlag: 'hasSeg',
    refuseInOverlayStack: false,
    needsRegionMeta: false,
    usesLocalRegionVolume: false,
    sliceBytes: 'image',
    requiresCompleteSliceImage: false,
    emptyImgs: true,
    sample: 'nearest',
    peerSlugField: null,
    publicUrlBaseField: null,
    publicMetaUrlField: null,
    outputShort: 'tissue',
    outputVerbose: 'tissue overlay',
  }),
  regions: Object.freeze({
    imgs: 'regionImgs',
    voxels: 'regionVoxels',
    bytes: 'regionBytes',
    availableFlag: 'hasRegions',
    refuseInOverlayStack: false,
    needsRegionMeta: true,
    usesLocalRegionVolume: true,
    sliceBytes: 'voxels',
    requiresCompleteSliceImage: false,
    emptyImgs: true,
    sample: 'nearest',
    peerSlugField: null,
    publicUrlBaseField: 'regionUrlBase',
    publicMetaUrlField: 'regionMetaUrl',
    outputShort: 'labels',
    outputVerbose: 'anatomy labels',
  }),
  sym: Object.freeze({
    imgs: 'symImgs',
    voxels: 'symVoxels',
    bytes: 'symBytes',
    availableFlag: 'hasSym',
    refuseInOverlayStack: false,
    needsRegionMeta: false,
    usesLocalRegionVolume: false,
    sliceBytes: 'image',
    requiresCompleteSliceImage: false,
    emptyImgs: true,
    sample: 'linear',
    peerSlugField: null,
    publicUrlBaseField: null,
    publicMetaUrlField: null,
    outputShort: 'heatmap',
    outputVerbose: 'symmetry heatmap',
  }),
  fusion: Object.freeze({
    imgs: 'fusionImgs',
    voxels: 'fusionVoxels',
    bytes: 'fusionBytes',
    availableFlag: null,
    refuseInOverlayStack: true,
    needsRegionMeta: false,
    usesLocalRegionVolume: false,
    sliceBytes: 'image',
    requiresCompleteSliceImage: true,
    emptyImgs: false,
    sample: 'linear',
    peerSlugField: 'fusionSlug',
    publicUrlBaseField: null,
    publicMetaUrlField: null,
    outputShort: '',
    outputVerbose: '',
  }),
});

export const OVERLAY_ENABLE_KINDS = Object.freeze(
  Object.entries(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)
    .filter(([, keys]) => keys.availableFlag)
    .map(([type]) => RUNTIME_OVERLAY_KIND_BY_TYPE[type]),
);

export function overlayEnableFromSeriesFlags(series) {
  const overlays = {};
  for (const kind of OVERLAY_ENABLE_KINDS) overlays[kind] = false;
  for (const [type, keys] of Object.entries(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)) {
    if (!keys.availableFlag) continue;
    overlays[RUNTIME_OVERLAY_KIND_BY_TYPE[type]] = !!series?.[keys.availableFlag];
  }
  return overlays;
}

export function overlayEnableSnapshot(source) {
  const overlays = { useBrain: !!source?.useBrain };
  for (const kind of OVERLAY_ENABLE_KINDS) overlays[kind] = !!source?.[kind];
  return overlays;
}

export function applyOverlayEnableSnapshot(target, overlays) {
  if (!target || !overlays) return target;
  target.useBrain = !!overlays.useBrain;
  for (const kind of OVERLAY_ENABLE_KINDS) target[kind] = !!overlays[kind];
  return target;
}

export function overlayOutputLabel(kind, style = 'verbose') {
  const type = RUNTIME_OVERLAY_TYPE_BY_KIND[kind];
  const keys = type ? RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE[type] : null;
  if (!keys) return '';
  return style === 'short' ? keys.outputShort : keys.outputVerbose;
}

export function overlayImgsResetValue(keys) {
  return keys.emptyImgs ? [] : null;
}

export function dumpOverlayContract() {
  return {
    overlays: Object.entries(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)
      .map(([loaderDir, keys]) => ({
        loaderDir,
        persistKind: RUNTIME_OVERLAY_KIND_BY_TYPE[loaderDir],
        imgs: keys.imgs,
        voxels: keys.voxels,
        bytes: keys.bytes,
        availableFlag: keys.availableFlag,
        refuseInOverlayStack: keys.refuseInOverlayStack,
        needsRegionMeta: keys.needsRegionMeta,
        usesLocalRegionVolume: keys.usesLocalRegionVolume,
        sliceBytes: keys.sliceBytes,
        requiresCompleteSliceImage: keys.requiresCompleteSliceImage,
        emptyImgs: keys.emptyImgs,
        sample: keys.sample,
        peerSlugField: keys.peerSlugField,
        publicUrlBaseField: keys.publicUrlBaseField,
        publicMetaUrlField: keys.publicMetaUrlField,
        outputShort: keys.outputShort,
        outputVerbose: keys.outputVerbose,
      }))
      .sort((a, b) => a.loaderDir.localeCompare(b.loaderDir)),
  };
}

export const VIEWER_SESSION_STAGE_ORDER = [
  'idle',
  'first-slice',
  'base-volume',
  'orthogonal-ready',
  'overlay-ready',
  'quality-ready',
  '3d-ready',
];

function createReadinessState() {
  return {
    stage: 'idle',
    firstSlice: false,
    baseVolume: false,
    orthogonalReady: false,
    overlayReady: false,
    qualityReady: false,
    threeReady: false,
    sliceReady: false,
    mprReady: false,
    twoDReady: false,
    compareReady: false,
  };
}

function createOverlaySessionKindState() {
  return {
    available: false,
    enabled: false,
    currentSliceReady: false,
    voxelsReady: false,
    volumeReady: false,
    metaReady: false,
    blockingReason: '',
  };
}

export function createViewerSessionState({
  slug = '',
  seriesIdx = -1,
  requestId = 0,
} = {}) {
  return {
    slug,
    seriesIdx,
    requestId,
    baseSource: '',
    firstSliceIdx: -1,
    overlaySession: Object.fromEntries(
      Object.values(RUNTIME_OVERLAY_KIND_BY_TYPE).map((kind) => [kind, createOverlaySessionKindState()]),
    ),
    readiness: createReadinessState(),
  };
}
