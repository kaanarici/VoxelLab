import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPatientFrame,
  mprPaneLabels,
  viewPresetAnatomy,
} from '../js/core/view-orientation.js';

// Minimal series: only orientation drives the basis (sliceDir = row × col when
// no IPP endpoints are supplied), which is exactly what we want to pin down.
const series = (orientation) => ({ orientation, firstIPP: [0, 0, 0] });

test('axial head-first-supine: presets read as the familiar L/R/Front/Back/Top/Bottom', () => {
  const a = viewPresetAnatomy(series([1, 0, 0, 0, 1, 0])); // row=L, col=P → sliceDir=S
  assert.equal(a.sagittal.short, 'L');
  assert.equal(a.right.short, 'R');
  assert.equal(a.coronal.short, 'Front'); // -col = Anterior
  assert.equal(a.back.short, 'Back');     // +col = Posterior
  assert.equal(a.axial.short, 'Top');     // +sliceDir = Superior
  assert.equal(a.bottom.short, 'Bottom');
});

test('feet-first axial: the +X camera is the patient RIGHT, not Left (the dangerous flip)', () => {
  const a = viewPresetAnatomy(series([-1, 0, 0, 0, 1, 0])); // row=R
  assert.equal(a.sagittal.short, 'R'); // old hardcoded code wrongly said 'L'
  assert.equal(a.right.short, 'L');
  assert.equal(a.axial.short, 'Bottom'); // sliceDir = Inferior
});

test('native sagittal acquisition: the "sagittal" preset shows Posterior, axial shows R', () => {
  const a = viewPresetAnatomy(series([0, 1, 0, 0, 0, -1])); // row=P, col=I → sliceDir=R
  assert.equal(a.sagittal.short, 'Back'); // row = Posterior, not Left
  assert.equal(a.right.short, 'Front');
  assert.equal(a.axial.short, 'R');       // sliceDir = Right
  assert.equal(a.coronal.short, 'Top');
});

test('native coronal acquisition: sagittal stays L, axial preset shows Posterior', () => {
  const a = viewPresetAnatomy(series([1, 0, 0, 0, 0, -1])); // row=L, col=I → sliceDir=P
  assert.equal(a.sagittal.short, 'L');
  assert.equal(a.axial.short, 'Back'); // sliceDir = Posterior
  assert.equal(a.coronal.short, 'Top');
});

test('no patient frame → null (caller shows neutral labels)', () => {
  assert.equal(viewPresetAnatomy({}), null);
  assert.equal(viewPresetAnatomy({ orientation: [1, 0, 0, 0, 1, 0], imageDomain: 'microscopy' }), null);
  assert.equal(hasPatientFrame({ orientation: [1, 0, 0, 0, 1, 0] }), true);
  assert.equal(hasPatientFrame({ orientation: [1, 0, 0, 0, 1, 0], patientFrameTrusted: false }), false);
  assert.equal(hasPatientFrame({ orientation: [1, 0, 0, 0, 1, 0], _niftiSpatialAffineLps: null }), false);
  assert.equal(hasPatientFrame({}), false);
});

test('MPR pane labels follow the patient-space acquisition normals', () => {
  const labels = mprPaneLabels({
    orientation: [0, 1, 0, 0, 0, -1],
    patientFrameTrusted: true,
  });

  assert.equal(labels.ax, 'Sagittal');
  assert.equal(labels.co, 'Axial');
  assert.equal(labels.sa, 'Coronal');
  assert.equal(labels.ob, 'Oblique · acquisition grid');
});

test('MPR pane labels stay neutral without a trusted patient frame', () => {
  assert.deepEqual(mprPaneLabels({
    orientation: [1, 0, 0, 0, 1, 0],
    patientFrameTrusted: false,
  }), {
    ax: 'Acquisition XY',
    co: 'Acquisition XZ',
    sa: 'Acquisition YZ',
    ob: 'Oblique · acquisition grid',
  });
});
