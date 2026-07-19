import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  applyManualMicroscopyCalibration,
  activateMicroscopyStackPosition,
  canSetMicroscopyChannelDisplayRange,
  microscopyHyperstackState,
  renderMicroscopyHyperstackControls,
  setMicroscopyChannelDisplayColor,
  setMicroscopyChannelDisplayRange,
  stepMicroscopyStackPosition,
} = await import('../js/microscopy/microscopy-hyperstack-controls.js');
const { seriesVariantKey } = await import('../js/series/series-identity.js');
const { canUseMpr3D, capabilityBlockReason } = await import('../js/series/series-capabilities.js');

function element(tag) {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    type: '',
    checked: false,
    style: {},
    children: [],
    listeners: {},
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      contains(value) { return this.values.has(value); },
    },
    setAttribute(name, value) { this[name] = String(value); },
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    dispatchEvent(event) {
      for (const fn of this.listeners[event.type] || []) fn.call(this, event);
    },
    append(...items) { this.children.push(...items); },
    prepend(...items) { this.children.unshift(...items); },
    replaceChildren(...items) { this.children = items; },
  };
}

function installDom() {
  const panel = element('div');
  const root = element('div');
  panel.id = 'microscopy-stack-panel';
  root.id = 'microscopy-stack-controls';
  globalThis.document = {
    getElementById(id) {
      if (id === 'microscopy-stack-panel') return panel;
      if (id === 'microscopy-stack-controls') return root;
      return null;
    },
    querySelector() { return null; },
    createElement: element,
  };
  globalThis.requestAnimationFrame = (fn) => fn();
  return { panel, root };
}

function hasDescendantId(node, id) {
  if (node?.id === id) return true;
  return (node?.children || []).some(child => hasDescendantId(child, id));
}

function descendantById(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) {
    const match = descendantById(child, id);
    if (match) return match;
  }
  return null;
}

function hostFixture() {
  const stacks = {
    '0|0': ['dapi-z1', 'dapi-z2'],
    '1|0': ['gfp-z1', 'gfp-z2'],
    '0|1': ['dapi-t2-z1', 'dapi-t2-z2'],
  };
  const series = {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 1,
    height: 1,
    slices: 2,
    microscopy: {
      sizeZ: 2,
      sizeC: 2,
      sizeT: 2,
      channelIndex: 0,
      channelName: 'DAPI',
      timeIndex: 0,
      physicalUnit: 'µm',
    },
    pixelSpacing: [0.00025, 0.0005],
    sliceThickness: 0.0015,
    sliceSpacing: 0.0015,
    orientation: [1, 0, 0, 0, 1, 0],
    _spacingKnown: true,
    _sliceSpacingKnown: true,
    microscopyDataset: {
      axes: [
        { name: 'z', size: 2 },
        { name: 'c', size: 2 },
        { name: 't', size: 2 },
      ],
      source: { warnings: [] },
      channels: [
        {
          index: 0,
          name: 'DAPI',
          color: '#0000FF',
          lut: 'linear',
          displayRange: [10, 2000],
          displayRangeSource: 'metadata',
          emissionWavelength: 460,
          emissionWavelengthUnit: 'nm',
        },
        { index: 1, name: 'GFP', color: '#00FF00', emissionWavelength: 510, emissionWavelengthUnit: 'nm' },
      ],
    },
  };
  return {
    manifest: { series: [series] },
    seriesIdx: 0,
    sliceIdx: 1,
    imgs: stacks['0|0'],
    _localStacks: { cells: stacks['0|0'] },
    _localMicroscopyStacks: { cells: stacks },
    _localMicroscopyPlanes: {
      cells: {
        '0|0': [
          { width: 1, height: 1, pixels: new Float32Array([1]), photometric: 1, z: 0 },
          { width: 1, height: 1, pixels: new Float32Array([3]), photometric: 1, z: 1 },
        ],
        '1|0': [
          { width: 1, height: 1, pixels: new Float32Array([10]), photometric: 1, z: 0 },
          { width: 1, height: 1, pixels: new Float32Array([30]), photometric: 1, z: 1 },
        ],
        '0|1': [
          { width: 1, height: 1, pixels: new Float32Array([5]), photometric: 1, z: 0 },
          { width: 1, height: 1, pixels: new Float32Array([15]), photometric: 1, z: 1 },
        ],
      },
    },
    _localRawVolumes: {},
  };
}

