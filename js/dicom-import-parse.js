// DICOM parsing with robust handling of real-world DICOM variations.
// Compressed transfer syntaxes are routed through dicom-codecs.js and fail
// closed when the browser cannot recover medically faithful pixel samples.
//
// Correctness notes:
//   - Slice ordering: uses ImagePositionPatient (spatial) when available,
//     falls back to InstanceNumber (acquisition order). IPP sorting is
//     critical for non-axial acquisitions where InstanceNumber may not
//     correspond to spatial position.
//   - BitsStored vs BitsAllocated: masks pixel values to BitsStored to
//     discard padding bits in the upper portion of the allocated word.
//   - PhotometricInterpretation: handles MONOCHROME1 (inverted) by
//     flipping the pixel values after windowing.
//   - PixelSpacing: treated as optional. When absent, measurements are
//     disabled (pixelSpacing = [0, 0]) rather than assuming 1mm.
//   - RescaleSlope/Intercept: applied per-slice (can vary per frame in
//     enhanced DICOM, though we read per-file for now).
//   - WindowCenter/WindowWidth: read from DICOM tags. If absent,
//     auto-computed from the 2nd-98th percentile of the pixel data
//     (not min/max, which is dominated by outliers).

import { isCompressed, decodePixelData } from './dicom-codecs.js';
import { CT_HU_LO, CT_HU_HI } from './constants.js';
import { DCMJS_IMPORT_URL } from './dependencies.js';
import {
  frameMetasForInstance,
} from './dicom-frame-meta.js';
import {
  classifyDICOMImport,
  geometryKindForImportKind,
  importRestrictionReason,
  reconstructionCapabilityForGeometryKind,
} from './dicom-import-classify.js';
import {
  groupDatasetsBySeries,
  isDerivedObjectModality,
  parseSourceManifests,
} from './dicom-import-routing.js';
import {
  DEFAULT_IOP,
  geometryFromDicomMetas,
  sortDatasetsSpatially,
} from './geometry.js';
import { getFloat, getInt, getStr, normalizeModality } from './dicom-meta.js';
import {
  arrayBufferForBytes,
  bytesFromValue,
  pixelDataRestrictionReason,
  typedPixelsFromBytes,
} from './dicom-pixel-data.js';
import { parseDicomFilesInWorker } from './volume-worker-client.js';

export { extractEnhancedMultiFrameMetas } from './dicom-frame-meta.js';
export { classifyDICOMImport } from './dicom-import-classify.js';
export { dicomSeriesGroupKey } from './dicom-import-routing.js';
export { parseNIfTI } from './nifti-import-parse.js';

let dcmjs = null;

async function ensureDcmjs() {
  if (dcmjs) return dcmjs;
  dcmjs = await import(DCMJS_IMPORT_URL);
  return dcmjs;
}

function stripBasicOffsetTable(values, frameCount) {
  if (values.length !== frameCount + 1) return values;
  const first = bytesFromValue(values[0]);
  if (!first || first.byteLength % 4 !== 0) return values;
  return values.slice(1);
}

/** Expand an enhanced multi-frame instance into per-frame `{ meta, pixels|encodedValue }` records. */
export function extractEnhancedMultiFramePixels(item) {
  const meta = item?.meta || item;
  const pixelData = item?.pixelData || meta?.PixelData;
  const frameCount = getInt(meta, 'NumberOfFrames', 1);
  const rows = getInt(meta, 'Rows');
  const cols = getInt(meta, 'Columns');
  const bitsAllocated = getInt(meta, 'BitsAllocated', 16);
  const pixelRepresentation = getInt(meta, 'PixelRepresentation', 0);
  const frameMetas = frameMetasForInstance(meta);

  if (!pixelData || !frameMetas || frameMetas.length !== frameCount || !rows || !cols) return null;

  const values = Array.isArray(pixelData?.Value) ? pixelData.Value : [];
  const inlineBinary = pixelData?.InlineBinary;
  const framePixelCount = rows * cols;
  const frameByteCount = framePixelCount * (bitsAllocated <= 8 ? 1 : 2);
  const transferSyntax = getStr(meta, 'TransferSyntaxUID');

  const frames = [];
  if (!isCompressed(transferSyntax)) {
    const bytes = bytesFromValue(values[0] ?? inlineBinary);
    if (!bytes || bytes.byteLength < frameCount * frameByteCount) return null;
    for (let i = 0; i < frameCount; i++) {
      const frameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + (i * frameByteCount), frameByteCount);
      const pixels = typedPixelsFromBytes(frameBytes, bitsAllocated, pixelRepresentation, framePixelCount);
      if (!pixels) return null;
      frames.push({ meta: frameMetas[i], pixels });
    }
    return frames;
  }

  const encodedValues = stripBasicOffsetTable(values, frameCount);
  if (encodedValues.length !== frameCount) return null;
  return encodedValues.map((value, index) => ({
    meta: frameMetas[index],
    encodedValue: value,
  }));
}

