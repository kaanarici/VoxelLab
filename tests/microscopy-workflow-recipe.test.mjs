import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/core/state.js');
const {
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
  applyMicroscopyWorkflowRecipe,
  captureMicroscopyWorkflowRecipe,
  validateMicroscopyWorkflowRecipe,
} = await import('../js/microscopy/microscopy-workflow-recipe.js');
const { angleEntriesForSlice, setAngleEntriesForSlice, setRoiEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const { roiResultRows } = await import('../js/roi/roi-results.js');

function image(rawRange = [0, 255]) {
  return { _microscopyRawRange: rawRange, _microscopyDisplayByteRange: [0, 255] };
}

function fixture() {
  const stacks = {
    '0|0': [image([0, 100]), image([0, 100])],
    '1|0': [image([10, 200]), image([10, 200])],
    '0|1': [image([0, 100]), image([0, 100])],
    '1|1': [image([10, 200]), image([10, 200])],
  };
  const series = {
    slug: 'cells_recipe',
    name: 'cells recipe',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 2,
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.0015,
    sliceThickness: 0.0015,
    _spacingKnown: true,
    _sliceSpacingKnown: true,
    microscopy: {
      sizeZ: 2,
      sizeC: 2,
      sizeT: 2,
      channelIndex: 0,
      channelName: 'DAPI',
      timeIndex: 0,
      physicalUnit: 'µm',
      composite: { enabled: false, channels: [true, true] },
    },
    microscopyDataset: {
      source: { originalFormat: 'OME-TIFF', warnings: [] },
      axes: [
        { name: 'z', size: 2 },
        { name: 'c', size: 2 },
        { name: 't', size: 2 },
      ],
      channels: [
        { index: 0, name: 'DAPI', color: '#0000FF', displayRange: [0, 100], displayRangeSource: 'metadata' },
        { index: 1, name: 'GFP', color: '#00FF00', displayRange: [10, 200], displayRangeSource: 'metadata' },
      ],
    },
  };
  return {
    manifest: { series: [series] },
    seriesIdx: 0,
    sliceIdx: 0,
    window: 255,
    level: 128,
    invertDisplay: false,
    colormap: 'grayscale',
    imgs: stacks['0|0'],
    _localStacks: { cells_recipe: stacks['0|0'] },
    _localMicroscopyStacks: { cells_recipe: stacks },
    measurements: {},
    angleMeasurements: {},
    mode: '2d',
  };
}

function resetHost(host) {
  state.manifest = host.manifest;
  state.seriesIdx = host.seriesIdx;
  state.sliceIdx = host.sliceIdx;
  state.window = host.window;
  state.level = host.level;
  state.invertDisplay = host.invertDisplay;
  state.colormap = host.colormap;
  state.imgs = host.imgs;
  state._localStacks = host._localStacks;
  state._localMicroscopyStacks = host._localMicroscopyStacks;
  state.measurements = host.measurements;
  state.angleMeasurements = host.angleMeasurements;
  state.mode = host.mode;
}

function markTiffSequence(host) {
  const series = host.manifest.series[0];
  series.sequence = 'TIFF sequence';
  series.microscopyDataset.source.originalFormat = 'TIFF sequence';
  return series;
}

test('captureMicroscopyWorkflowRecipe emits deterministic microscopy contract fields', () => {
  const host = fixture();
  resetHost(host);
  const series = state.manifest.series[0];
  series.microscopy.channelIndex = 1;
  series.microscopy.channelName = 'GFP';
  series.microscopy.timeIndex = 1;
  series.microscopy.composite = { enabled: true, channels: [false, true] };
  series.microscopyDataset.channels[1].displayColor = '#AA00CC';
  series.microscopyDataset.channels[1].displayColorSource = 'user';
  state.sliceIdx = 1;
  state.window = 190;
  state.level = 80;
  state.invertDisplay = true;
  state.colormap = 'hot';

  const recipe = captureMicroscopyWorkflowRecipe(state);

  assert.equal(recipe.schema, MICROSCOPY_WORKFLOW_RECIPE_SCHEMA);
  assert.equal(recipe.target.imageDomain, 'microscopy');
  assert.deepEqual(recipe.target.geometry, {
    width: 16,
    height: 16,
    slices: 2,
    sizeZ: 2,
    sizeC: 2,
    sizeT: 2,
  });
  assert.deepEqual(recipe.view, {
    window: 190,
    level: 80,
    invertDisplay: true,
    colormap: 'hot',
    sliceIndex: 1,
  });
  assert.equal(recipe.stack.channelIndex, 1);
  assert.equal(recipe.stack.timeIndex, 1);
  assert.deepEqual(recipe.stack.compositeChannels, [false, true]);
  assert.equal(recipe.channels[1].color, '#AA00CC');
  assert.deepEqual(recipe.calibration, {
    xyKnown: true,
    rowMm: 0.00025,
    colMm: 0.0005,
    zKnown: true,
    zMm: 0.0015,
    displayUnit: 'µm',
    trust: 'Trusted metadata',
  });
});

test('applyMicroscopyWorkflowRecipe replays stack, channel styling, and view state atomically', () => {
  const host = fixture();
  resetHost(host);
  const series = state.manifest.series[0];
  const recipe = {
    schema: MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: { width: 16, height: 16, sizeZ: 2, sizeC: 2, sizeT: 2 },
    },
    requirements: { calibrationRequired: true, measurementPrerequisite: 'none' },
    view: { window: 210, level: 60, invertDisplay: true, colormap: 'viridis', sliceIndex: 1 },
    stack: { channelIndex: 1, timeIndex: 1, compositeEnabled: true, compositeChannels: [true, false] },
    channels: [
      { index: 0, color: '#0000FF', displayRange: [0, 90] },
      { index: 1, color: '#AA00CC', displayRange: [20, 180] },
    ],
    exportPreferences: { requireTrustedMeasurements: false },
  };

  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.deepEqual(result, { ok: true, code: '', message: '' });
  assert.equal(state.window, 210);
  assert.equal(state.level, 60);
  assert.equal(state.invertDisplay, true);
  assert.equal(state.colormap, 'viridis');
  assert.equal(series.microscopy.channelIndex, 1);
  assert.equal(series.microscopy.timeIndex, 1);
  assert.equal(state.sliceIdx, 1);
  assert.equal(series.microscopyDataset.channels[1].displayColor, '#AA00CC');
  assert.deepEqual(series.microscopyDataset.channels[1].displayRange, [20, 180]);
  assert.equal(series.microscopy.composite.enabled, true);
  assert.deepEqual(series.microscopy.composite.channels, [true, false]);
});

