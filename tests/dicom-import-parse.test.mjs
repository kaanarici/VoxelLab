import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const {
  buildDICOMSeriesResult,
  classifyDICOMImport,
  dicomSeriesGroupKey,
  extractEnhancedMultiFrameMetas,
  extractEnhancedMultiFramePixels,
  parseNIfTI,
} = await import('../js/dicom/dicom-import-parse.js');
const { seriesCompareGroup } = await import('../js/core/geometry.js');
const { calibratedScaleBarModel } = await import('../js/overlay/scale-bar.js');

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

function tinyNiftiFile({
  littleEndian = true,
  datatype = 4,
  values = [0, 256, 512, 1024],
  pixdim = [1, 1, 1],
  xyztUnits = 2,
  name,
} = {}) {
  const bytesPerVoxel = datatype === 2 ? 1 : datatype === 64 ? 8 : datatype === 4 || datatype === 512 ? 2 : 4;
  const buffer = new ArrayBuffer(352 + values.length * bytesPerVoxel);
  const view = new DataView(buffer);
  const writeInt16 = (offset, value) => view.setInt16(offset, value, littleEndian);
  const writeFloat32 = (offset, value) => view.setFloat32(offset, value, littleEndian);
  view.setInt32(0, 348, littleEndian);
  writeInt16(40, 3);
  writeInt16(42, 2);
  writeInt16(44, 2);
  writeInt16(46, 1);
  writeInt16(70, datatype);
  writeFloat32(76 + 4, pixdim[0]);
  writeFloat32(76 + 8, pixdim[1]);
  writeFloat32(76 + 12, pixdim[2]);
  writeFloat32(108, 352);
  view.setUint8(123, xyztUnits);
  values.forEach((value, index) => {
    const offset = 352 + index * bytesPerVoxel;
    if (datatype === 2) view.setUint8(offset, value);
    else if (datatype === 4) view.setInt16(offset, value, littleEndian);
    else if (datatype === 512) view.setUint16(offset, value, littleEndian);
    else if (datatype === 8) view.setInt32(offset, value, littleEndian);
    else if (datatype === 16) view.setFloat32(offset, value, littleEndian);
    else if (datatype === 64) view.setFloat64(offset, value, littleEndian);
  });
  return {
    name: name || (littleEndian ? 'tiny-le.nii' : 'tiny-be.nii'),
    async arrayBuffer() {
      return buffer;
    },
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

test('parseNIfTI decodes big-endian voxel payloads with the header byte order', async () => {
  await withDocumentStub(async () => {
    const result = await parseNIfTI(tinyNiftiFile({ littleEndian: false }));

    assert.ok(result);
    assert.equal(result.entry.name, 'tiny-be');
    assert.deepEqual(Array.from(result.rawVolume), [0, 0.25, 0.5, 1]);
  });
});

test('parseNIfTI decodes supported little-endian scalar datatypes', async () => {
  const cases = [
    { datatype: 2, values: [0, 1, 2, 4] },
    { datatype: 4, values: [-2, 0, 2, 6] },
    { datatype: 8, values: [-10, 0, 10, 30] },
    { datatype: 16, values: [0, 0.5, 1, 2] },
    { datatype: 64, values: [1, 2, 3, 5] },
    { datatype: 512, values: [0, 256, 512, 1024] },
  ];

  await withDocumentStub(async () => {
    for (const item of cases) {
      const result = await parseNIfTI(tinyNiftiFile({
        datatype: item.datatype,
        values: item.values,
        name: `datatype-${item.datatype}.nii`,
      }));

      assert.ok(result, `datatype ${item.datatype} should parse`);
      assert.deepEqual(
        Array.from(result.rawVolume, value => Number(value.toFixed(6))),
        [0, 0.25, 0.5, 1],
      );
    }
  });
});

test('parseNIfTI fails closed on 4D time-series volumes', async () => {
  const file = tinyNiftiFile({ name: 'fmri-timeseries.nii' });
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  view.setInt16(40, 4, true);
  view.setInt16(48, 2, true);

  await assert.rejects(
    () => parseNIfTI({ name: file.name, async arrayBuffer() { return buffer; } }),
    /4D\/time-series or higher-dimensional NIfTI files are not supported yet; split or export a single 3D volume before importing/,
  );
});

test('parseNIfTI uses native gzip streams for .nii.gz payloads when available', async () => {
  await withDocumentStub(async () => {
    const nativeDecompressionStream = globalThis.DecompressionStream;
    assert.equal(typeof nativeDecompressionStream, 'function');
    const formats = [];
    globalThis.DecompressionStream = class CountingDecompressionStream {
      constructor(format) {
        formats.push(format);
        return new nativeDecompressionStream(format);
      }
    };

    try {
      const source = tinyNiftiFile();
      const buffer = await source.arrayBuffer();
      const gzipped = gzipSync(new Uint8Array(buffer));
      const result = await parseNIfTI({
        name: 'tiny-le.NII.GZ',
        async arrayBuffer() {
          return gzipped.buffer.slice(gzipped.byteOffset, gzipped.byteOffset + gzipped.byteLength);
        },
      });

      assert.ok(result);
      assert.equal(result.entry.name, 'tiny-le');
      assert.deepEqual(Array.from(result.rawVolume), [0, 0.25, 0.5, 1]);
      assert.deepEqual(formats, ['gzip']);
    } finally {
      globalThis.DecompressionStream = nativeDecompressionStream;
    }
  });
});

test('parseNIfTI converts xyzt spatial units to VoxelLab millimeters', async () => {
  await withDocumentStub(async () => {
    const meters = await parseNIfTI(tinyNiftiFile({
      name: 'meter-units.nii',
      xyztUnits: 1,
      pixdim: [0.002, 0.003, 0.004],
    }));
    assert.deepEqual(meters.entry.pixelSpacing.map(value => Number(value.toFixed(6))), [3, 2]);
    assert.equal(Number(meters.entry.sliceThickness.toFixed(6)), 4);
    assert.equal(meters.entry._spacingKnown, true);
    assert.equal(meters.entry._niftiSpatialUnit, 'meter');
    assert.deepEqual(meters.entry.sourceFiles, ['meter-units.nii']);

    const microns = await parseNIfTI(tinyNiftiFile({
      name: 'micron-units.nii',
      xyztUnits: 3,
      pixdim: [250, 500, 750],
    }));
    assert.deepEqual(microns.entry.pixelSpacing.map(value => Number(value.toFixed(6))), [0.5, 0.25]);
    assert.equal(Number(microns.entry.sliceThickness.toFixed(6)), 0.75);
    assert.equal(microns.entry._spacingKnown, true);
    assert.equal(microns.entry._niftiSpatialUnit, 'micron');
  });
});

test('parseNIfTI disables calibrated spacing when xyzt spatial units are unknown', async () => {
  await withDocumentStub(async () => {
    const result = await parseNIfTI(tinyNiftiFile({
      name: 'unknown-units.nii',
      xyztUnits: 0,
      pixdim: [2, 3, 4],
    }));

    assert.deepEqual(result.entry.pixelSpacing, [0, 0]);
    assert.equal(result.entry.sliceThickness, 0);
    assert.equal(result.entry._spacingKnown, false);
    assert.equal(result.entry._niftiSpatialUnit, 'unknown');
    assert.deepEqual(result.entry.sourceFiles, ['unknown-units.nii']);
    assert.equal(calibratedScaleBarModel(result.entry, {
      canvasCssWidth: result.entry.width,
      imageWidth: result.entry.width,
      zoom: 1,
    }), null);
  });
});

test('parseNIfTI normalizes sform RAS coordinates into VoxelLab LPS geometry', async () => {
  await withDocumentStub(async () => {
    const file = tinyNiftiFile({ littleEndian: true });
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    view.setUint8(123, 3);
    view.setInt16(254, 1, true);
    view.setFloat32(280, 2000, true);
    view.setFloat32(284, 0, true);
    view.setFloat32(288, 0, true);
    view.setFloat32(292, 10000, true);
    view.setFloat32(296, 0, true);
    view.setFloat32(300, 3000, true);
    view.setFloat32(304, 0, true);
    view.setFloat32(308, 20000, true);
    view.setFloat32(312, 0, true);
    view.setFloat32(316, 0, true);
    view.setFloat32(320, 4000, true);
    view.setFloat32(324, 30000, true);

    const result = await parseNIfTI({ name: 'ras-sform.nii', async arrayBuffer() { return buffer; } });

    assert.deepEqual(result.entry.pixelSpacing, [3, 2]);
    assert.deepEqual(result.entry.orientation.map(value => (Object.is(value, -0) ? 0 : value)), [-1, 0, 0, 0, -1, 0]);
    assert.deepEqual(result.entry.firstIPP, [-10, -20, 30]);
    assert.equal(result.entry._niftiSpatialUnit, 'micron');
  });
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
