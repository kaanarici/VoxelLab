import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import dcmjs from 'dcmjs';

async function writeDataset(path, dataset) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dict.write()));
}

export async function writeTinyDicom(path, {
  instanceNumber = 1,
  z = 0,
  modality = 'CT',
  seriesUID = '1.2.826.0.1.3680043.10.543.20',
} = {}) {
  await writeDataset(path, {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      MediaStorageSOPInstanceUID: `1.2.826.0.1.3680043.10.543.${instanceNumber}`,
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    SOPInstanceUID: `1.2.826.0.1.3680043.10.543.${instanceNumber}`,
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: seriesUID,
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: modality,
    SeriesDescription: 'Local DICOM CT',
    Rows: 2,
    Columns: 2,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    PixelSpacing: [0.5, 0.5],
    SliceThickness: 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, z],
    InstanceNumber: instanceNumber,
    PixelData: new Uint16Array([1, 2, 3, 4]).buffer,
  });
}

export async function writeTinyDicomStack(testInfo, stem, options = {}) {
  const first = testInfo.outputPath(`${stem}-1.dcm`);
  const second = testInfo.outputPath(`${stem}-2.dcm`);
  await writeTinyDicom(first, { ...options, instanceNumber: 1, z: 0 });
  await writeTinyDicom(second, { ...options, instanceNumber: 2, z: 1 });
  return [first, second];
}

export async function writeTinySr(path, { sourceSeriesUID = '', sourceSlug = 'pending-source' } = {}) {
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
      MediaStorageSOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
    SOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: '1.2.826.0.1.3680043.10.543.88',
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: 'SR',
    SeriesDescription: 'Unsupported SR note',
  };
  if (sourceSeriesUID) {
    dataset.ReferencedSeriesSequence = [{ SeriesInstanceUID: sourceSeriesUID }];
    dataset.ContentSequence = [{
      ValueType: 'CONTAINER',
      ConceptNameCodeSequence: [{ CodeMeaning: 'Measurement Group' }],
      ContentSequence: [{
        ValueType: 'TEXT',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series' }],
        TextValue: `${sourceSlug} slice 1`,
      }, {
        ValueType: 'UIDREF',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Referenced Series UID' }],
        UID: sourceSeriesUID,
      }, {
        ValueType: 'NUM',
        ConceptNameCodeSequence: [{ CodeMeaning: 'Length' }],
        MeasuredValueSequence: [{ NumericValue: '4' }],
      }],
    }];
  }
  await writeDataset(path, dataset);
}

const SHARED_PIXEL_MEASURES = [{
  '00289110': { vr: 'SQ', Value: [{ '00280030': { vr: 'DS', Value: [0.5, 0.5] }, '00180050': { vr: 'DS', Value: [1.0] } }] },
  '00209116': { vr: 'SQ', Value: [{ '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] } }] },
}];

export function enhancedMetadataInstance({
  seriesUID = '1.2.series',
  sopInstanceUID = '1.2.sop.1',
  description = 'DICOMweb CT',
} = {}) {
  return {
    '00080060': { vr: 'CS', Value: ['CT'] },
    '0020000E': { vr: 'UI', Value: [seriesUID] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: [sopInstanceUID] },
    '0008103E': { vr: 'LO', Value: [description] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [16] },
    '00280101': { vr: 'US', Value: [16] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '52009229': { vr: 'SQ', Value: SHARED_PIXEL_MEASURES },
    '52009230': {
      vr: 'SQ',
      Value: [
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] } },
        { '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] } },
      ],
    },
  };
}

export function segMetadataInstance({
  seriesUID = '1.2.seg',
  sopInstanceUID = '1.2.seg.object',
  segmentationType = 'BINARY',
} = {}) {
  const perFrameGroups = [
    {
      '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 0] } }] },
      SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
    },
    {
      '00209113': { vr: 'SQ', Value: [{ '00200032': { vr: 'DS', Value: [0, 0, 1] } }] },
      SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
    },
  ];
  return {
    '00080060': { vr: 'CS', Value: ['SEG'] },
    '0020000E': { vr: 'UI', Value: [seriesUID] },
    '0020000D': { vr: 'UI', Value: ['1.2.study'] },
    '00080018': { vr: 'UI', Value: [sopInstanceUID] },
    '0008103E': { vr: 'LO', Value: ['Mask'] },
    '00620001': { vr: 'CS', Value: [segmentationType] },
    '00280008': { vr: 'IS', Value: [2] },
    '00280010': { vr: 'US', Value: [2] },
    '00280011': { vr: 'US', Value: [2] },
    '00280100': { vr: 'US', Value: [1] },
    '00200052': { vr: 'UI', Value: ['1.2.for'] },
    '52009229': { vr: 'SQ', Value: SHARED_PIXEL_MEASURES },
    '52009230': { vr: 'SQ', Value: perFrameGroups },
    '77770001': {
      vr: 'UN',
      Value: [{
        Modality: 'SEG',
        SeriesInstanceUID: seriesUID,
        SOPInstanceUID: sopInstanceUID,
        SeriesDescription: 'Mask',
        SegmentationType: segmentationType,
        Rows: 2,
        Columns: 2,
        BitsAllocated: 1,
        NumberOfFrames: 2,
        FrameOfReferenceUID: '1.2.for',
        ReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2.series' }],
        SegmentSequence: [{ SegmentNumber: 1, SegmentLabel: 'Mask' }],
        SharedFunctionalGroupsSequence: [{
          PixelMeasuresSequence: [{ PixelSpacing: [0.5, 0.5], SliceThickness: 1 }],
          PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
        }],
        PerFrameFunctionalGroupsSequence: [
          {
            PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
            SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
          },
          {
            PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
            SegmentIdentificationSequence: [{ ReferencedSegmentNumber: 1 }],
          },
        ],
      }],
    },
  };
}