test('validateMicroscopyWorkflowRecipe fails closed on missing calibration without mutating scope', () => {
  const host = fixture();
  host.manifest.series[0].pixelSpacing = [0, 0];
  host.manifest.series[0]._spacingKnown = false;
  resetHost(host);
  const before = {
    channelIndex: state.manifest.series[0].microscopy.channelIndex,
    timeIndex: state.manifest.series[0].microscopy.timeIndex,
    sliceIdx: state.sliceIdx,
  };
  const recipe = {
    schema: MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    target: { imageDomain: 'microscopy', geometry: { width: 16, height: 16, sizeZ: 2, sizeC: 2, sizeT: 2 } },
    requirements: { calibrationRequired: true, measurementPrerequisite: 'none' },
    view: { sliceIndex: 0 },
    stack: { channelIndex: 1, timeIndex: 1, compositeEnabled: false, compositeChannels: [true, true] },
    channels: [{ index: 0 }, { index: 1 }],
  };

  const check = validateMicroscopyWorkflowRecipe(recipe, state);

  assert.equal(check.ok, false);
  assert.equal(check.code, 'missing_calibration');
  assert.deepEqual({
    channelIndex: state.manifest.series[0].microscopy.channelIndex,
    timeIndex: state.manifest.series[0].microscopy.timeIndex,
    sliceIdx: state.sliceIdx,
  }, before);
});