function rangeHostFixture() {
  const host = hostFixture();
  const image = (name, rawRange) => ({
    name,
    _microscopyRawRange: rawRange,
    _microscopyDisplayByteRange: [0, 255],
  });
  const stacks = {
    '0|0': [image('dapi-t1-z1', [0, 100]), image('dapi-t1-z2', [0, 100])],
    '0|1': [image('dapi-t2-z1', [100, 300]), image('dapi-t2-z2', [100, 300])],
    '1|0': [image('gfp-z1', [0, 50]), image('gfp-z2', [0, 50])],
  };
  host._localMicroscopyStacks.cells = stacks;
  host._localStacks.cells = stacks['0|0'];
  host.imgs = stacks['0|0'];
  return host;
}

test('microscopyHyperstackState exposes available channel/time positions for one dataset series', () => {
  const host = hostFixture();
  const model = microscopyHyperstackState(host);

  assert.equal(model.sizeC, 2);
  assert.equal(model.sizeT, 2);
  assert.deepEqual(model.composite, { enabled: false, channels: [true, true] });
  assert.deepEqual(model.channels.map(channel => [channel.name, channel.available]), [
    ['DAPI', true],
    ['GFP', true],
  ]);
  assert.deepEqual(model.channels.map(channel => [channel.color, channel.emissionWavelength]), [
    ['#0000FF', 460],
    ['#00FF00', 510],
  ]);
  assert.deepEqual(model.channels.map(channel => [channel.lut, channel.displayRange, channel.displayRangeSource]), [
    ['linear', [10, 2000], 'metadata'],
    ['', null, ''],
  ]);
  assert.deepEqual(model.times.map(time => [time.index, time.available]), [
    [0, true],
    [1, true],
  ]);
});

test('renderMicroscopyHyperstackControls exposes a composite toggle for multi-channel stacks', () => {
  const { root } = installDom();
  const host = hostFixture();

  renderMicroscopyHyperstackControls(host);

  assert.ok(hasDescendantId(root, 'microscopy-composite-toggle'));
});

test('renderMicroscopyHyperstackControls shows metadata display range without wrapping controls', () => {
  const { root } = installDom();
  const host = hostFixture();

  renderMicroscopyHyperstackControls(host);

  const meta = root.children[0].children.find(node => node.className === 'hyperstack-channel-meta');
  const text = meta.children.find(node => node.className === 'hyperstack-channel-text');
  assert.equal(text.textContent, 'DAPI · 460 nm · LUT linear · range 10-2000');
  assert.equal(text.title, text.textContent);
});

test('renderMicroscopyHyperstackControls keeps zero-start metadata ranges visible', () => {
  const { root } = installDom();
  const host = hostFixture();
  host.manifest.series[0].microscopyDataset.channels[0].displayRange = [0, 4095];

  renderMicroscopyHyperstackControls(host);

  const meta = root.children[0].children.find(node => node.className === 'hyperstack-channel-meta');
  const text = meta.children.find(node => node.className === 'hyperstack-channel-text');
  assert.equal(text.textContent, 'DAPI · 460 nm · LUT linear · range 0-4095');
});

test('renderMicroscopyHyperstackControls shows calibrated spacing provenance', () => {
  const { root } = installDom();
  const host = hostFixture();

  renderMicroscopyHyperstackControls(host);

  const calibration = root.children[0].children.find(node => node.id === 'microscopy-calibration');
  assert.equal(calibration.textContent, 'X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');
  assert.equal(calibration.title, 'Physical pixel spacing from microscopy metadata');
});

