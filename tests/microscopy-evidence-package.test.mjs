/* global URL */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CALIBRATED_OME_TIFF } from './fixtures/microscopy/calibrated-ome-tiff.mjs';

globalThis.location = new URL('http://127.0.0.1/');

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { setRoiEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const { buildMicroscopyEvidencePackage } = await import('../js/roi/microscopy-evidence-package.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');

function storedZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    assert.equal(method, 0, 'evidence package entries are stored');
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function jsonEntry(entries, name) {
  return JSON.parse(new TextDecoder().decode(entries.get(name)));
}

function setupPackageState() {
  storage.clear();
  const series = {
    slug: 'cells_evidence',
    name: 'cells evidence',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 1,
    pixelSpacing: CALIBRATED_OME_TIFF.pixelSpacingMm,
    sliceThickness: CALIBRATED_OME_TIFF.sliceThicknessMm,
    microscopy: {
      channelIndex: 0,
      channelName: 'DAPI',
      timeIndex: 0,
      physicalUnit: 'µm',
      sourceFiles: ['cells.ome.tiff'],
    },
    microscopyDataset: {
      source: { originalFormat: 'OME-TIFF', warnings: [] },
      axes: [
        { name: 'x', type: 'space', size: 16, unit: 'µm', scale: 0.5, known: true },
        { name: 'y', type: 'space', size: 16, unit: 'µm', scale: 0.25, known: true },
        { name: 'z', type: 'space', size: 1, unit: 'µm', scale: 1.5, known: true },
        { name: 'c', type: 'channel', size: 1, unit: '', scale: 0, known: false },
        { name: 't', type: 'time', size: 1, unit: 'index', scale: 1, known: false },
      ],
      channels: [{ index: 0, name: 'DAPI', displayColor: '#0000ff' }],
      planes: [{ c: 0, z: 0, t: 0, width: 16, height: 16 }],
    },
  };
  state.manifest = { series: [series] };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  const analysisKey = seriesPersistenceKey(series, state.manifest);
  state._microscopyAnalysisLog = {
    [analysisKey]: [{
      op: 'analyze-particles',
      opId: 'cells_evidence:ap:0',
      createdAt: 1_700_000_000_000,
      inputs: { seriesId: 'cells_evidence', c: 0, z: 0, t: 0, level: 0 },
      calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005 },
      measurementDomain: 'raw_16bit',
      params: {
        projection: null,
        threshold: { method: 'manual', resolvedValue: 0, darkBackground: true, pixelMin: 0, pixelMax: 255 },
        particle: { connectivity: 8, sizeRangePx: [1, null], circularityRange: [0, 1], excludeEdges: false },
      },
      outputRoiObjectIds: ['particles:cells_evidence|0|c0|t0:1'],
    }],
  };
  setRoiEntriesForSlice('cells_evidence', 0, [{
    id: 1,
    shape: 'polygon',
    label: 'Particle 1',
    pts: [[0, 0], [4, 0], [4, 4], [0, 4]],
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
    stats: {
      pixels: 16,
      count: 16,
      area_mm2: 16 * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1],
      mean: 40000,
      min: 40000,
      max: 40000,
      raw_int_den: 640000,
      valueSource: 'raw_16bit',
      valueUnit: 'raw',
    },
    importedObjectId: 'particles:cells_evidence|0|c0|t0:1',
    createdAt: 1_700_000_000_000,
  }]);
  return analysisKey;
}

test('microscopy evidence package contains reviewer-ready artifacts without source pixels', () => {
  setupPackageState();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const result = buildMicroscopyEvidencePackage(state, { snapshotPng: png });
  assert.equal(result.ok, true);
  assert.equal(result.filename, 'voxellab-microscopy-evidence-cells_evidence.zip');

  const entries = storedZipEntries(result.bytes);
  assert.deepEqual([...entries.keys()], [
    'manifest.json',
    'roi-results.json',
    'roi-results.csv',
    'annotated-snapshot-cells_evidence.png',
    'analysis-descriptor.json',
    'LIMITATIONS.txt',
  ]);
  assert.deepEqual([...entries.keys()].filter(name => /\.(ome\.)?tiff?$/i.test(name)), []);
  assert.deepEqual([...entries.get('annotated-snapshot-cells_evidence.png')], [...png]);

  const manifest = jsonEntry(entries, 'manifest.json');
  assert.equal(manifest.schema, 'voxellab.microscopyEvidencePackage.v1');
  assert.equal(manifest.evidence.sourceImageDataIncluded, false);
  assert.equal(manifest.evidence.artifact, 'voxellab-microscopy-evidence-cells_evidence.zip');
  assert.deepEqual(manifest.evidence.intensityDomains, [{
    valueSource: 'raw_16bit',
    valueUnit: 'raw',
    rows: 1,
    meaning: 'raw retained microscopy plane intensity',
  }]);
  assert.deepEqual(manifest.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known]), [
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 1, '', 0, false],
    ['t', 'time', 1, 'index', 1, false],
  ]);
  assert.match(new TextDecoder().decode(entries.get('LIMITATIONS.txt')), /not clinical/);

  const roiJson = jsonEntry(entries, 'roi-results.json');
  assert.equal(roiJson.rows[0].valueSource, 'raw_16bit');
  assert.equal(roiJson.rows[0].valueUnit, 'raw');
  assert.match(new TextDecoder().decode(entries.get('roi-results.csv')), /value_unit,value_source/);

  const descriptor = jsonEntry(entries, 'analysis-descriptor.json');
  assert.equal(descriptor.schema, 'voxellab.microscopyAnalysisDescriptor.v1');
  assert.equal(descriptor.measurementDomains[0], 'raw_16bit');
  assert.equal(descriptor.operations[0].params.threshold.resolvedValue, 0);
});

test('microscopy evidence package requires an analysis descriptor and snapshot', () => {
  const analysisKey = setupPackageState();
  state._microscopyAnalysisLog = { cells_evidence: state._microscopyAnalysisLog[analysisKey] };
  assert.deepEqual(buildMicroscopyEvidencePackage(state, { snapshotPng: new Uint8Array([1]) }), {
    ok: false,
    reason: 'no_analysis_descriptor',
  });
  setupPackageState();
  assert.deepEqual(buildMicroscopyEvidencePackage(state), {
    ok: false,
    reason: 'no_snapshot',
  });
});

test('microscopy evidence package supports analysis-only profile evidence', () => {
  const analysisKey = setupPackageState();
  setRoiEntriesForSlice('cells_evidence', 0, []);
  state._microscopyAnalysisLog[analysisKey] = [{
    op: 'line-profile',
    inputs: { seriesId: 'cells_evidence', c: 0, z: 0, t: 0, level: 0 },
    measurementDomain: 'raw_scalar',
    params: { sampling: 'nearest', line: { x1: 1, y1: 1, x2: 4, y2: 1 } },
  }];
  const result = buildMicroscopyEvidencePackage(state, { snapshotPng: new Uint8Array([1]) });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.evidence.roiRowCount, 0);
  assert.deepEqual(result.analysisDescriptor.measurementDomains, ['raw_scalar']);
  assert.match(new TextDecoder().decode(storedZipEntries(result.bytes).get('LIMITATIONS.txt')), /no Costes/i);
});
