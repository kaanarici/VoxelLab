import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  buildDICOMSeriesResult,
  classifyDICOMImport,
  dicomSeriesGroupKey,
  extractEnhancedMultiFrameMetas,
  extractEnhancedMultiFramePixels,
} = await import('../js/dicom/dicom-import-parse.js');
const { seriesCompareGroup } = await import('../js/core/geometry.js');

function createCanvasStub() {
  const context = {
    // Shape: { width: 2, height: 1, data: Uint8ClampedArray(8) }.
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
  return {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
  };
}

function withDocumentStub(fn) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.document = previousDocument;
  });
}

function withCanvasCapture(fn) {
  const previousDocument = globalThis.document;
  const images = [];
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      const context = {
        createImageData(width, height) {
          return { width, height, data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(imageData) {
          images.push(new Uint8ClampedArray(imageData.data));
        },
      };
      return { width: 0, height: 0, getContext: () => context };
    },
  };
  return Promise.resolve(fn(images)).finally(() => {
    globalThis.document = previousDocument;
  });
}

function grayscaleMeta(overrides = {}) {
  return {
    Modality: 'MR',
    Rows: 1,
    Columns: 3,
    BitsAllocated: 8,
    BitsStored: 8,
    PixelRepresentation: 0,
    PhotometricInterpretation: 'MONOCHROME2',
    PixelSpacing: [1, 1],
    SliceThickness: 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, 0],
    InstanceNumber: 1,
    ...overrides,
  };
}

test('dicomSeriesGroupKey separates series within the same study', () => {
  const first = {
    StudyInstanceUID: '1.2.study',
    SeriesInstanceUID: '1.2.study.1',
    SeriesNumber: 1,
    Modality: 'CT',
  };
  const second = {
    StudyInstanceUID: '1.2.study',
    SeriesInstanceUID: '1.2.study.2',
    SeriesNumber: 2,
    Modality: 'CT',
  };

  assert.notEqual(dicomSeriesGroupKey(first), dicomSeriesGroupKey(second));
});

test('dicomSeriesGroupKey falls back to stable descriptive series tags', () => {
  const firstSlice = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 7,
    SeriesDescription: 'Lateral projection',
    Modality: 'DX',
  };
  const secondSlice = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 7,
    SeriesDescription: 'Lateral projection',
    Modality: 'DX',
  };
  const otherSeries = {
    StudyInstanceUID: '1.2.study',
    SeriesNumber: 8,
    SeriesDescription: 'AP projection',
    Modality: 'DX',
  };

  assert.equal(dicomSeriesGroupKey(firstSlice), dicomSeriesGroupKey(secondSlice));
  assert.notEqual(dicomSeriesGroupKey(firstSlice), dicomSeriesGroupKey(otherSeries));
});

test('classifyDICOMImport marks reconstructed geometry as a volume stack', () => {
  const slices = [0, 2.5].map((z, i) => ({
    Modality: 'CT',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  }));

  const result = classifyDICOMImport(slices);

  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
  assert.equal(result.isProjection, false);
  assert.equal(result.hasVolumeStackGeometry, true);
});

test('geometry-backed scalar PT, NM, and OT series remain on the shared volume import path', async () => {
  await withDocumentStub(async () => {
    for (const modality of ['PT', 'NM', 'OT']) {
      const datasets = [0, 1, 2].map((z, index) => ({
        meta: {
          Modality: modality,
          Rows: 1,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 0,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          PixelSpacing: [2, 3],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, z],
          FrameOfReferenceUID: `for-${modality}`,
          InstanceNumber: index + 1,
        },
        pixels: new Uint16Array([index * 10, index * 10 + 5]),
      }));
      const classification = classifyDICOMImport(datasets);
      assert.equal(classification.kind, 'volume-stack', modality);
      const result = await buildDICOMSeriesResult(datasets, () => {}, `local_${modality.toLowerCase()}_volume`);
      assert.equal(result.entry.modality, modality);
      assert.equal(result.entry.geometryKind, 'volumeStack');
      assert.equal(result.entry.reconstructionCapability, 'display-volume');
      assert.equal(result.entry.renderability, 'volume');
      assert.equal(result.entry.frameOfReferenceUID, `for-${modality}`);
      assert.equal(result.rawVolume.length, 6);
    }
  });
});