test('renderMicroscopyHyperstackControls labels unknown spacing as uncalibrated', () => {
  const { root } = installDom();
  const host = hostFixture();
  const series = host.manifest.series[0];
  series.pixelSpacing = [0, 0];
  series.sliceThickness = 0;
  series.sliceSpacing = 0;
  series._spacingKnown = false;
  series._sliceSpacingKnown = false;
  series.microscopyDataset.source.warnings = ['missing_xy_physical_size'];

  renderMicroscopyHyperstackControls(host);

  const calibration = root.children[0].children.find(node => node.id === 'microscopy-calibration');
  assert.equal(calibration.textContent, 'XY uncalibrated · 1 warning');
  assert.equal(calibration.className.includes('is-uncalibrated'), true);
  assert.equal(calibration.title, 'XY spacing missing');
});

test('applyManualMicroscopyCalibration enables trusted spacing for uncalibrated sequence stacks', () => {
  const host = hostFixture();
  const series = host.manifest.series[0];
  series.pixelSpacing = [0, 0];
  series.sliceThickness = 0;
  series.sliceSpacing = 0;
  series._spacingKnown = false;
  series._sliceSpacingKnown = false;
  series.microscopyDataset.source.warnings = ['missing_xy_physical_size', 'missing_z_physical_size'];
  series.microscopyDataset.axes = [
    { name: 'x', size: 16, known: false, scale: 0, unit: '' },
    { name: 'y', size: 16, known: false, scale: 0, unit: '' },
    { name: 'z', size: 2, known: false, scale: 0, unit: '' },
    { name: 'c', size: 2 },
    { name: 't', size: 2 },
  ];

  assert.equal(applyManualMicroscopyCalibration(series, {
    xUmPerPx: 0.5,
    yUmPerPx: 0.25,
    zUm: 1.5,
  }, host), true);

  assert.deepEqual(series.pixelSpacing, [0.00025, 0.0005]);
  assert.equal(series._spacingKnown, true);
  assert.equal(series.microscopy.calibrationSource, 'manual');
  assert.equal(series.sliceSpacing, 0.0015);
  assert.equal(series._sliceSpacingKnown, true);
  assert.equal(series.microscopyDataset.axes[0].known, true);
  assert.equal(series.microscopyDataset.axes[0].scale, 0.5);
  assert.equal(series.microscopyDataset.axes[0].unit, 'µm');
  assert.deepEqual(series.microscopyDataset.source.warnings, []);
  assert.deepEqual(series.firstIPP, [0, 0, 0]);
  assert.deepEqual(series.lastIPP, [0, 0, 0.0015]);
  assert.equal(series.geometryKind, 'volumeStack');
  assert.equal(series.reconstructionCapability, 'display-volume');
  assert.equal(series.microscopy.volumeEligible, true);
  assert.deepEqual(Array.from(host._localRawVolumes.cells), [0, 1]);
  assert.equal(canUseMpr3D(series), true);
});

test('manual calibration keeps incomplete alternate C/T coverage explicitly 2D', () => {
  const host = hostFixture();
  const series = host.manifest.series[0];
  host._localMicroscopyPlanes.cells['1|0'] = host._localMicroscopyPlanes.cells['1|0'].slice(0, 1);
  host._localMicroscopyStacks.cells['1|0'] = host._localMicroscopyStacks.cells['1|0'].slice(0, 1);
  series.pixelSpacing = [0, 0];
  series.sliceSpacing = 0;
  series.sliceThickness = 0;
  series._spacingKnown = false;
  series._sliceSpacingKnown = false;

  assert.equal(applyManualMicroscopyCalibration(series, {
    xUmPerPx: 0.5,
    yUmPerPx: 0.25,
    zUm: 1.5,
  }, host), true);

  assert.equal(series.geometryKind, 'microscopyStack');
  assert.equal(series.reconstructionCapability, '2d-only');
  assert.equal(series.microscopy.volumeEligible, false);
  assert.equal(series.microscopy.volumeBlockReason, 'incomplete_z_coverage');
  assert.equal(host._localRawVolumes.cells, undefined);
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /complete contiguous Z coverage/);
});

