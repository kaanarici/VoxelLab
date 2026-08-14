import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  calibratedOmeFileLike,
  installMicroscopyCanvasStub,
} from './fixtures/microscopy/calibrated-ome-tiff.mjs';

const { parseMicroscopyFiles } = await import('../js/microscopy/microscopy-import.js');
const { state } = await import('../js/core/state.js');
const { calibratedScaleBarModel, updateScaleBar } = await import('../js/overlay/scale-bar.js');

function node() {
  return {
    hidden: true,
    textContent: '',
    attributes: {},
    style: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getBoundingClientRect() {
      return { width: 0 };
    },
  };
}

test('calibratedScaleBarModel uses column spacing, display width, and zoom', () => {
  const model = calibratedScaleBarModel({
    width: 2,
    pixelSpacing: [0.00025, 0.0005],
    imageDomain: 'microscopy',
    microscopy: { physicalUnit: 'µm' },
  }, {
    canvasCssWidth: 4,
    imageWidth: 2,
    zoom: 10,
  });

  assert.deepEqual(model, {
    widthPx: 80,
    lengthMm: 0.002,
    label: '2 µm',
  });
});

test('calibratedScaleBarModel uses the shared parsed calibrated OME-TIFF fixture', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = await parseMicroscopyFiles([calibratedOmeFileLike()]);
    const series = result.entry;
    const model = calibratedScaleBarModel(series, {
      canvasCssWidth: series.width,
      imageWidth: series.width,
      zoom: 20,
    });

    assert.deepEqual(model, {
      widthPx: 80,
      lengthMm: 0.002,
      label: '2 µm',
    });
  } finally {
    restore();
  }
});

test('calibratedScaleBarModel returns null when spacing is uncalibrated', () => {
  assert.equal(calibratedScaleBarModel({
    width: 100,
    pixelSpacing: [0, 0],
  }, {
    canvasCssWidth: 100,
    imageWidth: 100,
    zoom: 1,
  }), null);
});

test('updateScaleBar renders calibrated 2D scale and hides outside 2D', () => {
  const root = node();
  const line = node();
  const label = node();
  const view = {
    width: 100,
    style: { width: '100px' },
    getBoundingClientRect: () => ({ left: 20, top: 30, right: 120, bottom: 130, width: 100, height: 100 }),
  };
  const wrap = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }),
  };
  globalThis.document = {
    getElementById(id) {
      if (id === 'scale-bar') return root;
      if (id === 'scale-bar-line') return line;
      if (id === 'scale-bar-label') return label;
      if (id === 'view') return view;
      if (id === 'canvas-wrap') return wrap;
      return null;
    },
  };

  state.loaded = true;
  state.mode = '2d';
  state.zoom = 1;
  state.seriesIdx = 0;
  state.manifest = {
    series: [{ width: 100, pixelSpacing: [0.7, 0.7] }],
  };

  const model = updateScaleBar();
  assert.equal(root.hidden, false);
  assert.equal(root.attributes['aria-label'], 'Scale bar 50 mm');
  assert.equal(line.style.width, `${model.widthPx}px`);
  assert.equal(label.textContent, '50 mm');
  assert.equal(root.style.right, '94px');
  assert.equal(root.style.bottom, '84px');

  state.mode = 'mpr';
  assert.equal(updateScaleBar(), null);
  assert.equal(root.hidden, true);
});