test('classifyDICOMImport keeps CR/DX/XA projection sets out of volume stacks', () => {
  for (const modality of ['CR', 'DX', 'XA']) {
    // Example value: two projection images from one series, not a reconstructed volume.
    const result = classifyDICOMImport([
      { Modality: modality, InstanceNumber: 1 },
      { Modality: modality, InstanceNumber: 2 },
      { Modality: modality, InstanceNumber: 3 },
    ]);

    assert.equal(result.kind, 'projection-set', modality);
    assert.equal(result.isProjection, true, modality);
    assert.equal(result.isProjectionSet, true, modality);
    assert.equal(result.isReconstructedVolumeStack, false, modality);
  }
});

test('classifyDICOMImport keeps CT localizers out of volume stacks', () => {
  // Example value: CT scout/localizer images can carry CT modality but are projections.
  const result = classifyDICOMImport([0, 2.5].map((z, i) => ({
    Modality: 'CT',
    ImageType: ['ORIGINAL', 'PRIMARY', 'LOCALIZER'],
    InstanceNumber: i + 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'projection-set');
  assert.equal(result.isProjection, true);
  assert.equal(result.isReconstructedVolumeStack, false);
});

test('classifyDICOMImport treats non-projection multi-image series without geometry as image stacks', () => {
  // Example value: MR files lacking reliable IPP/IOP geometry from a partial export.
  const result = classifyDICOMImport([
    { Modality: 'MR', InstanceNumber: 1 },
    { Modality: 'MR', InstanceNumber: 2 },
  ]);

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isProjection, false);
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport downgrades irregular slice spacing to image-stack', () => {
  const result = classifyDICOMImport([0, 1, 3.5].map((z, i) => ({
    Modality: 'CT',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
  assert.match(result.reason, /irregular/i);
});

test('classifyDICOMImport keeps duplicate IPP positions out of volume stacks', () => {
  const result = classifyDICOMImport([0, 0, 1, 2].map((z, i) => ({
    Modality: 'MR',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport keeps mixed frames of reference out of volume stacks', () => {
  const result = classifyDICOMImport([0, 1, 2].map((z, i) => ({
    Modality: 'MR',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
    FrameOfReferenceUID: i === 1 ? 'for-B' : 'for-A',
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport rejects sheared stacks until they are resampled', () => {
  const result = classifyDICOMImport([0, 1, 2].map((z, i) => ({
    Modality: 'CT',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [i * 0.5, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport rejects mixed in-plane calibration for one volume grid', () => {
  const result = classifyDICOMImport([0, 1, 2].map((z, i) => ({
    Modality: 'MR',
    InstanceNumber: i + 1,
    PixelSpacing: i === 1 ? [2, 1] : [1, 1],
    ImageOrientationPatient: i === 2 ? [0, 1, 0, 1, 0, 0] : [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport rejects non-orthogonal image plane orientation', () => {
  const result = classifyDICOMImport([0, 1, 2].map((z, i) => ({
    Modality: 'MR',
    InstanceNumber: i + 1,
    PixelSpacing: [1, 1],
    ImageOrientationPatient: [1, 0, 0, 0.2, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport keeps missing PixelSpacing out of volume stacks', () => {
  const result = classifyDICOMImport([0, 1, 2].map((z, i) => ({
    Modality: 'MR',
    InstanceNumber: i + 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
  })));

  assert.equal(result.kind, 'image-stack');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.equal(result.hasVolumeStackGeometry, false);
});

test('classifyDICOMImport keeps ultrasound imports 2D-only until scan conversion exists', () => {
  const result = classifyDICOMImport([
    { Modality: 'US', InstanceNumber: 1, NumberOfFrames: 32 },
  ]);

  assert.equal(result.kind, 'ultrasound-cine');
  assert.equal(result.isReconstructedVolumeStack, false);
  assert.match(result.reason, /scan/i);
});

test('classifyDICOMImport promotes enhanced multi-frame with regular per-frame geometry to a volume stack', () => {
  const result = classifyDICOMImport([{
    Modality: 'CT',
    NumberOfFrames: 3,
    SharedFunctionalGroupsSequence: [{
      PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1.0 }],
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    }],
    PerFrameFunctionalGroupsSequence: [
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 2] }] },
    ],
    FrameOfReferenceUID: '1.2.840.enhanced',
  }]);

  assert.equal(result.kind, 'volume-stack');
  assert.equal(result.isReconstructedVolumeStack, true);
  assert.equal(result.hasVolumeStackGeometry, true);
  assert.match(result.reason, /per-frame geometry/i);
});

test('classifyDICOMImport falls back to multiframe-image when per-frame geometry is missing', () => {
  const result = classifyDICOMImport([{
    Modality: 'MR',
    NumberOfFrames: 10,
  }]);

  assert.equal(result.kind, 'multiframe-image');
  assert.equal(result.isReconstructedVolumeStack, false);
});

test('extractEnhancedMultiFrameMetas extracts per-frame metadata from functional groups', () => {
  const meta = {
    SharedFunctionalGroupsSequence: [{
      PixelMeasuresSequence: [{ PixelSpacing: [0.625, 0.625], SliceThickness: 0.7 }],
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    }],
    PerFrameFunctionalGroupsSequence: [
      { PlanePositionSequence: [{ ImagePositionPatient: [-160, -160, 0] }] },
      { PlanePositionSequence: [{ ImagePositionPatient: [-160, -160, 0.7] }] },
    ],
    FrameOfReferenceUID: '1.2.3.4',
  };

  const metas = extractEnhancedMultiFrameMetas(meta);

  assert.equal(metas.length, 2);
  assert.deepEqual(metas[0].ImagePositionPatient, [-160, -160, 0]);
  assert.deepEqual(metas[1].ImagePositionPatient, [-160, -160, 0.7]);
  assert.deepEqual(metas[0].ImageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(metas[0].PixelSpacing, [0.625, 0.625]);
  assert.equal(metas[0].FrameOfReferenceUID, '1.2.3.4');
});

test('extractEnhancedMultiFramePixels expands native uncompressed frames into typed pixel arrays', () => {
  const framePixels = new Uint16Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const item = {
    meta: {
      Modality: 'CT',
      NumberOfFrames: 2,
      Rows: 2,
      Columns: 2,
      BitsAllocated: 16,
      PixelRepresentation: 0,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }] },
      ],
      FrameOfReferenceUID: '1.2.840.enhanced',
    },
    pixelData: {
      Value: [framePixels.buffer],
    },
    file: { name: 'enhanced-ct.dcm' },
  };

  const frames = extractEnhancedMultiFramePixels(item);

  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0].pixels), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(frames[1].pixels), [5, 6, 7, 8]);
  assert.deepEqual(frames[1].meta.ImagePositionPatient, [0, 0, 1]);
  assert.equal(frames[0].file.name, 'enhanced-ct.dcm');
});

test('extractEnhancedMultiFramePixels honors explicit big-endian native frames', () => {
  const framePixels = new Uint8Array([
    0, 1, 0, 2,
    0, 3, 0, 4,
  ]);
  const frames = extractEnhancedMultiFramePixels({
    meta: {
      Modality: 'CT',
      NumberOfFrames: 2,
      Rows: 1,
      Columns: 2,
      BitsAllocated: 16,
      PixelRepresentation: 0,
      TransferSyntaxUID: '1.2.840.10008.1.2.2',
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
        { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }] },
      ],
    },
    pixelData: { Value: [framePixels.buffer] },
  });

  assert.deepEqual(Array.from(frames[0].pixels), [1, 2]);
  assert.deepEqual(Array.from(frames[1].pixels), [3, 4]);
});

test('extractEnhancedMultiFramePixels synthesizes 2D frame metas for ultrasound cine without per-frame geometry', () => {
  const framePixels = new Uint8Array([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]);
  const frames = extractEnhancedMultiFramePixels({
    meta: {
      Modality: 'US',
      NumberOfFrames: 2,
      Rows: 2,
      Columns: 2,
      BitsAllocated: 8,
      PixelRepresentation: 0,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
    },
    pixelData: {
      Value: [framePixels.buffer],
    },
  });

  assert.equal(frames.length, 2);
  assert.equal(frames[0].meta.NumberOfFrames, 1);
  assert.equal(frames[0].meta.InstanceNumber, 1);
  assert.equal(frames[1].meta.InstanceNumber, 2);
  assert.deepEqual(Array.from(frames[1].pixels), [5, 6, 7, 8]);
});

test('buildDICOMSeriesResult rejects an aborted signal before allocating canvases or output', async () => {
  const controller = new AbortController();
  controller.abort();
  const previousDocument = globalThis.document;
  let canvasCreates = 0;
  globalThis.document = {
    createElement() {
      canvasCreates += 1;
      throw new Error('cancelled imports must not allocate a canvas');
    },
  };

  try {
    await assert.rejects(
      buildDICOMSeriesResult([
        {
          meta: {
            Modality: 'CT',
            Rows: 1,
            Columns: 1,
            BitsAllocated: 8,
            BitsStored: 8,
            PixelRepresentation: 0,
            PhotometricInterpretation: 'MONOCHROME2',
          },
          pixels: new Uint8Array([1]),
        },
      ], () => {}, 'cancelled', [], null, controller.signal),
      { name: 'AbortError' },
    );
    assert.equal(canvasCreates, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('buildDICOMSeriesResult honors explicit big-endian native pixel data', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };

  try {
    const result = await buildDICOMSeriesResult([
      {
        meta: {
          Modality: 'MR',
          Rows: 1,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 0,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.2',
          PixelSpacing: [1, 1],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 0],
          InstanceNumber: 1,
          SeriesDescription: 'Big Endian MR',
        },
        pixelData: {
          Value: [new Uint8Array([0, 1, 1, 0]).buffer],
        },
        file: { name: 'big-endian.dcm' },
      },
    ], () => {}, 'local_big_endian');

    assert.deepEqual(Array.from(result.rawVolume), [0, 1]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('buildDICOMSeriesResult routes valid grayscale RLE through the compressed decoder', async () => {
  const encoded = Uint8Array.from([
    1, 0, 0, 0, 64, 0, 0, 0,
    ...new Array(56).fill(0),
    1, 10, 20, 0,
  ]).buffer;

  await withDocumentStub(async () => {
    const result = await buildDICOMSeriesResult([
      {
        meta: {
          Modality: 'MR',
          Rows: 1,
          Columns: 2,
          BitsAllocated: 8,
          BitsStored: 8,
          PixelRepresentation: 0,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.5',
          PixelSpacing: [1, 1],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 0],
          InstanceNumber: 1,
          SeriesDescription: 'RLE MR',
        },
        encodedValue: encoded,
      },
    ], () => {}, 'local_rle_mr');

    assert.ok(result);
    assert.deepEqual(Array.from(result.rawVolume), [0, 1]);
  });
});

test('buildDICOMSeriesResult preserves negative signed 16-bit pixel values in normalized CT volume', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };

  try {
    const signedPixels = new Int16Array([-1024, 0]);
    const result = await buildDICOMSeriesResult([
      {
        meta: {
          Modality: 'CT',
          Rows: 1,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 1,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          PixelSpacing: [1, 1],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 0],
          InstanceNumber: 1,
          SeriesDescription: 'Signed CT',
        },
        pixels: signedPixels,
        file: { path: '/Users/researcher/signed-study/slice-a.dcm' },
      },
      {
        meta: {
          Modality: 'CT',
          Rows: 2,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 1,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          PixelSpacing: [1, 1],
          SliceThickness: 1,
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 1],
          InstanceNumber: 2,
          SeriesDescription: 'Signed CT',
        },
        pixels: new Int16Array([0, 0, 0, 0]),
        file: { name: 'rejected-shape.dcm' },
      },
    ], () => {}, 'local_signed_ct');

    assert.equal(result.rawVolume[0], 0);
    assert.ok(Math.abs(result.rawVolume[1] - (1024 / 3072)) < 1e-6);
    assert.deepEqual(result.entry.sourceFiles, ['slice-a.dcm']);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('buildDICOMSeriesResult preserves unknown DICOM spacing instead of inventing millimeters', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };

  try {
    const result = await buildDICOMSeriesResult([
      {
        meta: {
          Modality: 'MR',
          Rows: 1,
          Columns: 2,
          BitsAllocated: 16,
          BitsStored: 16,
          PixelRepresentation: 0,
          PhotometricInterpretation: 'MONOCHROME2',
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          ImagePositionPatient: [0, 0, 0],
          InstanceNumber: 1,
          SeriesDescription: 'Uncalibrated MR',
        },
        pixels: new Uint16Array([10, 20]),
      },
    ], () => {}, 'local_uncalibrated_mr');

    assert.deepEqual(result.entry.pixelSpacing, [0, 0]);
    assert.equal(result.entry.sliceThickness, 0);
    assert.equal(result.entry.sliceSpacing, 0);
    assert.equal(result.entry._spacingKnown, false);
    assert.equal(result.entry.reconstructionCapability, '2d-only');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('buildDICOMSeriesResult preserves mixed frame and duplicate-position fail-closed metadata', async () => {
  await withDocumentStub(async () => {
    const mixed = await buildDICOMSeriesResult([0, 1, 2].map((z, index) => ({
      meta: {
        Modality: 'MR',
        Rows: 1,
        Columns: 1,
        BitsAllocated: 16,
        BitsStored: 16,
        PixelRepresentation: 0,
        PhotometricInterpretation: 'MONOCHROME2',
        TransferSyntaxUID: '1.2.840.10008.1.2.1',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, z],
        FrameOfReferenceUID: index === 1 ? 'for-B' : 'for-A',
        InstanceNumber: index + 1,
        SeriesDescription: 'Mixed FOR',
      },
      pixels: new Uint16Array([index]),
    })), () => {}, 'local_mixed_for');

    assert.equal(mixed.entry.frameOfReferenceUIDConsistent, false);
    assert.equal('frameOfReferenceUID' in mixed.entry, false);
    assert.equal(seriesCompareGroup(mixed.entry), null);

    const duplicate = await buildDICOMSeriesResult([0, 0, 1].map((z, index) => ({
      meta: {
        Modality: 'MR',
        Rows: 1,
        Columns: 1,
        BitsAllocated: 16,
        BitsStored: 16,
        PixelRepresentation: 0,
        PhotometricInterpretation: 'MONOCHROME2',
        TransferSyntaxUID: '1.2.840.10008.1.2.1',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, z],
        FrameOfReferenceUID: 'for-duplicate',
        InstanceNumber: index + 1,
        SeriesDescription: 'Duplicate IPP',
      },
      pixels: new Uint16Array([index]),
    })), () => {}, 'local_duplicate_ipp');

    assert.equal(duplicate.entry.slicePositionsDistinct, false);
    assert.equal(duplicate.entry.frameOfReferenceUID, 'for-duplicate');
    assert.equal(seriesCompareGroup(duplicate.entry), null);
  });
});

test('buildDICOMSeriesResult fails closed on color DICOM pixel layouts', async () => {
  const skippedReasons = [];
  const result = await buildDICOMSeriesResult([
    {
      meta: {
        Modality: 'OT',
        Rows: 1,
        Columns: 2,
        BitsAllocated: 8,
        BitsStored: 8,
        SamplesPerPixel: 3,
        PhotometricInterpretation: 'RGB',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, 0],
        InstanceNumber: 1,
      },
      pixels: new Uint8Array([255, 0, 0, 0, 255, 0]),
    },
  ], () => {}, 'local_rgb', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /single-sample|MONOCHROME/i);
});

test('buildDICOMSeriesResult fails closed on invalid BitsStored values', async () => {
  const skippedReasons = [];
  const result = await buildDICOMSeriesResult([
    {
      meta: {
        Modality: 'CT',
        Rows: 1,
        Columns: 2,
        BitsAllocated: 16,
        BitsStored: 0,
        PixelRepresentation: 0,
        PhotometricInterpretation: 'MONOCHROME2',
        PixelSpacing: [1, 1],
        SliceThickness: 1,
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, 0],
        InstanceNumber: 1,
      },
      pixels: new Uint16Array([1, 2]),
    },
  ], () => {}, 'local_bad_bits', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /BitsStored/i);
});

test('buildDICOMSeriesResult renders a single Pixel Padding Value as background and excludes it from auto-windowing', async () => {
  await withCanvasCapture(async (images) => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta({ PixelPaddingValue: 255 }),
      pixels: new Uint8Array([255, 10, 20]),
    }], () => {}, 'local_padding_value');

    assert.deepEqual(Array.from(result.rawVolume), [0, 0, 1]);
    assert.deepEqual(Array.from(images[0]), [
      0, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
  });
});

test('buildDICOMSeriesResult suppresses the inclusive Pixel Padding range', async () => {
  await withCanvasCapture(async (images) => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta({ Columns: 5, PixelPaddingValue: 0, PixelPaddingRangeLimit: 2 }),
      pixels: new Uint8Array([0, 1, 2, 10, 20]),
    }], () => {}, 'local_padding_range');

    assert.deepEqual(Array.from(result.rawVolume), [0, 0, 0, 0, 1]);
    assert.deepEqual(Array.from(images[0].slice(0, 12)), [
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
  });
});

test('buildDICOMSeriesResult recognizes signed packed 12-bit Pixel Padding Values in stored-value space', async () => {
  await withDocumentStub(async () => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta({
        BitsAllocated: 16,
        BitsStored: 12,
        PixelRepresentation: 1,
        PixelPaddingValue: -1000,
      }),
      pixels: new Uint16Array([0x0c18, 0x0800, 0x03e8]),
    }], () => {}, 'local_signed_12_padding');

    assert.deepEqual(Array.from(result.rawVolume), [0, 0, 1]);
  });
});

test('buildDICOMSeriesResult recognizes unsigned 16-bit Pixel Padding Values', async () => {
  await withDocumentStub(async () => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta({
        BitsAllocated: 16,
        BitsStored: 16,
        PixelPaddingValue: 65535,
      }),
      pixels: new Uint16Array([65535, 1000, 2000]),
    }], () => {}, 'local_unsigned_16_padding');

    assert.deepEqual(Array.from(result.rawVolume), [0, 0, 1]);
  });
});

test('buildDICOMSeriesResult rejects an image containing only Pixel Padding Values', async () => {
  const skippedReasons = [];
  const result = await buildDICOMSeriesResult([{
    meta: grayscaleMeta({ PixelPaddingValue: 0 }),
    pixels: new Uint8Array([0, 0, 0]),
  }], () => {}, 'local_all_padding', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /only Pixel Padding/i);
});

test('buildDICOMSeriesResult keeps untagged pixel values in auto-windowing and non-CT normalization', async () => {
  await withDocumentStub(async () => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta(),
      pixels: new Uint8Array([0, 10, 20]),
    }], () => {}, 'local_no_padding');

    assert.deepEqual(Array.from(result.rawVolume), [0, 0.5, 1]);
  });
});