test('setMicroscopyChannelDisplayRange updates all timepoints for one channel only', () => {
  const host = rangeHostFixture();
  const series = host.manifest.series[0];

  assert.equal(setMicroscopyChannelDisplayRange(series, 0, [50, 150], host), true);

  assert.deepEqual(series.microscopyDataset.channels[0].displayRange, [50, 150]);
  assert.equal(series.microscopyDataset.channels[0].displayRangeSource, 'user');
  assert.deepEqual(host._localMicroscopyStacks.cells['0|0'][0]._microscopyDisplayByteRange, [127.5, 382.5]);
  assert.deepEqual(host._localMicroscopyStacks.cells['0|1'][0]._microscopyDisplayByteRange, [-63.75, 63.75]);
  assert.deepEqual(host._localMicroscopyStacks.cells['1|0'][0]._microscopyDisplayByteRange, [0, 255]);
  assert.equal(host.manifest.series[0].microscopy.channelIndex, 0);
  assert.equal(host.sliceIdx, 1);
});

test('setMicroscopyChannelDisplayRange rejects invalid ranges without mutating state', () => {
  const host = rangeHostFixture();
  const series = host.manifest.series[0];

  assert.equal(setMicroscopyChannelDisplayRange(series, 0, [200, 100], host), false);

  assert.deepEqual(series.microscopyDataset.channels[0].displayRange, [10, 2000]);
  assert.deepEqual(host._localMicroscopyStacks.cells['0|0'][0]._microscopyDisplayByteRange, [0, 255]);
});

test('canSetMicroscopyChannelDisplayRange fails closed when raw ranges are missing', () => {
  const host = rangeHostFixture();
  const series = host.manifest.series[0];
  delete host._localMicroscopyStacks.cells['0|0'][0]._microscopyRawRange;

  assert.equal(canSetMicroscopyChannelDisplayRange(series, 0, [50, 150], host), false);
  assert.equal(setMicroscopyChannelDisplayRange(series, 0, [50, 150], host), false);
});

test('setMicroscopyChannelDisplayColor preserves source color and overrides display color', () => {
  const host = hostFixture();
  const series = host.manifest.series[0];

  assert.equal(setMicroscopyChannelDisplayColor(series, 1, '#aa00cc'), true);

  assert.equal(series.microscopyDataset.channels[1].color, '#00FF00');
  assert.equal(series.microscopyDataset.channels[1].displayColor, '#AA00CC');
  assert.equal(series.microscopyDataset.channels[1].displayColorSource, 'user');
  assert.equal(microscopyHyperstackState(host).channels[1].color, '#AA00CC');
  assert.equal(setMicroscopyChannelDisplayColor(series, 1, 'green'), false);
  assert.equal(series.microscopyDataset.channels[1].displayColor, '#AA00CC');
});

test('renderMicroscopyHyperstackControls exposes user channel color input', () => {
  const { root } = installDom();
  const host = hostFixture();

  renderMicroscopyHyperstackControls(host);
  const input = descendantById(root, 'microscopy-channel-color');
  assert.equal(input.type, 'color');
  assert.equal(input.value, '#0000FF');
  input.value = '#aa00cc';
  input.dispatchEvent({ type: 'change' });

  assert.equal(host.manifest.series[0].microscopyDataset.channels[0].displayColor, '#AA00CC');
  assert.equal(descendantById(root, 'microscopy-channel-color').value, '#AA00CC');
});

