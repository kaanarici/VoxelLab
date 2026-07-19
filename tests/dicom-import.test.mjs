/* global URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const {
  injectLocalSeries,
  injectManifestSeries,
} = await import('../js/dicom/dicom-import.js');
const {
  cacheLocalRawVolume,
  clearLocalRawVolume,
  touchLocalRawVolume,
} = await import('../js/local-raw-volume-cache.js');
const { state } = await import('../js/core/state.js');
const { queuePendingDerivedObject } = await import('../js/dicom/dicom-derived-import.js');
const { buildMicroscopyEvidencePackage } = await import('../js/roi/microscopy-evidence-package.js');
const { captureMicroscopyWorkflowRecipe } = await import('../js/microscopy/microscopy-workflow-recipe.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');

function manifestWithSeries(series = []) {
  return { patient: 'anonymous', studyDate: '', series: [...series] };
}

test('injectManifestSeries inserts a new imported entry', () => {
  const manifest = manifestWithSeries();
  const idx = injectManifestSeries(manifest, { slug: 'cloud_job123', name: 'Cloud CT' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].slug, 'cloud_job123');
});

test('injectManifestSeries attaches a derived object that was opened before its source', () => {
  const source = {
    slug: 'pending-dose-source',
    name: 'Dose source',
    sourceSeriesUID: '1.2.pending.source',
    frameOfReferenceUID: '1.2.pending.for',
    width: 2,
    height: 2,
    slices: 2,
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    sliceThickness: 1,
    sliceSpacingRegular: true,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    orientation: [1, 0, 0, 0, 1, 0],
  };
  const dataset = {
    meta: {
      Modality: 'RTDOSE',
      SOPInstanceUID: '1.2.pending.dose',
      SeriesDescription: 'Waiting dose',
      ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
      FrameOfReferenceUID: source.frameOfReferenceUID,
      Rows: 2,
      Columns: 2,
      NumberOfFrames: 1,
      DoseGridScaling: 0.001,
      DoseUnits: 'GY',
      DoseType: 'PHYSICAL',
      DoseSummationType: 'PLAN',
    },
    file: { name: 'waiting-dose.dcm', size: 1024 },
  };
  state._pendingDerivedObjects = [];
  delete state._localDerivedObjects[source.slug];
  delete state._localRtDoseBySlug[source.slug];
  assert.equal(queuePendingDerivedObject(dataset).accepted, true);

  const manifest = manifestWithSeries();
  const idx = injectManifestSeries(manifest, source);

  assert.equal(idx, 0);
  assert.equal(state._pendingDerivedObjects.length, 0);
  assert.equal(state._localRtDoseBySlug[source.slug][0].name, 'Waiting dose');
  assert.equal(state._localDerivedObjects[source.slug]['1.2.pending.dose'].kind, 'rtdose');
});

test('injectManifestSeries attaches a queued SR by stable SeriesInstanceUID after a local slug changes', () => {
  const source = {
    slug: 'local_new_source',
    name: 'Reimported source',
    sourceSeriesUID: '1.2.pending.sr.source',
    width: 8,
    height: 8,
    slices: 2,
  };
  const dataset = {
    meta: {
      Modality: 'SR',
      SOPInstanceUID: '1.2.pending.sr',
      SeriesDescription: 'Waiting measurements',
      ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
      ContentSequence: [{
        ValueType: 'CONTAINER',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
        ContentSequence: [{
          ValueType: 'TEXT',
          ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
          TextValue: 'local_old_source slice 2',
        }, {
          ValueType: 'UIDREF',
          ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series UID' }],
          UID: source.sourceSeriesUID,
        }, {
          ValueType: 'NUM',
          ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
          MeasuredValueSequence: [{ NumericValue: '12.5' }],
        }],
      }],
    },
    file: { name: 'waiting-measurements.dcm', size: 2048 },
  };
  state._pendingDerivedObjects = [];
  delete state._localDerivedObjects[source.slug];
  assert.equal(queuePendingDerivedObject(dataset).accepted, true);

  const manifest = manifestWithSeries();
  injectManifestSeries(manifest, source);

  assert.equal(state._pendingDerivedObjects.length, 0);
  assert.equal(state._localDerivedObjects[source.slug]['1.2.pending.sr'].kind, 'sr');
});

test('injectManifestSeries backfills a canonical compare group for new imports', () => {
  const manifest = manifestWithSeries();

  const idx = injectManifestSeries(manifest, {
    slug: 'cloud_job123',
    name: 'Cloud CT',
    frameOfReferenceUID: '1.2.840.same',
  });

  assert.equal(idx, 0);
  assert.equal(manifest.series[0].group, 'for:1.2.840.same');
});

test('injectManifestSeries updates an existing entry by slug instead of appending', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_job123', name: 'Old Name', hasAnalysis: true },
  ]);

  const idx = injectManifestSeries(manifest, { slug: 'cloud_job123', name: 'New Name' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].name, 'New Name');
  assert.equal(manifest.series[0].hasAnalysis, true);
});

test('injectManifestSeries updates an existing entry by job identity alias', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_old', sourceJobId: 'job_123', description: 'Old result' },
  ]);

  const idx = injectManifestSeries(manifest, { slug: 'cloud_new', job_id: 'job_123', description: 'New result' });

  assert.equal(idx, 0);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].slug, 'cloud_new');
  assert.equal(manifest.series[0].sourceJobId, 'job_123');
  assert.equal(manifest.series[0].job_id, 'job_123');
  assert.equal(manifest.series[0].description, 'New result');
});

test('injectManifestSeries rejects ambiguous matches across slug and job identity', () => {
  const manifest = manifestWithSeries([
    { slug: 'cloud_slug_match', name: 'By slug' },
    { slug: 'cloud_job_match', sourceJobId: 'job_123', name: 'By job id' },
  ]);

  assert.throws(
    () => injectManifestSeries(manifest, { slug: 'cloud_slug_match', sourceJobId: 'job_123', name: 'Ambiguous' }),
    /matches multiple existing entries/i,
  );
});

test('injectManifestSeries rejects derived entries that reference an unknown projection set', () => {
  const manifest = manifestWithSeries();

  assert.throws(
    () => injectManifestSeries(manifest, {
      slug: 'cloud_projection_job123',
      name: 'Derived volume',
      sourceProjectionSetId: 'projection_set_missing',
    }),
    /unknown projection set/i,
  );
});

test('injectManifestSeries appends derived projection reconstructions that share sourceSeriesUID', () => {
  const manifest = manifestWithSeries([
    {
      slug: 'local_projection',
      name: 'Projection source',
      sourceSeriesUID: '1.2.3',
      sourceProjectionSetId: 'projection_set_1',
    },
  ]);
  manifest.projectionSets = [
    {
      id: 'projection_set_1',
      name: 'Projection registry',
      modality: 'XA',
      projectionKind: 'cbct',
      projectionCount: 2,
      reconstructionCapability: 'requires-reconstruction',
      reconstructionStatus: 'reconstructed',
      renderability: '2d',
    },
  ];

  const idx = injectManifestSeries(manifest, {
    slug: 'cloud_projection_job123',
    name: 'Derived volume',
    sourceSeriesUID: '1.2.3',
    sourceProjectionSetId: 'projection_set_1',
  });

  assert.equal(idx, 1);
  assert.deepEqual(manifest.series.map((series) => series.slug), [
    'local_projection',
    'cloud_projection_job123',
  ]);
});

test('injectManifestSeries binds registration results to loaded moving source series', () => {
  const manifest = manifestWithSeries([
    {
      slug: 'fixed_mr',
      name: 'Fixed MR',
      sourceSeriesUID: '1.2.fixed',
      frameOfReferenceUID: '1.2.fixed.for',
    },
    {
      slug: 'moving_mr',
      name: 'Moving MR',
      sourceSeriesUID: '1.2.moving',
      frameOfReferenceUID: '1.2.moving.for',
    },
  ]);

  const idx = injectManifestSeries(manifest, {
    slug: 'cloud_reg_job123',
    name: 'Registered moving',
    sourceSeriesUID: '1.2.moving',
    frameOfReferenceUID: '1.2.fixed.for',
    registration: {
      source: 'modal:rigid_registration',
      fixedSeriesUID: '1.2.fixed',
      movingSeriesUID: '1.2.moving',
      referenceSlug: '1.2.fixed',
      movingSlug: '1.2.moving',
    },
  });

  assert.equal(idx, 2);
  assert.deepEqual(manifest.series[2].derivedObjectBindings, [{
    derivedKind: 'registration',
    frameOfReferenceUID: '1.2.fixed.for',
    sourceSeriesSlug: 'moving_mr',
    requiresRegistration: true,
    affineCompatibility: 'requires-registration',
  }]);
  assert.equal(manifest.series[2].group, 'for:1.2.fixed.for');

  const unloaded = manifestWithSeries([manifest.series[0]]);
  injectManifestSeries(unloaded, {
    slug: 'cloud_reg_job456',
    name: 'Registered moving',
    frameOfReferenceUID: '1.2.fixed.for',
    registration: {
      source: 'modal:rigid_registration',
      fixedSeriesUID: '1.2.fixed',
      movingSeriesUID: '1.2.moving',
    },
  });
  assert.equal(unloaded.series[1].derivedObjectBindings, undefined);
});

test('injectLocalSeries preserves microscopy raw display range provenance on local images', () => {
  const PrevImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      this.src = '';
    }
  };
  state._localStacks = {};
  state._localMicroscopyStacks = {};
  const manifest = manifestWithSeries();
  const entry = {
    slug: 'micro_cells',
    name: 'Cells',
    imageDomain: 'microscopy',
    microscopy: { channelIndex: 0, timeIndex: 0 },
  };
  const canvas = {
    _microscopyDisplayByteRange: [10, 200],
    _microscopyRawRange: [0, 4095],
    _microscopyInvertDisplayRange: true,
    toDataURL: () => 'data:image/png;base64,AA==',
  };

  try {
    injectLocalSeries(manifest, entry, [canvas], null, { '0|0': [canvas] });
  } finally {
    globalThis.Image = PrevImage;
  }

  assert.deepEqual(state._localStacks.micro_cells[0]._microscopyDisplayByteRange, [10, 200]);
  assert.deepEqual(state._localStacks.micro_cells[0]._microscopyRawRange, [0, 4095]);
  assert.equal(state._localStacks.micro_cells[0]._microscopyInvertDisplayRange, true);
});

test('injectLocalSeries replacement cannot reuse stale microscopy stacks, planes, or raw voxels', () => {
  const PrevImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      this.src = '';
    }
  };
  state._localStacks = {};
  state._localMicroscopyStacks = {};
  state._localMicroscopyPlanes = {};
  state._localRawVolumes = {};
  state._localRawVolumeOrder = [];
  const manifest = manifestWithSeries();
  state.manifest = manifest;
  state.seriesIdx = 0;
  const entry = {
    slug: 'micro_replaced',
    name: 'Cells',
    imageDomain: 'microscopy',
    microscopy: { channelIndex: 0, timeIndex: 0 },
  };
  const canvas = { toDataURL: () => 'data:image/png;base64,AA==' };
  const rawPlanes = { '0|0': [{ pixels: new Uint16Array([1]), width: 1, height: 1 }] };
  const rawVolume = new Float32Array([1]);

  try {
    injectLocalSeries(manifest, entry, [canvas], rawVolume, { '0|0': [canvas] }, rawPlanes);
    assert.equal(state._localMicroscopyPlanes.micro_replaced, rawPlanes);
    assert.equal(state._localRawVolumes.micro_replaced, rawVolume);
    assert.deepEqual(state._localRawVolumeOrder, ['micro_replaced']);

    injectLocalSeries(manifest, entry, [canvas], null, null, null);
  } finally {
    globalThis.Image = PrevImage;
  }

  assert.equal(state._localMicroscopyStacks.micro_replaced, undefined);
  assert.equal(state._localMicroscopyPlanes.micro_replaced, undefined);
  assert.equal(state._localRawVolumes.micro_replaced, undefined);
  assert.deepEqual(state._localRawVolumeOrder, []);
  assert.equal(state._localStacks.micro_replaced.length, 1);
  assert.equal(state._localStacks.micro_replaced[0].src, 'data:image/png;base64,AA==');
});

test('injectLocalSeries replacement clears source-keyed analysis state before evidence or recipe capture', () => {
  const PrevImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      this.src = '';
    }
  };
  state._localStacks = {};
  state._localMicroscopyStacks = {};
  state._localMicroscopyPlanes = {};
  state._localRawVolumes = {};
  state._localRawVolumeOrder = [];
  state._microscopyAnalysisLog = {};
  state._microscopyAnalysisResults = {};
  state.measurements = {};
  state.angleMeasurements = {};
  const manifest = manifestWithSeries();
  state.manifest = manifest;
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  const entry = {
    slug: 'micro_analysis_replaced',
    name: 'Cells',
    imageDomain: 'microscopy',
    width: 2,
    height: 2,
    slices: 1,
    sourceFile: 'old.ome.tiff',
    microscopy: { channelIndex: 0, timeIndex: 0, sizeC: 1, sizeT: 1, sourceFiles: ['old.ome.tiff'] },
    microscopyDataset: {
      source: { originalFormat: 'OME-TIFF', files: ['old.ome.tiff'] },
      channels: [{ index: 0, name: 'C1' }],
    },
  };
  const replacement = {
    ...entry,
    sourceFile: 'new.ome.tiff',
    microscopy: { ...entry.microscopy, sourceFiles: ['new.ome.tiff'] },
    microscopyDataset: {
      ...entry.microscopyDataset,
      source: { originalFormat: 'OME-TIFF', files: ['new.ome.tiff'] },
    },
  };
  const canvas = { toDataURL: () => 'data:image/png;base64,AA==' };
  const rawPlanes = { '0|0': [{ pixels: new Uint16Array([1, 2, 3, 4]), width: 2, height: 2 }] };
  const operation = {
    op: 'line-profile',
    inputs: { seriesId: entry.slug, c: 0, z: 0, t: 0, level: 0 },
    measurementDomain: 'raw',
    params: { sampling: 'nearest', line: { x1: 0.5, y1: 0.5, x2: 1.5, y2: 0.5 } },
  };

  try {
    injectLocalSeries(manifest, entry, [canvas], null, { '0|0': [canvas] }, rawPlanes);
    const oldKey = seriesPersistenceKey(manifest.series[0], manifest);
    const newKey = seriesPersistenceKey(replacement, manifest);
    assert.notEqual(newKey, oldKey);
    state._microscopyAnalysisLog[oldKey] = [operation];
    state._microscopyAnalysisResults[oldKey] = { lineProfile: { stale: true } };
    state._microscopyAnalysisLog[newKey] = [{ ...operation, stale: true }];
    state._microscopyAnalysisResults[newKey] = { lineProfile: { stale: true } };
    assert.equal(captureMicroscopyWorkflowRecipe(state).analysisOps[0], operation);
    assert.equal(buildMicroscopyEvidencePackage(state, { snapshotPng: new Uint8Array([1]) }).ok, true);

    injectLocalSeries(manifest, replacement, [canvas], null, { '0|0': [canvas] }, rawPlanes);
    assert.equal(seriesPersistenceKey(manifest.series[0], manifest), newKey);
    assert.equal(state._microscopyAnalysisLog[oldKey], undefined);
    assert.equal(state._microscopyAnalysisResults[oldKey], undefined);
    assert.equal(state._microscopyAnalysisLog[newKey], undefined);
    assert.equal(state._microscopyAnalysisResults[newKey], undefined);
    assert.equal(captureMicroscopyWorkflowRecipe(state).analysisOps, null);
    assert.equal(buildMicroscopyEvidencePackage(state, { snapshotPng: new Uint8Array([1]) }).reason, 'no_analysis_descriptor');

    state._microscopyAnalysisLog[newKey] = [operation];
    state._microscopyAnalysisResults[newKey] = { lineProfile: { stale: true } };
    injectLocalSeries(manifest, replacement, [canvas], null, { '0|0': [canvas] }, rawPlanes);
    assert.equal(state._microscopyAnalysisLog[newKey], undefined);
    assert.equal(state._microscopyAnalysisResults[newKey], undefined);
    assert.equal(captureMicroscopyWorkflowRecipe(state).analysisOps, null);
    assert.equal(buildMicroscopyEvidencePackage(state, { snapshotPng: new Uint8Array([1]) }).reason, 'no_analysis_descriptor');
  } finally {
    globalThis.Image = PrevImage;
  }
});

test('cacheLocalRawVolume evicts least-recently-used entries over budget', () => {
  state._localRawVolumes = {};
  state._localRawVolumeOrder = [];
  state.manifest = { series: [] };
  state.seriesIdx = 0;
  const volumeA = new Float32Array(32);
  const volumeB = new Float32Array(32);
  const volumeC = new Float32Array(32);
  const budget = volumeA.byteLength * 2;

  cacheLocalRawVolume('local_a', volumeA, { maxBytes: budget });
  cacheLocalRawVolume('local_b', volumeB, { maxBytes: budget });
  touchLocalRawVolume('local_a');
  cacheLocalRawVolume('local_c', volumeC, { maxBytes: budget });

  assert.deepEqual(Object.keys(state._localRawVolumes).sort(), ['local_a', 'local_c']);
  assert.deepEqual(state._localRawVolumeOrder, ['local_a', 'local_c']);
});

test('clearLocalRawVolume removes stale data and every LRU occurrence', () => {
  state._localRawVolumes = { local_a: new Float32Array([1]) };
  state._localRawVolumeOrder = ['local_a', 'local_b', 'local_a'];

  assert.equal(clearLocalRawVolume('local_a'), true);
  assert.equal(state._localRawVolumes.local_a, undefined);
  assert.deepEqual(state._localRawVolumeOrder, ['local_b']);
  assert.equal(clearLocalRawVolume('local_a'), false);
});
