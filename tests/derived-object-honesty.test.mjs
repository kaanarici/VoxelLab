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

async function freshDerivedImportModule() {
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

test('local derived-object parser returns per-file skipped summaries for parse failures', async () => {
  const { readLocalDicomObjects } = await freshDerivedImportModule();
  const files = [
    {
      name: 'broken-seg.dcm',
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3]).buffer;
      },
    },
  ];
  const dcmjs = {
    data: {
      DicomMessage: {
        readFile() {
          throw new Error('bad dicom');
        },
      },
      DicomMetaDictionary: {
        naturalizeDataset() {
          return {};
        },
      },
    },
  };

  const result = await readLocalDicomObjects(files, dcmjs);

  assert.deepEqual(result.objects, []);
  assert.deepEqual(result.skipped, [
    { skipped: true, file: 'broken-seg.dcm', reason: 'dicom_parse_failed' },
  ]);
});

test('zero-contour RTSTRUCT import is skipped with accumulated contour reason counts', async () => {
  const { applyDerivedDataset } = await freshDerivedImportModule();
  const source = sourceSeries();
  const dataset = {
    meta: {
      Modality: 'RTSTRUCT',
      SeriesDescription: 'Bad contours',
      SOPInstanceUID: '1.2.rtstruct.bad',
      FrameOfReferenceUID: source.frameOfReferenceUID,
      StructureSetROISequence: [{ ROINumber: 1, ROIName: 'Lesion' }],
      ROIContourSequence: [{
        ReferencedROINumber: 1,
        ContourSequence: [
          {
            ContourGeometricType: 'OPEN_PLANAR',
            ContourData: [0, 0, 0, 1, 0, 0, 1, 1, 0],
          },
          {
            ContourGeometricType: 'CLOSED_PLANAR',
            ContourData: [0, 0, 0, 1, 0],
          },
        ],
      }],
    },
  };
  const result = applyDerivedDataset({ series: [source] }, dataset);

  assert.equal(result.skipped, true);
  assert.equal(result.kind, 'rtstruct');
  assert.match(result.reason, /^rtstruct_no_usable_contours/);
  assert.deepEqual(result.reasonCounts, {
    unsupported_contour_type: 1,
    invalid_contour_data: 1,
  });
});

test('applyDerivedDataset returns SEG encoding rejections without injecting an overlay', async () => {
  const { state } = await import('../js/core/state.js');
  const { applyDerivedDataset } = await freshDerivedImportModule();
  const source = sourceSeries();
  delete state._localRegionMetaBySlug[source.slug];
  delete state._localRegionLabelSlicesBySlug[source.slug];
  delete state._localStacks[`${source.slug}_regions`];

  const dataset = {
    meta: {
      Modality: 'SEG',
      SegmentationType: 'FRACTIONAL',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      Rows: 2,
      Columns: 2,
      BitsAllocated: 1,
      NumberOfFrames: 1,
      ReferencedSeriesSequence: [{ SeriesInstanceUID: source.sourceSeriesUID }],
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
  const result = applyDerivedDataset({ series: [source] }, dataset);

  assert.equal(result.skipped, true);
  assert.equal(result.reason.startsWith('segmentation_type_unsupported:'), true);
  assert.equal(state._localRegionLabelSlicesBySlug[source.slug], undefined);
  assert.equal(state._localRegionMetaBySlug[source.slug], undefined);

  const compressed = applyDerivedDataset({ series: [source] }, {
    ...dataset,
    meta: {
      ...dataset.meta,
      SegmentationType: 'BINARY',
      TransferSyntaxUID: '1.2.840.10008.1.2.4.90',
    },
  });
  assert.equal(compressed.skipped, true);
  assert.equal(compressed.reason.startsWith('seg_compressed_pixel_data_unsupported:'), true);
  assert.equal(state._localRegionLabelSlicesBySlug[source.slug], undefined);
  assert.equal(state._localRegionMetaBySlug[source.slug], undefined);
});

test('persisted derived SEG and RTDOSE entries do not hydrate against stale source geometry', async () => {
  const {
    buildDerivedRegistryEntry,
    clearDerivedRegistry,
    upsertDerivedRegistryEntry,
  } = await import('../js/derived-objects.js');
  const { state } = await import('../js/core/state.js');
  const { hydrateDerivedStateForSeries } = await freshDerivedImportModule();
  clearDerivedRegistry();

  const source = sourceSeries();
  upsertDerivedRegistryEntry(buildDerivedRegistryEntry({
    derivedKind: 'seg',
    sourceSeries: source,
    derivedSeries: source,
    objectUID: '1.2.seg',
    name: 'Persisted SEG',
    modality: 'SEG',
    payload: {
      format: 'seg-overlay-v1',
      sparseSlices: [[0, 1], []],
      regionMeta: {
        regions: { 1: { name: 'Tumor', source: 'dicom-seg' } },
        colors: { 1: [255, 0, 0] },
      },
    },
  }));
  upsertDerivedRegistryEntry(buildDerivedRegistryEntry({
    derivedKind: 'rtdose',
    sourceSeries: source,
    derivedSeries: { frameOfReferenceUID: source.frameOfReferenceUID },
    objectUID: '1.2.dose',
    name: 'Persisted dose',
    modality: 'RTDOSE',
    payload: {
      format: 'rtdose-summary-v1',
      rows: 2,
      cols: 2,
      frames: 1,
      doseGridScaling: 0.01,
      doseUnits: 'GY',
      doseType: 'PHYSICAL',
      doseSummationType: 'PLAN',
      frameOfReferenceUID: source.frameOfReferenceUID,
    },
  }));

  const staleSource = {
    ...source,
    firstIPP: [10, 0, 0],
    lastIPP: [10, 0, 1],
  };
  state._localDerivedObjects[staleSource.slug] = {};
  delete state._localRegionLabelSlicesBySlug[staleSource.slug];
  delete state._localRtDoseBySlug[staleSource.slug];

  const hydrated = hydrateDerivedStateForSeries(staleSource);

  assert.equal(hydrated.length, 0);
  assert.deepEqual(hydrated.skipped.map(item => [item.kind, item.reason]).sort(), [
    ['rtdose', 'derived_binding_geometry_mismatch'],
    ['seg', 'derived_binding_geometry_mismatch'],
  ]);
  assert.deepEqual(state._localDerivedObjects[staleSource.slug], {});
  assert.equal(state._localRegionLabelSlicesBySlug[staleSource.slug], undefined);
  assert.equal(state._localRtDoseBySlug[staleSource.slug], undefined);
});