test('validateMicroscopyWorkflowRecipe rejects same-shaped recipes from different source formats', () => {
  const host = fixture();
  resetHost(host);
  const recipe = {
    schema: MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'ImageJ TIFF',
      geometry: { width: 16, height: 16, sizeZ: 2, sizeC: 2, sizeT: 2 },
    },
    requirements: { calibrationRequired: true, measurementPrerequisite: 'none' },
    view: { sliceIndex: 0 },
    stack: { channelIndex: 1, timeIndex: 1, compositeEnabled: false, compositeChannels: [true, true] },
    channels: [{ index: 0 }, { index: 1 }],
  };

  const check = validateMicroscopyWorkflowRecipe(recipe, state);

  assert.equal(check.ok, false);
  assert.equal(check.code, 'incompatible_dimensions');
  assert.equal(state.manifest.series[0].microscopy.channelIndex, 0);
  assert.equal(state.manifest.series[0].microscopy.timeIndex, 0);
});

test('applyMicroscopyWorkflowRecipe restores embedded ROI results without a separate sidecar', () => {
  const measuredHost = fixture();
  resetHost(measuredHost);
  setRoiEntriesForSlice('cells_recipe', 0, [{
    id: 4,
    shape: 'polygon',
    pts: [[1, 1], [9, 1], [9, 7], [1, 7]],
    stats: { pixels: 48, area_mm2: 0.000006 },
  }]);
  const recipe = captureMicroscopyWorkflowRecipe(state);
  assert.equal(recipe.requirements.measurementPrerequisite, 'results-present');
  assert.equal(recipe.exportPreferences.requireTrustedMeasurements, true);
  assert.equal(recipe.exportPreferences.embeddedRoiResults, true);
  assert.equal(recipe.roiResults.rows.length, 1);
  setRoiEntriesForSlice('cells_recipe', 0, []);

  const replayHost = fixture();
  resetHost(replayHost);
  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.deepEqual(result, { ok: true, code: '', message: '' });
  const [row] = roiResultRows(state);
  assert.equal(row.kind, 'polygon');
  assert.equal(row.objectId, 'roi:cells_recipe|0:4');
  assert.equal(row.channelZeroIndex, 0);
  assert.equal(row.timeZeroIndex, 0);
  assert.deepEqual(applyMicroscopyWorkflowRecipe(recipe, state), { ok: true, code: '', message: '' });
  assert.equal(roiResultRows(state).length, 1);
});

test('applyMicroscopyWorkflowRecipe rejects partial embedded ROI results before mutating state', () => {
  const measuredHost = fixture();
  resetHost(measuredHost);
  setRoiEntriesForSlice('cells_recipe', 0, [{
    id: 5,
    shape: 'polygon',
    pts: [[1, 1], [9, 1], [9, 7], [1, 7]],
    stats: { pixels: 48, area_mm2: 0.000006 },
  }]);
  const recipe = captureMicroscopyWorkflowRecipe(state);
  recipe.roiResults.rows.push({
    ...recipe.roiResults.rows[0],
    roiObjectId: 'roi:cells_recipe|0:clipped',
    label: 'Clipped embedded ROI',
    points: [[1, 1], [99, 1], [1, 7]],
  });
  recipe.view = { window: 111, level: 44, invertDisplay: true, colormap: 'hot', sliceIndex: 1 };
  recipe.stack = { channelIndex: 1, timeIndex: 1, compositeEnabled: true, compositeChannels: [false, true] };
  setRoiEntriesForSlice('cells_recipe', 0, []);

  const replayHost = fixture();
  resetHost(replayHost);
  const series = state.manifest.series[0];
  const before = {
    window: state.window,
    level: state.level,
    invertDisplay: state.invertDisplay,
    colormap: state.colormap,
    sliceIdx: state.sliceIdx,
    channelIndex: series.microscopy.channelIndex,
    timeIndex: series.microscopy.timeIndex,
    rows: roiResultRows(state).length,
  };

  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'roi_results_incompatible_rows');
  assert.equal(result.message, 'Recipe ROI results include rows that do not fit this microscopy stack.');
  assert.deepEqual({
    window: state.window,
    level: state.level,
    invertDisplay: state.invertDisplay,
    colormap: state.colormap,
    sliceIdx: state.sliceIdx,
    channelIndex: series.microscopy.channelIndex,
    timeIndex: series.microscopy.timeIndex,
    rows: roiResultRows(state).length,
  }, before);
});

