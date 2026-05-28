import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/state.js');
const {
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
  applyMicroscopyWorkflowRecipe,
  captureMicroscopyWorkflowRecipe,
  validateMicroscopyWorkflowRecipe,
} = await import('../js/microscopy-workflow-recipe.js');

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
  state.mode = host.mode;
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
