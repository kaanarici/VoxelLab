import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudActionWorkflowLines, cloudActionWorkflowRecords } from '../js/cloud-actions.js';

test('cloud action workflow lines include loaded-study readiness evidence', () => {
  const context = {
    activeIndex: 0,
    projectionSets: [
      { id: 'projection_set_1', name: 'Projection sweep', reconstructionStatus: 'requires-calibration' },
    ],
    seriesList: [
      {
        slug: 'local_ct',
        name: 'Local CT',
        modality: 'CT',
        geometryKind: 'volumeStack',
        reconstructionCapability: 'display-volume',
      },
      {
        slug: 'cloud_result',
        name: 'Cloud Result',
        modality: 'CT',
        geometryKind: 'volumeStack',
        reconstructionCapability: 'display-volume',
        cloudAction: { id: 'cloud-volume-segmentation' },
      },
      {
        slug: 'calibrated_us',
        name: 'Calibrated US',
        modality: 'US',
        ultrasoundCalibration: {
          status: 'calibrated',
          mode: 'stacked-sector',
          probeGeometry: 'sector',
        },
      },
    ],
  };
  const lines = cloudActionWorkflowLines(
    { available: true, code: 'ready', message: 'Cloud GPU processing is ready.' },
    context,
  );

  assert.equal(lines.length, 4);
  assert.match(lines[0], /Cloud CT\/MR segmentation: ready/);
  assert.match(lines[0], /loaded study: CT\/MR source volume candidates: Active Local CT/);
  assert.doesNotMatch(lines[0], /Cloud Result/);
  assert.match(lines[1], /loaded study: projection sources blocked until calibration: Projection sweep \(requires-calibration\)/);
  assert.match(lines[2], /Cloud registration\/alignment: ready/);
  assert.match(lines[2], /loaded study: needs two CT\/MR source volume candidates plus explicit fixed\/moving UIDs/);
  assert.match(lines[3], /loaded study: calibrated ultrasound sources: Calibrated US stacked-sector sector/);
});

test('cloud action workflow records expose readiness and next steps for Ask', () => {
  const records = cloudActionWorkflowRecords(
    { available: true, code: 'ready', message: 'Cloud GPU processing is ready.' },
    {
      activeIndex: 0,
      seriesList: [
        {
          slug: 'fixed_ct',
          name: 'Fixed CT',
          modality: 'CT',
          geometryKind: 'volumeStack',
          reconstructionCapability: 'display-volume',
          sourceSeriesUID: '1.2.3',
        },
        {
          slug: 'moving_mr',
          name: 'Moving MR',
          modality: 'MR',
          geometryKind: 'volumeStack',
          reconstructionCapability: 'display-volume',
          sourceSeriesUID: '4.5.6',
        },
      ],
    },
  );

  const registration = records.find(record => record.id === 'cloud-rigid-registration');
  assert.equal(registration.readinessKind, 'ready');
  assert.equal(registration.inputKind, 'dicom_registration_pair');
  assert.match(registration.loadedState, /registration pair candidates: Active Fixed CT \(1\.2\.3\), Moving MR \(4\.5\.6\)/);
  assert.match(registration.nextStep, /use Upload study to select fixed and moving DICOM stacks plus voxellab\.source\.json/);

  const blocked = cloudActionWorkflowRecords(
    { available: false, code: 'storage-required', message: 'Set an R2 public URL.' },
    { seriesList: [] },
  );
  assert.equal(blocked[0].readinessKind, 'setup-required');
  assert.match(blocked[0].readiness, /setup required: Set an R2 public URL\./);
  assert.equal(blocked[0].nextStep, 'finish Cloud settings setup before selecting source files');
});