// Sort slices spatially by ImagePositionPatient when available.
// Falls back to InstanceNumber. IPP sorting projects each slice's
// position onto the slice normal (cross product of IOP row × col)
// and sorts by that scalar — correct for any acquisition plane.
function sortSlicesSpatially(datasets) {
  const sorted = sortDatasetsSpatially(datasets, (item) => item.meta);
  datasets.splice(0, datasets.length, ...sorted);
}

// Auto W/L from percentiles (more robust than min/max)
function autoWindowLevel(pixels, count, slope, intercept) {
  // Sample up to 50k pixels for speed
  const step = Math.max(1, Math.floor(count / 50000));
  const samples = [];
  for (let i = 0; i < count; i += step) {
    samples.push(pixels[i] * slope + intercept);
  }
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.02)];
  const hi = samples[Math.floor(samples.length * 0.98)];
  const ww = Math.max(1, hi - lo);
  const wl = (lo + hi) / 2;
  return { wl, ww };
}

/** Parse local DICOM files into one or more importable series groups. */
export async function parseDICOMFileGroups(files, onProgress = () => {}) {
  onProgress('parsing', `reading ${files.length} files...`);
  let datasets = [];
  let sourceManifests = new Map();
  let workerParsed = false;

  const canCloneFilesToWorker = typeof File !== 'undefined'
    && files.every(file => file instanceof File);
  if (typeof Worker !== 'undefined' && canCloneFilesToWorker) {
    const parsed = await parseDicomFilesInWorker(files, onProgress);
    if (parsed?.datasets?.length) {
      datasets = parsed.datasets;
      sourceManifests = new Map(Object.entries(parsed.sourceManifests || {}));
      workerParsed = true;
    }
  }

  if (!workerParsed) {
    const lib = await ensureDcmjs();
    const DicomMessage = lib.data.DicomMessage;
    sourceManifests = await parseSourceManifests(files);
    let parsed = 0;
    for (const file of files) {
      try {
        const ab = await file.arrayBuffer();
        const ds = DicomMessage.readFile(ab);
        const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
        if (!meta.PixelData) continue;
        datasets.push({ meta, pixelData: ds.dict['7FE00010'], file });
        parsed++;
        if (parsed % 10 === 0) onProgress('parsing', `${parsed} / ${files.length}`);
      } catch {
        // Skip unparseable files
      }
    }
  }

  if (!datasets.length) return null;
  const groups = groupDatasetsBySeries(datasets);
  const renderableGroups = groups.filter((group) => !isDerivedObjectModality(group.datasets[0]?.meta?.Modality));
  for (const group of renderableGroups) {
    const seriesUID = String(group.datasets[0]?.meta?.SeriesInstanceUID || '');
    group.sourceManifest = sourceManifests.get(seriesUID) || null;
  }
  onProgress('sorting', `${datasets.length} valid slices · ${renderableGroups.length} image series`);

  const seed = Date.now().toString(36);
  const results = [];
  const skippedReasons = [];
  for (let i = 0; i < renderableGroups.length; i++) {
    const slug = renderableGroups.length === 1 ? `local_${seed}` : `local_${seed}_${i + 1}`;
    const result = await buildDICOMSeriesResult(
      renderableGroups[i].datasets,
      onProgress,
      slug,
      skippedReasons,
      renderableGroups[i].sourceManifest,
    );
    if (result) results.push(result);
  }
  if (!results.length && skippedReasons.length) {
    throw new Error(skippedReasons.join(' | '));
  }
  return results.length ? results : null;
}