test('stepMicroscopyStackPosition moves C/T without changing Z slice scope', () => {
  installDom();
  const host = hostFixture();

  assert.equal(stepMicroscopyStackPosition({ channelDelta: 1 }, host), true);
  assert.equal(host.manifest.series[0].microscopy.channelIndex, 1);
  assert.equal(host.manifest.series[0].microscopy.channelName, 'GFP');
  assert.equal(host.manifest.series[0].microscopy.timeIndex, 0);
  assert.equal(host.sliceIdx, 1);
  assert.deepEqual(host.imgs, ['gfp-z1', 'gfp-z2']);

  assert.equal(stepMicroscopyStackPosition({ timeDelta: 1 }, host), false);
  assert.equal(host.manifest.series[0].microscopy.timeIndex, 0);
  assert.equal(host.sliceIdx, 1);

  assert.equal(stepMicroscopyStackPosition({ channelDelta: -1 }, host), true);
  assert.equal(stepMicroscopyStackPosition({ timeDelta: 1 }, host), true);
  assert.equal(host.manifest.series[0].microscopy.channelIndex, 0);
  assert.equal(host.manifest.series[0].microscopy.timeIndex, 1);
  assert.equal(host.sliceIdx, 1);
  assert.deepEqual(host.imgs, ['dapi-t2-z1', 'dapi-t2-z2']);
});

test('renderMicroscopyHyperstackControls exposes active channel display range inputs', () => {
  const { root } = installDom();
  const host = rangeHostFixture();

  renderMicroscopyHyperstackControls(host);

  const min = descendantById(root, 'microscopy-display-range-min');
  const max = descendantById(root, 'microscopy-display-range-max');
  assert.equal(min.value, '10');
  assert.equal(max.value, '2000');
  assert.equal(min.disabled, false);
  assert.equal(max.disabled, false);
});

test('renderMicroscopyHyperstackControls exposes workflow recipe save/replay controls', () => {
  const { root } = installDom();
  const host = hostFixture();

  renderMicroscopyHyperstackControls(host);

  assert.ok(hasDescendantId(root, 'microscopy-recipe-export'));
  assert.ok(hasDescendantId(root, 'microscopy-recipe-import'));
  assert.ok(hasDescendantId(root, 'microscopy-recipe-status'));
});

test('renderMicroscopyHyperstackControls disables missing composite channels as inactive', () => {
  const { root } = installDom();
  const host = hostFixture();
  host.manifest.series[0].microscopy.timeIndex = 1;
  host.manifest.series[0].microscopy.composite = { enabled: true, channels: [true, true] };

  renderMicroscopyHyperstackControls(host);

  const missingGfp = descendantById(root, 'microscopy-composite-c1');
  assert.equal(missingGfp.disabled, true);
  assert.equal(missingGfp.checked, false);
});

test('activateMicroscopyStackPosition swaps the active local stack and raw-volume cache identity', () => {
  installDom();
  const host = hostFixture();
  const series = host.manifest.series[0];
  series.microscopy.volumeEligible = true;
  series.geometryKind = 'volumeStack';
  series.reconstructionCapability = 'display-volume';
  series.firstIPP = [0, 0, 0];
  series.lastIPP = [0, 0, 0.0015];
  series.orientation = [1, 0, 0, 0, 1, 0];
  const beforeKey = seriesVariantKey(series, 'base', host.manifest);

  assert.equal(activateMicroscopyStackPosition(1, 0, host), true);

  assert.equal(host.seriesIdx, 0);
  assert.equal(host.manifest.series[0].microscopy.channelIndex, 1);
  assert.equal(host.manifest.series[0].microscopy.channelName, 'GFP');
  assert.equal(host.manifest.series[0].microscopy.timeIndex, 0);
  assert.equal(host.imgs, host._localMicroscopyStacks.cells['1|0']);
  assert.equal(host._localStacks.cells, host._localMicroscopyStacks.cells['1|0']);
  assert.deepEqual(Array.from(host._localRawVolumes.cells), [0, 1]);
  const afterKey = seriesVariantKey(series, 'base', host.manifest);
  assert.notEqual(afterKey, beforeKey);

  assert.equal(activateMicroscopyStackPosition(0, 1, host), true);
  assert.deepEqual(Array.from(host._localRawVolumes.cells), [0, 1]);
  assert.notEqual(seriesVariantKey(series, 'base', host.manifest), afterKey);
});

