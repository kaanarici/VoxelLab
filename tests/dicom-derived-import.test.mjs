import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
  };
})();
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
    return {
      width: 0,
      height: 0,
      getContext() {
        return {
          createImageData(width, height) {
            return { data: new Uint8ClampedArray(width * height * 4) };
          },
          putImageData() {},
        };
      },
      toDataURL() {
        return 'data:image/png;base64,test';
      },
    };
  },
};
globalThis.Image = class {
  constructor() {
    this.src = '';
  }
};

async function freshModule() {
  const url = new URL(`../js/dicom/dicom-derived-import.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

function sourceSeries() {
  return {
    slug: 'src',
    name: 'Source',
    sourceSeriesUID: '1.2.src',
    frameOfReferenceUID: '1.2.for',
    width: 2,
    height: 2,
    slices: 2,
    pixelSpacing: [1, 1],
    sliceSpacing: 1,
    sliceThickness: 1,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    orientation: [1, 0, 0, 0, 1, 0],
  };
}

function validSegDataset(source, objectUID = '1.2.seg.import') {
  return {
    meta: {
      Modality: 'SEG',
      SOPInstanceUID: objectUID,
      SeriesDescription: 'Imported SEG',
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 1,
      ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
      FrameOfReferenceUID: source.frameOfReferenceUID,
      SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Tumor' }],
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [{
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
        SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
      }],
    },
    pixelData: { Value: [new Uint8Array([0b00001111]).buffer] },
  };
}

test('buildSegOverlayImport unpacks binary SEG frames onto the referenced source slices', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 2,
      SegmentSequence: [
        { SegmentNumber: 1, SegmentLabel: 'Tumor' },
        { SegmentNumber: 2, SegmentLabel: 'Edema' },
      ],
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        },
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 2 }],
        },
      ],
    },
    pixelData: {
      Value: [
        new Uint8Array([0b00001111]).buffer,
        new Uint8Array([0b00000010]).buffer,
      ],
    },
  }, sourceSeries());

  assert.equal(overlay.kind, 'seg');
  assert.equal(overlay.overlayKind, 'labels');
  assert.equal(overlay.legacySlot, 'regions');
  assert.deepEqual([...overlay.labelSlices[0]], [1, 1, 1, 1]);
  assert.deepEqual([...overlay.labelSlices[1]], [0, 2, 0, 0]);
  assert.equal(overlay.regionMeta.regions[1].name, 'Tumor');
  assert.equal(overlay.regionMeta.regions[2].name, 'Edema');
});

test('buildSegOverlayImport accepts already-unpacked one-byte DICOMweb SEG frames', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 2,
      SegmentSequence: [
        { SegmentNumber: 1, SegmentLabel: 'Tumor' },
        { SegmentNumber: 2, SegmentLabel: 'Edema' },
      ],
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        },
        {
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 2 }],
        },
      ],
    },
    pixelData: {
      Value: [
        new Uint8Array([1, 0, 1, 0]).buffer,
        new Uint8Array([0, 1, 0, 1]).buffer,
      ],
    },
  }, sourceSeries());

  assert.deepEqual([...overlay.labelSlices[0]], [1, 0, 1, 0]);
  assert.deepEqual([...overlay.labelSlices[1]], [0, 2, 0, 2]);
});

test('SEG attachment rejection leaves the registry, overlay buckets, and hydration state untouched', async () => {
  const { clearDerivedRegistry, loadDerivedRegistry } = await import('../js/derived-objects.js');
  const { state } = await import('../js/core/state.js');
  const { applyDerivedDataset } = await freshModule();
  const source = { ...sourceSeries(), slug: 'seg-transaction-rejected', hasRegions: true };
  clearDerivedRegistry();
  delete state._localDerivedObjects[source.slug];
  delete state._localRegionMetaBySlug[source.slug];
  delete state._localRegionLabelSlicesBySlug[source.slug];
  delete state._localStacks[`${source.slug}_regions`];

  const result = applyDerivedDataset({ series: [source] }, validSegDataset(source, '1.2.seg.rejected'));

  assert.deepEqual(result, {
    skipped: true,
    reason: 'Source already uses the region-overlay slot; refusing to overwrite it with imported SEG data',
    sourceSlug: source.slug,
    kind: 'seg',
  });
  assert.deepEqual(loadDerivedRegistry().entries, {});
  assert.equal(state._localDerivedObjects[source.slug], undefined);
  assert.equal(state._localRegionMetaBySlug[source.slug], undefined);
  assert.equal(state._localRegionLabelSlicesBySlug[source.slug], undefined);
  assert.equal(state._localStacks[`${source.slug}_regions`], undefined);
});

test('SEG attachment persists and attaches exactly once after preflight succeeds', async () => {
  const { clearDerivedRegistry, loadDerivedRegistry } = await import('../js/derived-objects.js');
  const { state } = await import('../js/core/state.js');
  const { applyDerivedDataset } = await freshModule();
  const source = { ...sourceSeries(), slug: 'seg-transaction-success' };
  const dataset = validSegDataset(source, '1.2.seg.success');
  clearDerivedRegistry();
  delete state._localDerivedObjects[source.slug];
  delete state._localRegionMetaBySlug[source.slug];
  delete state._localRegionLabelSlicesBySlug[source.slug];
  delete state._localStacks[`${source.slug}_regions`];

  const first = applyDerivedDataset({ series: [source] }, dataset);
  const second = applyDerivedDataset({ series: [source] }, dataset);
  const entries = Object.values(loadDerivedRegistry().entries);

  assert.equal(first.skipped, false);
  assert.equal(first.count, 1);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'Derived object 1.2.seg.success already imported');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].objectUID, '1.2.seg.success');
  assert.deepEqual(Object.keys(state._localDerivedObjects[source.slug]), ['1.2.seg.success']);
  assert.deepEqual([...state._localRegionLabelSlicesBySlug[source.slug][0]], [1, 1, 1, 1]);
  assert.equal(state._localRegionMetaBySlug[source.slug].regions[1].name, 'Tumor');
});

test('buildSegOverlayImport rejects fractional and compressed SEG pixel data', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const baseMeta = {
    Modality: 'SEG',
    Rows: 2,
    Columns: 2,
    BitsAllocated: 1,
    NumberOfFrames: 1,
    SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Tumor' }],
    SharedFunctionalGroupsSequence: [{
      PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    }],
    PerFrameFunctionalGroupsSequence: [{
      PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
      SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
    }],
  };
  const pixelData = { Value: [new Uint8Array([0b00001111]).buffer] };

  assert.throws(
    () => buildSegOverlayImport({ meta: { ...baseMeta, SegmentationType: 'FRACTIONAL', TransferSyntaxUID: '1.2.840.10008.1.2.1' }, pixelData }, sourceSeries()),
    /segmentation_type_unsupported/,
  );
  assert.throws(
    () => buildSegOverlayImport({ meta: { ...baseMeta, SegmentationType: 'BINARY', TransferSyntaxUID: '1.2.840.10008.1.2.4.90' }, pixelData }, sourceSeries()),
    /seg_compressed_pixel_data_unsupported/,
  );
});

test('buildSegOverlayImport rejects source-incompatible SEG frame orientation', async () => {
  const { buildSegOverlayImport } = await freshModule();
  assert.throws(
    () => buildSegOverlayImport({
      meta: {
        Modality: 'SEG',
        SegmentationType: 'BINARY',
        TransferSyntaxUID: '1.2.840.10008.1.2.1',
        Rows: 2,
        Columns: 2,
        BitsAllocated: 1,
        NumberOfFrames: 1,
        SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Rotated' }],
        SharedFunctionalGroupsSequence: [{
          PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
          PlaneOrientationSequence: [{ ImageOrientationPatient: [0, 1, 0, 1, 0, 0] }],
        }],
        PerFrameFunctionalGroupsSequence: [{
          PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        }],
      },
      pixelData: { Value: [new Uint8Array([0b00001111]).buffer] },
    }, sourceSeries()),
    /source voxel grid/i,
  );
});

test('buildSegOverlayImport rejects source-incompatible SEG frame origin', async () => {
  const { buildSegOverlayImport } = await freshModule();
  assert.throws(
    () => buildSegOverlayImport({
      meta: {
        Modality: 'SEG',
        SegmentationType: 'BINARY',
        TransferSyntaxUID: '1.2.840.10008.1.2.1',
        Rows: 2,
        Columns: 2,
        BitsAllocated: 1,
        NumberOfFrames: 1,
        SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Shifted' }],
        SharedFunctionalGroupsSequence: [{
          PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
          PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
        }],
        PerFrameFunctionalGroupsSequence: [{
          PlanePositionSequence: [{ ImagePositionPatient: [5, 0, 0] }],
          SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
        }],
      },
      pixelData: { Value: [new Uint8Array([0b00001111]).buffer] },
    }, sourceSeries()),
    /source voxel grid/i,
  );
});

test('buildSegOverlayImport does not invent SEG volume when source Z spacing is unknown', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const source = { ...sourceSeries(), slices: 1, sliceSpacing: 0, sliceThickness: 0, firstIPP: [0, 0, 0], lastIPP: [0, 0, 0] };
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 1,
      SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Tumor' }],
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [{
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
        SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
      }],
    },
    pixelData: { Value: [new Uint8Array([0b00001111]).buffer] },
  }, source);

  assert.equal(overlay.regionMeta.regions[1].mL, undefined);
});

test('buildSegOverlayImport does not report mL for irregular source stacks', async () => {
  const { buildSegOverlayImport } = await freshModule();
  const overlay = buildSegOverlayImport({
    meta: {
      Modality: 'SEG',
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 1,
      SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Tumor' }],
      SharedFunctionalGroupsSequence: [{
        PixelMeasuresSequence: [{ PixelSpacing: [1, 1], SliceThickness: 1 }],
        PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      }],
      PerFrameFunctionalGroupsSequence: [{
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
        SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
      }],
    },
    pixelData: { Value: [new Uint8Array([0b00001111]).buffer] },
  }, { ...sourceSeries(), sliceSpacingRegular: false });

  assert.equal(overlay.regionMeta.regions[1].mL, undefined);
});

test('hydrateDerivedStateForSeries normalizes persisted SEG imports as canonical labels overlays', async () => {
  const { buildDerivedRegistryEntry, clearDerivedRegistry, upsertDerivedRegistryEntry } = await import('../js/derived-objects.js');
  const { overlayKindsForSeries } = await import('../js/runtime/overlay-kinds.js');
  const { state } = await import('../js/core/state.js');
  const { hydrateDerivedStateForSeries } = await freshModule();
  clearDerivedRegistry();

  const source = sourceSeries();
  const entry = buildDerivedRegistryEntry({
    derivedKind: 'seg',
    sourceSeries: source,
    derivedSeries: source,
    objectUID: '9.8.7.seg',
    name: 'Imported SEG',
    modality: 'SEG',
    payload: {
      format: 'seg-overlay-v1',
      sparseSlices: [[0, 1, 3, 1], [1, 2]],
      regionMeta: {
        regions: {
          1: { name: 'Tumor', mL: 0.004, source: 'dicom-seg' },
          2: { name: 'Edema', mL: 0.001, source: 'dicom-seg' },
        },
        colors: {
          1: [255, 0, 0],
          2: [0, 255, 0],
        },
      },
    },
  });
  upsertDerivedRegistryEntry(entry);

  state._localDerivedObjects[source.slug] = {};
  delete state._localRegionMetaBySlug[source.slug];
  delete state._localRegionLabelSlicesBySlug[source.slug];
  delete state._localStacks[`${source.slug}_regions`];

  const hydrated = hydrateDerivedStateForSeries(source);
  const overlays = overlayKindsForSeries(source);

  assert.equal(hydrated.length, 1);
  assert.equal(source.hasRegions, true);
  assert.deepEqual(overlays.availableKinds, ['labels']);
  assert.equal(overlays.byKind.labels.source, 'dicom-seg');
  assert.deepEqual(overlays.byKind.labels.legacyKinds, ['regions', 'seg']);
});

test('buildRTStructImport maps CLOSED_PLANAR contours into source-slice ROI polygons', async () => {
  const { buildRTStructImport } = await freshModule();
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Lesion' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 0,
              0, 1, 0,
            ],
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.equal(result.kind, 'rtstruct');
  assert.equal(result.roisBySlice['0'][0].shape, 'polygon');
  assert.equal(result.roisBySlice['0'][0].text, 'Lesion');
  assert.equal(result.roisBySlice['0'][0].pts.length, 4);
  assert.ok(result.roisBySlice['0'][0].stats.area_mm2 > 0);
});

test('buildRTStructImport skips contours when source spacing is unknown', async () => {
  const { buildRTStructImport } = await freshModule();
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [{ ROINumber: 1, ROIName: 'Uncalibrated' }],
    ROIContourSequence: [{
      ReferencedROINumber: 1,
      ContourSequence: [{
        ContourGeometricType: 'CLOSED_PLANAR',
        ContourData: [
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ],
      }],
    }],
  }, { ...sourceSeries(), pixelSpacing: [0, 0] });

  assert.deepEqual(result.roisBySlice, {});
});

test('buildRTStructImport skips contours that do not land near a real source slice plane', async () => {
  const { buildRTStructImport } = await freshModule();
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Off plane' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 2.5,
              0, 1, 2.5,
            ],
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.deepEqual(result.roisBySlice, {});
});

test('buildRTStructImport skips contours when the source affine is not invertible', async () => {
  const { buildRTStructImport } = await freshModule();
  const degenerate = { ...sourceSeries(), orientation: [1, 0, 0, 1, 0, 0] };
  const result = buildRTStructImport({
    Modality: 'RTSTRUCT',
    StructureSetROISequence: [
      { ROINumber: 1, ROIName: 'Degenerate' },
    ],
    ROIContourSequence: [
      {
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [
              0, 0, 0,
              1, 0, 0,
              1, 1, 0,
              0, 1, 0,
            ],
          },
        ],
      },
    ],
  }, degenerate);

  assert.deepEqual(result.roisBySlice, {});
});

test('buildSRImport converts viewer-style measurement groups into slice annotations', async () => {
  const { buildSRImport } = await freshModule();
  const result = buildSRImport({
    Modality: 'SR',
    ContentSequence: [
      {
        ValueType: 'CONTAINER',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
        ContentSequence: [
          {
            ValueType: 'TEXT',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
            TextValue: 'src slice 2',
          },
          {
            ValueType: 'NUM',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
            MeasuredValueSequence: [{ NumericValue: '12.5' }],
          },
          {
            ValueType: 'TEXT',
            ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
            TextValue: 'Follow-up target',
          },
        ],
      },
    ],
  }, sourceSeries());

  assert.equal(result.kind, 'sr');
  assert.equal(result.annotationsBySlice['1'].length, 1);
  assert.match(result.annotationsBySlice['1'][0].text, /Length: 12.5/);
  assert.match(result.annotationsBySlice['1'][0].text, /Comment: Follow-up target/);
});

test('buildSRImport accepts a changed local slug when the source SeriesInstanceUID matches', async () => {
  const { buildSRImport } = await freshModule();
  const source = { ...sourceSeries(), slug: 'local_new_source' };
  const result = buildSRImport({
    Modality: 'SR',
    ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
    ContentSequence: [{
      ValueType: 'CONTAINER',
      ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
      ContentSequence: [{
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
        TextValue: 'local_old_source slice 1',
      }, {
        ValueType: 'NUM',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
        MeasuredValueSequence: [{ NumericValue: '4' }],
      }],
    }],
  }, source);

  assert.equal(result.annotationsBySlice['0'].length, 1);
});

test('SR stable SeriesInstanceUID mismatches cannot attach through a matching slug', async () => {
  const { applyDerivedSr, buildSRImport } = await freshModule();
  const source = sourceSeries();
  const meta = {
    Modality: 'SR',
    SOPInstanceUID: '1.2.sr.conflicting-uid',
    ReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2.other-source' }],
    ContentSequence: [{
      ValueType: 'CONTAINER',
      ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
      ContentSequence: [{
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
        TextValue: 'src slice 1',
      }, {
        ValueType: 'NUM',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
        MeasuredValueSequence: [{ NumericValue: '4' }],
      }],
    }],
  };

  assert.throws(() => buildSRImport(meta, source), /viewer-exported measurement notes/i);
  const result = applyDerivedSr({ series: [source] }, meta);
  assert.equal(result.skipped, true);
  assert.equal(result.reasonCode, 'source_not_loaded');
  assert.match(result.reason, /1\.2\.other-source/);
});

test('SRs without a stable SeriesInstanceUID retain legacy slug attachment', async () => {
  const { applyDerivedSr } = await freshModule();
  const source = { ...sourceSeries(), slug: 'legacy-sr-source' };
  const result = applyDerivedSr({ series: [source] }, {
    Modality: 'SR',
    SOPInstanceUID: '1.2.sr.legacy-slug',
    ContentSequence: [{
      ValueType: 'CONTAINER',
      ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
      ContentSequence: [{
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
        TextValue: 'legacy-sr-source slice 1',
      }, {
        ValueType: 'NUM',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
        MeasuredValueSequence: [{ NumericValue: '4' }],
      }],
    }],
  });

  assert.equal(result.skipped, false);
  assert.equal(result.sourceSlug, source.slug);
  assert.equal(result.kind, 'sr');
});

test('applyDerivedDataset rejects unmatchable objects instead of queueing them forever', async () => {
  const { applyDerivedDataset } = await freshModule();
  const result = applyDerivedDataset({ series: [] }, {
    meta: { Modality: 'SEG', SOPInstanceUID: '1.2.no-source-reference' },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reasonCode, 'source_reference_missing');
  assert.match(result.reason, /no usable source/i);
});

test('buildSRImport traverses broad SR content without shift churn', async () => {
  const { buildSRImport } = await freshModule();
  const groups = Array.from({ length: 512 }, (_, index) => ({
    ValueType: 'CONTAINER',
    ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
    ContentSequence: [
      {
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
        TextValue: 'src slice 1',
      },
      {
        ValueType: 'NUM',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Index' }],
        MeasuredValueSequence: [{ NumericValue: String(index) }],
      },
    ],
  }));

  const result = buildSRImport({
    Modality: 'SR',
    ContentSequence: [
      {
        ValueType: 'CONTAINER',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Report Root' }],
        ContentSequence: groups,
      },
    ],
  }, sourceSeries());

  assert.equal(result.annotationsBySlice['0'].length, groups.length);
  assert.match(result.annotationsBySlice['0'][511].text, /Index: 511/);
});

test('buildSRImport rejects SR groups without explicit VoxelLab slice references', async () => {
  const { buildSRImport } = await freshModule();

  assert.throws(
    () => buildSRImport({
      Modality: 'SR',
      ContentSequence: [
        {
          ValueType: 'CONTAINER',
          ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
          ContentSequence: [
            {
              ValueType: 'TEXT',
              ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
              TextValue: 'Clinical SR image reference',
            },
            {
              ValueType: 'TEXT',
              ConceptNameCodeSequence: [{ CodeMeaning: 'Comment' }],
              TextValue: 'Imported note',
            },
          ],
        },
      ],
    }, sourceSeries()),
    /viewer-exported measurement notes/i,
  );
});

test('buildRtDoseImport normalizes dose metadata without claiming rendering', async () => {
  const { buildRtDoseImport } = await freshModule();
  const result = buildRtDoseImport({
    Modality: 'RTDOSE',
    Rows: 32,
    Columns: 16,
    NumberOfFrames: 4,
    DoseGridScaling: '0.001',
    DoseUnits: 'GY',
    DoseType: 'PHYSICAL',
    DoseSummationType: 'PLAN',
    FrameOfReferenceUID: '1.2.for',
  }, sourceSeries());

  assert.equal(result.kind, 'rtdose');
  assert.equal(result.summary.format, 'rtdose-summary-v1');
  assert.equal(result.summary.rows, 32);
  assert.equal(result.summary.cols, 16);
  assert.equal(result.summary.frames, 4);
  assert.equal(result.summary.doseUnits, 'GY');
  assert.equal(result.summary.doseType, 'PHYSICAL');
});

test('buildRtDoseImport rejects invalid required grid metadata', async () => {
  const { buildRtDoseImport } = await freshModule();
  const valid = {
    Modality: 'RTDOSE',
    FrameOfReferenceUID: '1.2.for',
    Rows: 32,
    Columns: 16,
    NumberOfFrames: 4,
    DoseGridScaling: 0.001,
  };
  for (const [field, value] of [
    ['Rows', 0],
    ['Columns', Number.NaN],
    ['NumberOfFrames', Infinity],
    ['NumberOfFrames', 1.5],
    ['DoseGridScaling', -0.001],
  ]) {
    assert.throws(
      () => buildRtDoseImport({ ...valid, [field]: value }, sourceSeries()),
      new RegExp(`rtdose_invalid_${field}`),
    );
  }
});

test('buildRtDoseImport treats an omitted NumberOfFrames as one 2D dose plane', async () => {
  const { buildRtDoseImport } = await freshModule();
  const result = buildRtDoseImport({
    Modality: 'RTDOSE',
    FrameOfReferenceUID: '1.2.for',
    Rows: 32,
    Columns: 16,
    DoseGridScaling: 0.001,
  }, sourceSeries());

  assert.equal(result.summary.frames, 1);
});

test('buildRtDoseImport requires matching RT Dose and source FrameOfReferenceUID values', async () => {
  const { buildRtDoseImport } = await freshModule();
  const meta = {
    Modality: 'RTDOSE',
    Rows: 32,
    Columns: 16,
    DoseGridScaling: 0.001,
  };

  assert.throws(
    () => buildRtDoseImport(meta, sourceSeries()),
    /rtdose_frame_of_reference_missing/,
  );
  assert.throws(
    () => buildRtDoseImport({ ...meta, FrameOfReferenceUID: '1.2.for' }, { ...sourceSeries(), frameOfReferenceUID: '' }),
    /rtdose_frame_of_reference_missing/,
  );
  assert.throws(
    () => buildRtDoseImport(meta, { ...sourceSeries(), frameOfReferenceUID: '' }),
    /rtdose_frame_of_reference_missing/,
  );
  assert.throws(
    () => buildRtDoseImport({ ...meta, FrameOfReferenceUID: '1.2.other' }, sourceSeries()),
    /rtdose_frame_of_reference_mismatch/,
  );
  assert.equal(
    buildRtDoseImport({ ...meta, FrameOfReferenceUID: '1.2.for' }, sourceSeries()).summary.frameOfReferenceUID,
    '1.2.for',
  );
});

test('RTDOSE FrameOfReferenceUID rejections happen before registry or runtime mutation', async () => {
  const { clearDerivedRegistry, loadDerivedRegistry } = await import('../js/derived-objects.js');
  const { state } = await import('../js/core/state.js');
  const { applyDerivedDataset } = await freshModule();
  for (const [label, sourcePatch, doseFrameOfReferenceUID, reason] of [
    ['missing-dose', {}, '', 'rtdose_frame_of_reference_missing'],
    ['missing-source', { frameOfReferenceUID: '' }, '1.2.for', 'rtdose_frame_of_reference_missing'],
    ['both-missing', { frameOfReferenceUID: '' }, '', 'rtdose_frame_of_reference_missing'],
    ['conflict', {}, '1.2.other-frame', 'rtdose_frame_of_reference_mismatch'],
  ]) {
    const source = { ...sourceSeries(), ...sourcePatch, slug: `rtdose-frame-${label}` };
    clearDerivedRegistry();
    delete state._localDerivedObjects[source.slug];
    delete state._localRtDoseBySlug[source.slug];

    const result = applyDerivedDataset({ series: [source] }, {
      meta: {
        Modality: 'RTDOSE',
        SOPInstanceUID: `1.2.rtdose.${label}`,
        ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
        FrameOfReferenceUID: doseFrameOfReferenceUID,
        Rows: 2,
        Columns: 2,
        NumberOfFrames: 1,
        DoseGridScaling: 0.001,
      },
    });

    assert.deepEqual(result, {
      skipped: true,
      reason,
      sourceSlug: source.slug,
      kind: 'rtdose',
    });
    assert.deepEqual(loadDerivedRegistry().entries, {});
    assert.equal(state._localDerivedObjects[source.slug], undefined);
    assert.equal(state._localRtDoseBySlug[source.slug], undefined);
  }
});

test('hydrateDerivedStateForSeries consumes persisted derived registry entries', async () => {
  const { buildDerivedRegistryEntry, clearDerivedRegistry, upsertDerivedRegistryEntry } = await import('../js/derived-objects.js');
  const { state } = await import('../js/core/state.js');
  const { hydrateDerivedStateForSeries } = await freshModule();
  clearDerivedRegistry();

  const source = sourceSeries();
  const entry = buildDerivedRegistryEntry({
    derivedKind: 'rtdose',
    sourceSeries: source,
    derivedSeries: { frameOfReferenceUID: source.frameOfReferenceUID || '1.2.3' },
    objectUID: '9.8.7.6',
    name: 'Plan dose',
    modality: 'RTDOSE',
    payload: {
      format: 'rtdose-summary-v1',
      rows: 4,
      cols: 4,
      frames: 2,
      doseGridScaling: 0.01,
      doseUnits: 'GY',
      doseType: 'PHYSICAL',
      doseSummationType: 'PLAN',
      frameOfReferenceUID: '1.2.3',
    },
  });
  upsertDerivedRegistryEntry(entry);

  state._localDerivedObjects[source.slug] = {};
  delete state._localRtDoseBySlug[source.slug];

  const hydrated = hydrateDerivedStateForSeries(source);
  assert.equal(hydrated.length, 1);
  assert.equal(state._localDerivedObjects[source.slug]['9.8.7.6'].kind, 'rtdose');
  assert.equal(state._localRtDoseBySlug[source.slug][0].summary.doseUnits, 'GY');
});