test('buildDICOMSeriesResult accepts a correctly ordered MONOCHROME1 Pixel Padding range', async () => {
  await withCanvasCapture(async (images) => {
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta({
        Columns: 4,
        PhotometricInterpretation: 'MONOCHROME1',
        PixelPaddingValue: 255,
        PixelPaddingRangeLimit: 254,
      }),
      pixels: new Uint8Array([255, 254, 20, 10]),
    }], () => {}, 'local_padding_monochrome1');

    assert.ok(result);
    assert.deepEqual(Array.from(images[0].slice(0, 8)), [
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
  });
});

test('buildDICOMSeriesResult rejects malformed or reversed Pixel Padding metadata', async () => {
  for (const overrides of [
    { PixelPaddingValue: '' },
    { PixelPaddingValue: 2, PixelPaddingRangeLimit: 0 },
    { PixelPaddingRangeLimit: 2 },
  ]) {
    const skippedReasons = [];
    const result = await buildDICOMSeriesResult([{
      meta: grayscaleMeta(overrides),
      pixels: new Uint8Array([0, 10, 20]),
    }], () => {}, 'local_bad_padding', skippedReasons);
    assert.equal(result, null);
    assert.match(skippedReasons[0] || '', /Pixel Padding/i);
  }
});

test('buildDICOMSeriesResult rejects mixed pixel layouts within one series', async () => {
  const skippedReasons = [];
  const first = grayscaleMeta({ ImagePositionPatient: [0, 0, 0], InstanceNumber: 1 });
  const second = grayscaleMeta({
    BitsAllocated: 16,
    BitsStored: 16,
    ImagePositionPatient: [0, 0, 1],
    InstanceNumber: 2,
  });
  const result = await buildDICOMSeriesResult([
    { meta: first, pixels: new Uint8Array([0, 10, 20]) },
    { meta: second, pixels: new Uint16Array([0, 10, 20]) },
  ], () => {}, 'local_mixed_pixel_layout', skippedReasons);

  assert.equal(result, null);
  assert.match(skippedReasons[0] || '', /mixes pixel layouts/i);
});
