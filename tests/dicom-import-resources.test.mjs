import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  DICOM_IMPORT_LIMITS,
  addDICOMActualInputBytes,
  assertDICOMActualFileBytes,
  assertDICOMDatasetMetadata,
  assertDICOMInputFiles,
  assertDICOMSeriesWorkingSet,
} = await import('../js/dicom/dicom-import-resources.js');
const { buildDICOMSeriesResult } = await import('../js/dicom/dicom-import-parse.js');

function monochromeMeta(overrides = {}) {
  return {
    Modality: 'CT',
    Rows: 1,
    Columns: 1,
    NumberOfFrames: 1,
    BitsAllocated: 16,
    BitsStored: 16,
    PixelRepresentation: 0,
    PhotometricInterpretation: 'MONOCHROME2',
    ...overrides,
  };
}

test('DICOM file acquisition rejects declared and actual sizes before parsing', () => {
  assert.throws(
    () => assertDICOMInputFiles([{ name: 'oversized.dcm', size: DICOM_IMPORT_LIMITS.maxFileBytes + 1 }]),
    /oversized\.dcm exceeds the .* per-file limit/,
  );
  assert.throws(
    () => assertDICOMInputFiles([{ name: 'unknown.dcm', size: Number.NaN }]),
    /unknown\.dcm has an invalid declared file size/,
  );
  assert.throws(
    () => assertDICOMActualFileBytes(DICOM_IMPORT_LIMITS.maxFileBytes + 1, { name: 'liar.dcm' }),
    /liar\.dcm exceeds the .* per-file limit/,
  );
  assert.throws(
    () => addDICOMActualInputBytes(DICOM_IMPORT_LIMITS.maxInputBytes, 1, { name: 'extra.dcm' }),
    /selected files exceed the .* byte input limit/,
  );
});

test('DICOM metadata limits reject unsafe dimensions and overlarge enhanced instances', () => {
  assert.throws(
    () => assertDICOMDatasetMetadata([{ meta: monochromeMeta({ Rows: '2.5' }) }]),
    /Rows must be a positive safe integer/,
  );
  assert.throws(
    () => assertDICOMDatasetMetadata([{
      meta: monochromeMeta({ Rows: 4096, Columns: 4096, NumberOfFrames: 3 }),
    }]),
    /instance voxel count .* exceeds the .* voxel limit/,
  );
});

test('DICOM modeled working set accounts for retained source, raw output, canvases, and per-plane transients', () => {
  const sharedSource = { id: 'enhanced-instance' };
  const datasets = [0, 1].map(index => ({
    meta: monochromeMeta({ Rows: 4096, Columns: 4096, InstanceNumber: index + 1 }),
    pixels: { byteLength: 32 * 1024 * 1024 },
    file: sharedSource,
  }));

  assert.throws(
    () => assertDICOMSeriesWorkingSet(datasets),
    /modeled working set .* exceeds the .* byte limit/,
  );
});

test('DICOM stack resource rejection happens before a canvas or Float32 output allocation', async () => {
  const previousDocument = globalThis.document;
  let canvasCreates = 0;
  globalThis.document = {
    createElement() {
      canvasCreates += 1;
      throw new Error('resource guard must run before canvas allocation');
    },
  };

  try {
    const datasets = [0, 1].map(index => ({
      meta: monochromeMeta({
        Rows: 4096,
        Columns: 4096,
        PixelSpacing: [1, 1],
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, index],
        InstanceNumber: index + 1,
      }),
      pixels: { byteLength: 32 * 1024 * 1024 },
    }));
    await assert.rejects(
      () => buildDICOMSeriesResult(datasets, () => {}, 'too-large'),
      /modeled working set .* exceeds the .* byte limit/,
    );
    assert.equal(canvasCreates, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