test('applyMicroscopyWorkflowRecipe restores embedded angle measurements without duplicating replay', () => {
  const measuredHost = fixture();
  resetHost(measuredHost);
  setRoiEntriesForSlice('cells_recipe', 0, []);
  setAngleEntriesForSlice(state, 'cells_recipe', 1, [{
    id: 11,
    label: 'branch-angle',
    p1: { x: 6, y: 4 },
    vertex: { x: 2, y: 4 },
    p3: { x: 6, y: 8 },
    deg: 26.565051177,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 1 },
    createdAt: '2026-01-02T03:04:05.000Z',
  }]);
  const recipe = captureMicroscopyWorkflowRecipe(state);
  assert.equal(recipe.requirements.measurementPrerequisite, 'results-present');
  assert.equal(recipe.exportPreferences.embeddedAngleMeasurements, true);
  assert.equal(recipe.exportPreferences.requireTrustedMeasurements, false);
  assert.equal(recipe.angleMeasurements.rows.length, 1);
  assert.deepEqual(recipe.angleMeasurements.rows[0], {
    angleObjectId: 'angle:cells_recipe|1:11',
    sliceIndex: 1,
    label: 'branch-angle',
    angleDeg: 26.565051177,
    points: {
      p1: { x: 6, y: 4 },
      vertex: { x: 2, y: 4 },
      p3: { x: 6, y: 8 },
    },
    channelIndex: 1,
    channelName: 'GFP',
    timeIndex: 1,
    createdAt: '2026-01-02T03:04:05.000Z',
  });
  setAngleEntriesForSlice(state, 'cells_recipe', 1, []);

  const replayHost = fixture();
  resetHost(replayHost);
  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.deepEqual(result, { ok: true, code: '', message: '' });
  const [angle] = angleEntriesForSlice(state, 'cells_recipe', 1);
  assert.equal(angle.label, 'branch-angle');
  assert.equal(angle.deg, 26.565051177);
  assert.deepEqual(angle.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 1 });
  assert.deepEqual([angle.p1, angle.vertex, angle.p3], [
    { x: 6, y: 4 },
    { x: 2, y: 4 },
    { x: 6, y: 8 },
  ]);
  assert.equal(angle.recipeAngleObjectId, 'angle:cells_recipe|1:11');
  assert.deepEqual(applyMicroscopyWorkflowRecipe(recipe, state), { ok: true, code: '', message: '' });
  assert.equal(angleEntriesForSlice(state, 'cells_recipe', 1).length, 1);
});

test('applyMicroscopyWorkflowRecipe replays TIFF sequence calibration before embedded ROI results', () => {
  const measuredHost = fixture();
  markTiffSequence(measuredHost);
  resetHost(measuredHost);
  setRoiEntriesForSlice('cells_recipe', 0, [{
    id: 9,
    shape: 'polygon',
    pts: [[1, 1], [9, 1], [9, 7], [1, 7]],
    stats: { pixels: 48, area_mm2: 0.000006 },
  }]);
  const recipe = captureMicroscopyWorkflowRecipe(state);
  assert.equal(recipe.calibration.trust, 'Manual calibration');
  setRoiEntriesForSlice('cells_recipe', 0, []);

  const replayHost = fixture();
  const replaySeries = markTiffSequence(replayHost);
  replaySeries.pixelSpacing = [0, 0];
  replaySeries.sliceSpacing = 0;
  replaySeries.sliceThickness = 0;
  replaySeries._spacingKnown = false;
  replaySeries._sliceSpacingKnown = false;
  replaySeries.microscopy.physicalUnit = '';
  replaySeries.microscopy.physicalSizeX = 0;
  replaySeries.microscopy.physicalSizeY = 0;
  replaySeries.microscopy.physicalSizeZ = 0;
  replaySeries.microscopyDataset.source.warnings = ['missing_xy_physical_size', 'missing_z_physical_size'];
  resetHost(replayHost);

  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.deepEqual(result, { ok: true, code: '', message: '' });
  assert.deepEqual(replaySeries.pixelSpacing, [0.00025, 0.0005]);
  assert.equal(replaySeries._spacingKnown, true);
  assert.equal(replaySeries.sliceSpacing, 0.0015);
  assert.equal(replaySeries.sliceThickness, 0.0015);
  assert.equal(replaySeries._sliceSpacingKnown, true);
  assert.equal(replaySeries.microscopy.physicalUnit, 'µm');
  assert.equal(replaySeries.microscopy.calibrationSource, 'manual');
  assert.equal(replaySeries.microscopy.physicalSizeX, 0.5);
  assert.equal(replaySeries.microscopy.physicalSizeY, 0.25);
  assert.equal(replaySeries.microscopy.physicalSizeZ, 1.5);
  assert.deepEqual(replaySeries.microscopyDataset.source.warnings, []);
  const [row] = roiResultRows(state);
  assert.equal(row.kind, 'polygon');
  assert.equal(row.objectId, 'roi:cells_recipe|0:9');
});