test('activating complete persisted Z coverage without raw planes disables volume tools', () => {
  installDom();
  const host = hostFixture();
  const series = host.manifest.series[0];
  series.microscopy.volumeEligible = true;
  series.microscopy.volumeBlockReason = '';
  series.microscopy.zPositionsByStack = { '1|0': [0, 1] };
  series.geometryKind = 'volumeStack';
  series.reconstructionCapability = 'display-volume';
  series.renderability = 'volume';
  series.firstIPP = [0, 0, 0];
  series.lastIPP = [0, 0, 0.0015];
  series.sliceSpacingRegular = true;
  host._localRawVolumes.cells = new Float32Array([0, 1]);
  delete host._localMicroscopyPlanes.cells['1|0'];

  assert.equal(activateMicroscopyStackPosition(1, 0, host), true);

  assert.deepEqual(series.firstIPP, [0, 0, 0]);
  assert.deepEqual(series.lastIPP, [0, 0, 0.0015]);
  assert.equal(series.sliceSpacingRegular, true);
  assert.equal(series.geometryKind, 'microscopyStack');
  assert.equal(series.reconstructionCapability, '2d-only');
  assert.equal(series.renderability, '2d');
  assert.equal(series.microscopy.volumeEligible, false);
  assert.equal(series.microscopy.volumeBlockReason, 'volume_source_unavailable');
  assert.equal(host._localRawVolumes.cells, undefined);
  assert.equal(canUseMpr3D(series), false);
  assert.match(capabilityBlockReason(series), /retained raw planes/);
});

test('activating invalid retained Z planes uses the canonical volume-data failure reason', () => {
  installDom();
  const host = hostFixture();
  const series = host.manifest.series[0];
  series.microscopy.volumeEligible = true;
  series.geometryKind = 'volumeStack';
  series.reconstructionCapability = 'display-volume';
  host._localMicroscopyPlanes.cells['1|0'][1].pixels[0] = Number.NaN;

  assert.equal(activateMicroscopyStackPosition(1, 0, host), true);

  assert.equal(series.microscopy.volumeEligible, false);
  assert.equal(series.microscopy.volumeBlockReason, 'volume_data_invalid');
  assert.equal(host._localRawVolumes.cells, undefined);
});

test('activateMicroscopyStackPosition refuses missing channel/time stacks', () => {
  installDom();
  const host = hostFixture();

  assert.equal(activateMicroscopyStackPosition(1, 1, host), false);
  assert.equal(host.manifest.series[0].microscopy.channelIndex, 0);
  assert.equal(host.imgs, host._localMicroscopyStacks.cells['0|0']);
});

test('activating a sparse alternate stack uses its actual Z extent and clears volume data', () => {
  installDom();
  const host = hostFixture();
  const series = host.manifest.series[0];
  host._localMicroscopyPlanes.cells['1|0'][1].z = 2;
  host._localRawVolumes.cells = new Float32Array([0, 1]);
  series.microscopy.volumeEligible = false;
  series.microscopy.volumeBlockReason = 'incomplete_z_coverage';

  assert.equal(activateMicroscopyStackPosition(1, 0, host), true);

  assert.equal(series.slices, 2);
  assert.deepEqual(series.firstIPP, [0, 0, 0]);
  assert.deepEqual(series.lastIPP, [0, 0, 0.003]);
  assert.equal(series.sliceSpacingRegular, false);
  assert.equal(series.geometryKind, 'microscopyStack');
  assert.equal(series.microscopy.volumeEligible, false);
  assert.equal(host._localRawVolumes.cells, undefined);
});