/** Parse local DICOM files and return the first importable series result. */
export async function parseDICOMFiles(files, onProgress = () => {}) {
  const groups = await parseDICOMFileGroups(files, onProgress);
  return groups?.[0] || null;
}

/** Convert a grouped DICOM stack into viewer-ready canvases, manifest metadata, and raw voxels. */
export async function buildDICOMSeriesResult(inputDatasets, onProgress = () => {}, slug, skippedReasons = [], sourceManifest = null) {
  let datasets = inputDatasets.slice();
  const initialClassification = classifyDICOMImport(datasets, sourceManifest);
  const restrictionReason = importRestrictionReason(initialClassification);
  if (restrictionReason) {
    skippedReasons.push(restrictionReason);
    return null;
  }

  if (datasets.length === 1 && getInt(datasets[0].meta, 'NumberOfFrames', 1) > 1) {
    const expandedFrames = extractEnhancedMultiFramePixels(datasets[0]);
    if (expandedFrames) datasets = expandedFrames;
  }

  // Spatial sort (IPP when possible).
  sortSlicesSpatially(datasets);
  const importClassification = classifyDICOMImport(datasets, sourceManifest);
  const postExpansionRestriction = importRestrictionReason(importClassification);
  if (postExpansionRestriction) {
    skippedReasons.push(postExpansionRestriction);
    return null;
  }

  const first = datasets[0].meta;
  const rows = getInt(first, 'Rows');
  const cols = getInt(first, 'Columns');
  if (!rows || !cols) return null;
  const pixelRestriction = pixelDataRestrictionReason(first);
  if (pixelRestriction) {
    skippedReasons.push(pixelRestriction);
    return null;
  }

  const modality = getStr(first, 'Modality', 'OT');
  const bitsAllocated = getInt(first, 'BitsAllocated', 16);
  const bitsStored = getInt(first, 'BitsStored', bitsAllocated);
  const pixelRepresentation = getInt(first, 'PixelRepresentation', 0); // 0=unsigned, 1=signed
  const photometric = getStr(first, 'PhotometricInterpretation', 'MONOCHROME2');
  const isInverted = photometric === 'MONOCHROME1';

  // Bit mask for BitsStored (discard padding bits)
  const bitMask = (1 << bitsStored) - 1;

  // Transfer syntax for codec detection
  const transferSyntax = getStr(first, 'TransferSyntaxUID')
    || first['00020010']?.Value?.[0] || '';
  const compressed = datasets.some(d => isCompressed(getStr(d.meta, 'TransferSyntaxUID') || transferSyntax));
  if (compressed) {
    onProgress('info', `compressed DICOM — loading codecs...`);
  }

  const sliceCanvases = [];
  const acceptedMetas = [];
  const voxelsPerSlice = rows * cols;
  const rawVolume = new Float32Array(voxelsPerSlice * datasets.length);
  let rawSliceIdx = 0;

  for (const item of datasets) {
    const meta = item.meta;
    try {
      if (getInt(meta, 'Rows') !== rows || getInt(meta, 'Columns') !== cols) continue;
      const sliceRestriction = pixelDataRestrictionReason(meta);
      if (sliceRestriction) {
        skippedReasons.push(sliceRestriction);
        return null;
      }

      let pixels;
      const sliceTransferSyntax = getStr(meta, 'TransferSyntaxUID') || transferSyntax;
      if (item.encodedValue) {
        const encodedBytes = bytesFromValue(item.encodedValue);
        if (!encodedBytes) continue;
        const encodedBuffer = arrayBufferForBytes(encodedBytes);
        pixels = await decodePixelData(encodedBuffer, sliceTransferSyntax, rows, cols, bitsAllocated);
        if (!pixels) {
          skippedReasons.push(`unsupported ${sliceTransferSyntax} compressed DICOM requires a lossless medical decoder`);
          return null;
        }
      } else if (item.pixels) {
        pixels = item.pixels;
      } else {
        const pixelData = item.pixelData;
        const buffer = pixelData?.Value?.[0] ?? pixelData?.InlineBinary;
        if (!buffer) continue;
        const bytes = bytesFromValue(buffer);
        if (!bytes) continue;
        const ab = arrayBufferForBytes(bytes);
        if (isCompressed(sliceTransferSyntax)) {
          pixels = await decodePixelData(ab, sliceTransferSyntax, rows, cols, bitsAllocated);
        } else if (bitsAllocated === 8) {
          pixels = new Uint8Array(ab);
        } else if (pixelRepresentation === 1) {
          pixels = new Int16Array(ab);
        } else {
          pixels = new Uint16Array(ab);
        }
      }

      // Per-slice rescale (can vary per frame in enhanced DICOM)
      const slope = getFloat(meta, 'RescaleSlope', 1);
      const intercept = getFloat(meta, 'RescaleIntercept', 0);

      let wl = getFloat(meta, 'WindowCenter');
      let ww = getFloat(meta, 'WindowWidth');
      const count = Math.min(pixels.length, voxelsPerSlice);
      if (!ww) {
        const auto = autoWindowLevel(pixels, count, slope, intercept);
        wl = auto.wl;
        ww = auto.ww;
      }
      const lo = wl - ww / 2;
      const range = Math.max(1, ww);

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(cols, rows);
      const d = imgData.data;
      const rawBase = rawSliceIdx * voxelsPerSlice;

      for (let i = 0; i < count; i++) {
        // Shape: signed `-1024`, packed signed `0x0c18`, or unsigned `4095`.
        let raw = pixels[i];
        if (pixelRepresentation === 1) {
          if (bitsStored < bitsAllocated) {
            raw &= bitMask;
            // Shape: sign bit for a 12-bit signed sample stored in 16 bits.
            const signBit = 1 << (bitsStored - 1);
            if (raw & signBit) raw |= ~bitMask;
          }
        } else {
          raw &= bitMask;
        }
        raw = raw * slope + intercept;
        rawVolume[rawBase + i] = raw;

        let v = Math.round(((raw - lo) / range) * 255);
        if (v < 0) v = 0; if (v > 255) v = 255;
        // MONOCHROME1: invert so bright = dense (standard display)
        if (isInverted) v = 255 - v;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      sliceCanvases.push(canvas);
      acceptedMetas.push(meta);
      rawSliceIdx++;
    } catch {
      // Skip bad slices
    }
  }

  if (!sliceCanvases.length) return null;

  // Normalize to [0,1]. CT: fixed HU band (see convert_ct.py); else data min/max.
  const actualVoxels = rawSliceIdx * voxelsPerSlice;
  const hrVoxels = rawSliceIdx < datasets.length
    ? rawVolume.slice(0, actualVoxels) : rawVolume;
  const isCT = normalizeModality(modality) === 'CT';
  let normLo, normHi;
  if (isCT) {
    normLo = CT_HU_LO; normHi = CT_HU_HI;
  } else {
    normLo = Infinity; normHi = -Infinity;
    for (let i = 0; i < actualVoxels; i++) {
      const v = hrVoxels[i];
      if (v < normLo) normLo = v;
      if (v > normHi) normHi = v;
    }
  }
  const normRange = normHi - normLo || 1;
  const normInv = 1 / normRange;
  for (let i = 0; i < actualVoxels; i++) {
    let v = (hrVoxels[i] - normLo) * normInv;
    if (v < 0) v = 0; if (v > 1) v = 1;
    hrVoxels[i] = v;
  }

  const geometry = geometryFromDicomMetas(acceptedMetas);
  const pixelSpacing = geometry.pixelSpacing || [0, 0];
  const thickness = Number(geometry.sliceThickness || 0);
  const sliceSpacing = Number(geometry.sliceSpacing || thickness || 0);
  const orientation = geometry.orientation || [...DEFAULT_IOP];
  const firstIPP = geometry.firstIPP || [0, 0, 0];
  const lastIPP = geometry.lastIPP || firstIPP;
  const reliableVolumeStack = importClassification.kind === 'volume-stack' && geometry.sliceSpacingRegular !== false;

  const seriesDesc = getStr(first, 'SeriesDescription') || getStr(first, 'StudyDescription');
  const bodyPart = getStr(first, 'BodyPartExamined');
  const patientName = getStr(first, 'PatientName');
  const studyDate = getStr(first, 'StudyDate');
  const geometryKind = reliableVolumeStack ? 'volumeStack' : geometryKindForImportKind(importClassification.kind);
  const reconstructionCapability = reliableVolumeStack
    ? 'display-volume'
    : reconstructionCapabilityForGeometryKind(geometryKind);

  // Build a readable name from available metadata
  let name = seriesDesc;
  if (!name) {
    const parts = [modality];
    if (bodyPart) parts.push(bodyPart);
    parts.push(`${sliceCanvases.length} slices`);
    name = parts.join(' · ');
  }

  let description = `${cols}×${rows} · ${sliceCanvases.length} slices`;
  if (pixelSpacing[0] > 0) description += ` · ${pixelSpacing[0].toFixed(2)} mm`;
  if (sliceSpacing > 0) description += ` / ${sliceSpacing.toFixed(1)} mm`;
  description += ' · local import';

  const entry = {
    slug,
    name,
    description,
    modality,
    slices: sliceCanvases.length,
    width: cols,
    height: rows,
    pixelSpacing,
    sliceThickness: thickness || sliceSpacing || 0,
    sliceSpacing,
    sliceSpacingRegular: geometry.sliceSpacingRegular !== false,
    slicePositionsDistinct: geometry.slicePositionsDistinct !== false,
    sliceSpacingStats: geometry.sliceSpacingStats,
    tr: getFloat(first, 'RepetitionTime'),
    te: getFloat(first, 'EchoTime'),
    sequence: seriesDesc,
    firstIPP,
    lastIPP,
    orientation,
    frameOfReferenceUIDConsistent: geometry.frameOfReferenceUIDConsistent !== false,
    group: null,
    hasBrain: false,
    hasSeg: false,
    hasSym: false,
    hasRegions: false,
    hasStats: false,
    hasAnalysis: false,
    hasMaskRaw: false,
    hasRaw: true,
    geometryKind,
    reconstructionCapability,
    renderability: reconstructionCapability === 'display-volume' ? 'volume' : '2d',
    dicomImportKind: importClassification.kind,
    isProjection: importClassification.isProjection,
    isProjectionSet: importClassification.isProjectionSet,
    isReconstructedVolumeStack: importClassification.isReconstructedVolumeStack,
    // Extra metadata for display (not used by viewer logic)
    _bodyPart: bodyPart,
    _patientName: patientName,
    _studyDate: studyDate,
    _photometric: photometric,
    _spacingKnown: pixelSpacing[0] > 0,
    _dicomImportClassification: importClassification,
  };
  for (const [key, value] of [
    ['sourceStudyUID', getStr(first, 'StudyInstanceUID')],
    ['sourceSeriesUID', getStr(first, 'SeriesInstanceUID')],
    ['frameOfReferenceUID', geometry.frameOfReferenceUID],
    ['bodyPart', bodyPart],
  ]) {
    if (value) entry[key] = value;
  }
  if (sourceManifest?.sourceKind === 'projection') {
    entry.projectionCalibration = {
      status: 'calibrated',
      source: 'external-json',
      geometry: String(sourceManifest?.projection?.geometry || ''),
      angleCount: Array.isArray(sourceManifest?.projection?.anglesDeg) ? sourceManifest.projection.anglesDeg.length : 0,
    };
  }
  if (importClassification.kind === 'ultrasound-source') {
    entry.geometryKind = 'ultrasoundSource';
    entry.reconstructionCapability = 'requires-reconstruction';
    entry.renderability = '2d';
    entry.ultrasoundCalibration = importClassification.ultrasound?.calibrationSummary || null;
  }

  return { entry, sliceCanvases, rawVolume: hrVoxels };
}