test('applyMicroscopyWorkflowRecipe rejects mismatched embedded ROI results before mutating state', () => {
  const measuredHost = fixture();
  resetHost(measuredHost);
  setRoiEntriesForSlice('cells_recipe', 0, [{
    id: 6,
    shape: 'polygon',
    pts: [[1, 1], [9, 1], [9, 7], [1, 7]],
    stats: { pixels: 48, area_mm2: 0.000006 },
  }]);
  const recipe = captureMicroscopyWorkflowRecipe(state);
  recipe.roiResults.calibration.rowMm = 0.123;
  recipe.view = { window: 111, level: 44, invertDisplay: true, colormap: 'hot', sliceIndex: 1 };
  recipe.stack = { channelIndex: 1, timeIndex: 1, compositeEnabled: true, compositeChannels: [false, true] };
  recipe.channels[1].color = '#AA00CC';
  setRoiEntriesForSlice('cells_recipe', 0, []);

  const replayHost = fixture();
  resetHost(replayHost);
  const series = state.manifest.series[0];
  series.microscopyDataset.channels[1].displayColor = '#00FF00';
  const before = {
    window: state.window,
    level: state.level,
    invertDisplay: state.invertDisplay,
    colormap: state.colormap,
    sliceIdx: state.sliceIdx,
    channelIndex: series.microscopy.channelIndex,
    timeIndex: series.microscopy.timeIndex,
    channelColor: series.microscopyDataset.channels[1].displayColor,
    rows: roiResultRows(state).length,
  };

  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'roi_results_bundle_calibration_mismatch');
  assert.deepEqual({
    window: state.window,
    level: state.level,
    invertDisplay: state.invertDisplay,
    colormap: state.colormap,
    sliceIdx: state.sliceIdx,
    channelIndex: series.microscopy.channelIndex,
    timeIndex: series.microscopy.timeIndex,
    channelColor: series.microscopyDataset.channels[1].displayColor,
    rows: roiResultRows(state).length,
  }, before);
});

test('applyMicroscopyWorkflowRecipe rejects invalid channel styling without mutating display state', () => {
  const host = fixture();
  resetHost(host);
  const series = state.manifest.series[0];
  series.microscopyDataset.channels[1].displayColor = '#00FF00';
  const recipe = {
    schema: MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: { width: 16, height: 16, sizeZ: 2, sizeC: 2, sizeT: 2 },
    },
    requirements: { calibrationRequired: true, measurementPrerequisite: 'none' },
    view: { window: 111, level: 44, invertDisplay: true, colormap: 'hot', sliceIndex: 1 },
    stack: { channelIndex: 1, timeIndex: 1, compositeEnabled: false, compositeChannels: [true, true] },
    channels: [
      { index: 0, color: '#0000FF' },
      { index: 1, color: 'not-a-color' },
    ],
  };

  const result = applyMicroscopyWorkflowRecipe(recipe, state);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_channel_color');
  assert.equal(state.window, 255);
  assert.equal(state.level, 128);
  assert.equal(state.invertDisplay, false);
  assert.equal(state.colormap, 'grayscale');
  assert.equal(state.sliceIdx, 0);
  assert.equal(series.microscopy.channelIndex, 0);
  assert.equal(series.microscopy.timeIndex, 0);
  assert.equal(series.microscopyDataset.channels[1].displayColor, '#00FF00');
});
