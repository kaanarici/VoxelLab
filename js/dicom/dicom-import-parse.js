import { CT_HU_LO, CT_HU_HI } from '../core/constants.js';
import { DCMJS_IMPORT_URL } from '../core/dependencies.js';
import {
  DEFAULT_IOP,
  geometryFromDicomMetas,
  isOrthonormalImagePlane,
  sortDatasetsSpatially,
} from '../core/geometry.js';
import { parseDicomFilesInWorker, scanDicomFilesInWorker } from '../volume/volume-worker-client.js';
import { isBigEndianTransferSyntax, isCompressed, decodePixelData } from './dicom-codecs.js';
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
import { getFloat, getInt, getStr, normalizeModality } from './dicom-meta.js';
import {
  arrayBufferForBytes,
  bytesFromValue,
  pixelDataRestrictionReason,
  typedPixelsFromBytes,
} from './dicom-pixel-data.js';
import {
  addDICOMActualInputBytes,
  assertDICOMActualFileBytes,
  assertDICOMDatasetMetadata,
  assertDICOMInputFiles,
  assertDICOMSeriesWorkingSet,
  dicomDimensions,
} from './dicom-import-resources.js';

export { extractEnhancedMultiFrameMetas } from './dicom-frame-meta.js';
export { classifyDICOMImport } from './dicom-import-classify.js';
export { dicomSeriesGroupKey } from './dicom-import-routing.js';
export { parseNIfTI, parseNIfTISeries } from './nifti-import-parse.js';
export { DICOM_IMPORT_LIMITS } from './dicom-import-resources.js';

function stripBasicOffsetTable(values, frameCount) {
  if (values.length !== frameCount + 1) return values;
  const first = bytesFromValue(values[0]);
  if (!first || first.byteLength % 4 !== 0) return values;
  return values.slice(1);
}

export function extractEnhancedMultiFramePixels(item) {
  const meta = item?.meta || item;
  const pixelData = item?.pixelData || meta?.PixelData;
  const { frames: frameCount, rows, columns: cols, voxelsPerSlice: framePixelCount } = dicomDimensions(meta);
  const bitsAllocated = getInt(meta, 'BitsAllocated', 16);
  const pixelRepresentation = getInt(meta, 'PixelRepresentation', 0);
  const frameMetas = frameMetasForInstance(meta);

  if (!pixelData || !frameMetas || frameMetas.length !== frameCount || !rows || !cols) return null;

  const values = Array.isArray(pixelData?.Value) ? pixelData.Value : [];
  const inlineBinary = pixelData?.InlineBinary;
  const frameByteCount = framePixelCount * (bitsAllocated <= 8 ? 1 : 2);
  const transferSyntax = getStr(meta, 'TransferSyntaxUID');

  const frames = [];
  if (!isCompressed(transferSyntax)) {
    const bytes = bytesFromValue(values[0] ?? inlineBinary);
    if (!bytes || bytes.byteLength < frameCount * frameByteCount) return null;
    const littleEndian = !isBigEndianTransferSyntax(transferSyntax);
    for (let i = 0; i < frameCount; i++) {
      const frameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + (i * frameByteCount), frameByteCount);
      const pixels = typedPixelsFromBytes(frameBytes, bitsAllocated, pixelRepresentation, framePixelCount, { littleEndian });
      if (!pixels) return null;
      frames.push({
        meta: frameMetas[i],
        pixels,
        file: item.file,
        sourceByteLength: item.sourceByteLength,
        sourceId: item.sourceId,
      });
    }
    return frames;
  }

  const encodedValues = stripBasicOffsetTable(values, frameCount);
  if (encodedValues.length !== frameCount) return null;
  return encodedValues.map((value, index) => ({
    meta: frameMetas[index],
    encodedValue: value,
    file: item.file,
    sourceByteLength: item.sourceByteLength,
    sourceId: item.sourceId,
  }));
}

function sortSlicesSpatially(datasets) {
  const sorted = sortDatasetsSpatially(datasets, (item) => item.meta);
  datasets.splice(0, datasets.length, ...sorted);
}

function autoWindowLevel(samples) {
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.02)];
  const hi = samples[Math.floor(samples.length * 0.98)];
  const ww = Math.max(1, hi - lo);
  const wl = (lo + hi) / 2;
  return { wl, ww };
}

function storedPixelValue(pixel, bitsStored, pixelRepresentation, bitMask) {
  let stored = Number(pixel) & bitMask;
  if (pixelRepresentation === 1) {
    const signBit = 1 << (bitsStored - 1);
    if (stored & signBit) stored -= bitMask + 1;
  }
  return stored;
}

function integerTagValue(meta, key) {
  const value = meta?.[key];
  if (value == null) return { present: false, value: null };
  const candidate = Array.isArray(value) ? value[0] : value;
  let parsed = candidate;
  if (!Number.isSafeInteger(parsed)) {
    if (!(candidate?.trim instanceof Function)) return { present: true, value: null };
    const lexeme = candidate.trim();
    if (!/^[+-]?\d+$/.test(lexeme)) return { present: true, value: null };
    parsed = Number(lexeme);
  }
  if (!Number.isSafeInteger(parsed)) return { present: true, value: null };
  return { present: true, value: parsed };
}

function pixelPaddingRange(meta, bitsStored, pixelRepresentation, photometric) {
  const value = integerTagValue(meta, 'PixelPaddingValue');
  const limit = integerTagValue(meta, 'PixelPaddingRangeLimit');
  if (!value.present && !limit.present) return { hasPadding: false };
  if (!value.present || value.value == null || limit.present && limit.value == null) {
    return { error: 'unsupported DICOM import has malformed Pixel Padding metadata' };
  }

  const minStored = pixelRepresentation === 1 ? -(2 ** (bitsStored - 1)) : 0;
  const maxStored = pixelRepresentation === 1 ? (2 ** (bitsStored - 1)) - 1 : (2 ** bitsStored) - 1;
  const rangeLimit = limit.present ? limit.value : value.value;
  if (value.value < minStored || value.value > maxStored
    || rangeLimit < minStored || rangeLimit > maxStored) {
    return { error: 'unsupported DICOM import has Pixel Padding metadata outside Bits Stored' };
  }

  const isMonochrome1 = photometric === 'MONOCHROME1';
  if ((isMonochrome1 && value.value < rangeLimit)
    || (!isMonochrome1 && value.value > rangeLimit)) {
    return { error: 'unsupported DICOM import has Pixel Padding range ordered contrary to Photometric Interpretation' };
  }
  return {
    hasPadding: true,
    low: Math.min(value.value, rangeLimit),
    high: Math.max(value.value, rangeLimit),
  };
}

function isPaddingValue(value, padding) {
  return padding.hasPadding && value >= padding.low && value <= padding.high;
}

function sourceFileName(file = {}) {
  const relative = String(file.webkitRelativePath || '').replaceAll('\\', '/');
  if (relative) return relative.split('/').filter(Boolean).join('/');
  const name = String(file.name || '').replaceAll('\\', '/').split('/').filter(Boolean).pop();
  if (name) return name;
  return String(file.path || '').replaceAll('\\', '/').split('/').filter(Boolean).pop() || '';
}

function canUseDicomWorker(files) {
  return globalThis.Worker instanceof Function
    && globalThis.File instanceof Function
    && files.every(file => file instanceof globalThis.File);
}

function attachSourceFiles(datasets, files) {
  return (datasets || []).map(item => ({
    ...item,
    file: files[item.sourceId] || null,
  }));
}

async function scanDicomFilesLocally(files, onProgress) {
  const lib = await import(DCMJS_IMPORT_URL);
  const DicomMessage = lib.data.DicomMessage;
  let actualInputBytes = 0;
  const sourceManifests = await parseSourceManifests(files, {
    onActualFileBytes(byteLength, file, index) {
      actualInputBytes = addDICOMActualInputBytes(actualInputBytes, byteLength, file, index);
    },
  });
  const datasets = [];
  for (const [index, file] of files.entries()) {
    if (/\.json$/i.test(file?.name || '')) continue;
    try {
      const ab = await file.arrayBuffer();
      actualInputBytes = addDICOMActualInputBytes(actualInputBytes, ab.byteLength, file, index);
      const ds = DicomMessage.readFile(ab, {
        ignoreErrors: false,
        untilTag: '7FE00010',
        includeUntilTagValue: false,
        noCopy: true,
      });
      const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
      if (!Object.hasOwn(meta, 'PixelData')) continue;
      datasets.push({ meta, file, sourceByteLength: ab.byteLength, sourceId: index });
      if (datasets.length % 10 === 0) onProgress('discovering', `${datasets.length} / ${files.length}`);
    } catch (error) {
      if (error?.dicomResourceLimit) throw error;
    }
  }
  return { datasets, sourceManifests, lib, worker: false };
}

async function discoverDicomFiles(files, onProgress) {
  if (canUseDicomWorker(files)) {
    const scanned = await scanDicomFilesInWorker(files, onProgress);
    if (scanned) {
      return {
        datasets: attachSourceFiles(scanned.datasets, files),
        sourceManifests: new Map(Object.entries(scanned.sourceManifests || {}).map(([uid, record]) => [uid, {
          payload: record?.payload || record,
          file: files[record?.sourceId] || null,
        }])),
        worker: true,
      };
    }
  }
  return scanDicomFilesLocally(files, onProgress);
}

async function parseDicomGroupLocally(files, lib, onProgress) {
  const DicomMessage = lib.data.DicomMessage;
  const datasets = [];
  for (const [index, file] of files.entries()) {
    try {
      const ab = await file.arrayBuffer();
      assertDICOMActualFileBytes(ab.byteLength, file, index);
      const ds = DicomMessage.readFile(ab);
      const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
      if (!meta.PixelData) continue;
      datasets.push({
        meta,
        pixelData: ds.dict['7FE00010'],
        file,
        sourceByteLength: ab.byteLength,
        sourceId: index,
      });
      if (datasets.length % 10 === 0) onProgress('parsing', `${datasets.length} / ${files.length}`);
    } catch (error) {
      if (error?.dicomResourceLimit) throw error;
    }
  }
  return datasets;
}

export async function* iterateDICOMFileGroups(files, onProgress = () => {}) {
  const selectedFiles = Array.from(files || []);
  assertDICOMInputFiles(selectedFiles);
  onProgress('discovering', `reading metadata from ${selectedFiles.length} files...`);
  const discovery = await discoverDicomFiles(selectedFiles, onProgress);
  if (!discovery.datasets.length) return;
  const groups = groupDatasetsBySeries(discovery.datasets);
  const renderableGroups = groups.filter((group) => !isDerivedObjectModality(group.datasets[0]?.meta?.Modality));
  for (const group of renderableGroups) {
    const seriesUID = String(group.datasets[0]?.meta?.SeriesInstanceUID || '');
    const sourceManifest = discovery.sourceManifests.get(seriesUID);
    group.sourceManifest = sourceManifest?.payload || null;
    group.sourceManifestFile = sourceManifest?.file || null;
  }
  onProgress('sorting', `${discovery.datasets.length} valid images · ${renderableGroups.length} image series`);

  const seed = Date.now().toString(36);
  const skippedReasons = [];
  let resultCount = 0;
  for (let i = 0; i < renderableGroups.length; i++) {
    const descriptors = renderableGroups[i].datasets;
    const groupFiles = descriptors.map(item => item.file).filter(Boolean);
    const progress = (stage, detail) => onProgress(stage, `series ${i + 1} / ${renderableGroups.length} · ${detail}`);
    progress('parsing', `reading ${groupFiles.length} files...`);
    let datasets;
    if (discovery.worker) {
      const parsed = await parseDicomFilesInWorker(groupFiles, progress);
      datasets = parsed
        ? attachSourceFiles(parsed.datasets, groupFiles)
        : await parseDicomGroupLocally(groupFiles, await import(DCMJS_IMPORT_URL), progress);
    } else {
      datasets = await parseDicomGroupLocally(groupFiles, discovery.lib, progress);
    }
    renderableGroups[i].datasets = [];
    if (!datasets.length) continue;
    const slug = renderableGroups.length === 1 ? `local_${seed}` : `local_${seed}_${i + 1}`;
    const result = await buildDICOMSeriesResult(
      datasets,
      progress,
      slug,
      skippedReasons,
      renderableGroups[i].sourceManifest,
    );
    datasets.length = 0;
    if (result) {
      const manifestPath = String(renderableGroups[i].sourceManifestFile?.path || '');
      if (manifestPath && !result.desktopSourcePaths.includes(manifestPath)) {
        result.desktopSourcePaths.push(manifestPath);
      }
      resultCount += 1;
      yield result;
    }
  }
  if (!resultCount && skippedReasons.length) {
    throw new Error(skippedReasons.join(' | '));
  }
}

export async function parseDICOMFileGroups(files, onProgress = () => {}) {
  const results = [];
  for await (const result of iterateDICOMFileGroups(files, onProgress)) results.push(result);
  return results.length ? results : null;
}

export async function parseDICOMFiles(files, onProgress = () => {}) {
  for await (const result of iterateDICOMFileGroups(files, onProgress)) return result;
  return null;
}

export async function buildDICOMSeriesResult(inputDatasets, onProgress = () => {}, slug, skippedReasons = [], sourceManifest = null, signal = null) {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('DICOM import was cancelled', 'AbortError');
  };
  throwIfAborted();
  let datasets = inputDatasets.slice();
  assertDICOMDatasetMetadata(datasets);
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

  assertDICOMSeriesWorkingSet(datasets);

  sortSlicesSpatially(datasets);
  const importClassification = classifyDICOMImport(datasets, sourceManifest);
  const postExpansionRestriction = importRestrictionReason(importClassification);
  if (postExpansionRestriction) {
    skippedReasons.push(postExpansionRestriction);
    return null;
  }

  const first = datasets[0].meta;
  const { rows, columns: cols, voxelsPerSlice } = dicomDimensions(first);
  const pixelRestriction = pixelDataRestrictionReason(first);
  if (pixelRestriction) {
    skippedReasons.push(pixelRestriction);
    return null;
  }

  const modality = getStr(first, 'Modality', 'OT');
  const bitsAllocated = getInt(first, 'BitsAllocated', 16);
  const bitsStored = getInt(first, 'BitsStored', bitsAllocated);
  const pixelRepresentation = getInt(first, 'PixelRepresentation', 0);
  const photometric = getStr(first, 'PhotometricInterpretation', 'MONOCHROME2').trim().toUpperCase();
  const isInverted = photometric === 'MONOCHROME1';

  const bitMask = (1 << bitsStored) - 1;

  const transferSyntax = getStr(first, 'TransferSyntaxUID')
    || first['00020010']?.Value?.[0] || '';
  const compressed = datasets.some(d => isCompressed(getStr(d.meta, 'TransferSyntaxUID') || transferSyntax));
  if (compressed) {
    onProgress('info', `compressed DICOM — loading codecs...`);
  }

  const displayVolume = new Uint8Array(dicomDimensions(datasets[0].meta).voxelsPerSlice * datasets.length);
  const acceptedMetas = [];
  const acceptedSourceFiles = [];
  const acceptedSourceFileSet = new Set();
  const acceptedDesktopPaths = [];
  const acceptedDesktopPathSet = new Set();
  const desktopImportIds = new Set();
  const rawVolume = new Float32Array(voxelsPerSlice * datasets.length);
  let rawSliceIdx = 0;

  for (const item of datasets) {
    throwIfAborted();
    const meta = item.meta;
    try {
      if (getInt(meta, 'Rows') !== rows || getInt(meta, 'Columns') !== cols) continue;
      const sliceRestriction = pixelDataRestrictionReason(meta);
      if (sliceRestriction) {
        skippedReasons.push(sliceRestriction);
        return null;
      }
      const sliceBitsAllocated = getInt(meta, 'BitsAllocated', 16);
      const sliceBitsStored = getInt(meta, 'BitsStored', sliceBitsAllocated);
      const slicePixelRepresentation = getInt(meta, 'PixelRepresentation', 0);
      const slicePhotometric = getStr(meta, 'PhotometricInterpretation', 'MONOCHROME2').trim().toUpperCase();
      if (sliceBitsAllocated !== bitsAllocated
        || sliceBitsStored !== bitsStored
        || slicePixelRepresentation !== pixelRepresentation
        || slicePhotometric !== photometric) {
        skippedReasons.push('unsupported DICOM import mixes pixel layouts within one series');
        return null;
      }

      let pixels;
      const sliceTransferSyntax = getStr(meta, 'TransferSyntaxUID') || transferSyntax;
      if (item.encodedValue) {
        const encodedBytes = bytesFromValue(item.encodedValue);
        if (!encodedBytes) continue;
        const encodedBuffer = arrayBufferForBytes(encodedBytes);
        pixels = await decodePixelData(encodedBuffer, sliceTransferSyntax, rows, cols, bitsAllocated);
        throwIfAborted();
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
        if (isCompressed(sliceTransferSyntax)) {
          const ab = arrayBufferForBytes(bytes);
          pixels = await decodePixelData(ab, sliceTransferSyntax, rows, cols, bitsAllocated);
          throwIfAborted();
        } else {
          pixels = typedPixelsFromBytes(bytes, bitsAllocated, pixelRepresentation, voxelsPerSlice, {
            littleEndian: !isBigEndianTransferSyntax(sliceTransferSyntax),
          });
        }
        if (!pixels) continue;
      }

      const slope = getFloat(meta, 'RescaleSlope', 1);
      const intercept = getFloat(meta, 'RescaleIntercept', 0);
      const count = Math.min(pixels.length, voxelsPerSlice);
      const padding = pixelPaddingRange(meta, bitsStored, pixelRepresentation, photometric);
      if (padding.error) {
        skippedReasons.push(padding.error);
        return null;
      }

      let validPixelCount = 0;
      for (let i = 0; i < count; i++) {
        const stored = storedPixelValue(pixels[i], bitsStored, pixelRepresentation, bitMask);
        if (!isPaddingValue(stored, padding)) validPixelCount++;
      }
      if (!validPixelCount) {
        skippedReasons.push('unsupported DICOM import contains only Pixel Padding values');
        return null;
      }

      const rawBase = rawSliceIdx * voxelsPerSlice;

      for (let i = 0; i < count; i++) {
        if ((i & 0xffff) === 0) throwIfAborted();

        const stored = storedPixelValue(pixels[i], bitsStored, pixelRepresentation, bitMask);
        if (isPaddingValue(stored, padding)) {
          rawVolume[rawBase + i] = Number.NaN;
          displayVolume[rawBase + i] = 0;
          continue;
        }
        const raw = stored * slope + intercept;
        rawVolume[rawBase + i] = raw;
      }
      acceptedMetas.push(meta);
      const sourceFile = sourceFileName(item.file);
      if (sourceFile && !acceptedSourceFileSet.has(sourceFile)) {
        acceptedSourceFileSet.add(sourceFile);
        acceptedSourceFiles.push(sourceFile);
      }
      const desktopPath = String(item.file?.path || '');
      if (desktopPath && !acceptedDesktopPathSet.has(desktopPath)) {
        acceptedDesktopPathSet.add(desktopPath);
        acceptedDesktopPaths.push(desktopPath);
      }
      const desktopImportId = String(item.file?._desktopImportId || '');
      if (desktopImportId) desktopImportIds.add(desktopImportId);
      rawSliceIdx++;
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;

    }
  }

  if (!rawSliceIdx) return null;

  const actualVoxels = rawSliceIdx * voxelsPerSlice;
  const hrVoxels = rawSliceIdx < datasets.length
    ? rawVolume.subarray(0, actualVoxels) : rawVolume;
  const isCT = normalizeModality(modality) === 'CT';
  let normLo, normHi;
  if (isCT) {
    normLo = CT_HU_LO; normHi = CT_HU_HI;
  } else {
    normLo = Infinity; normHi = -Infinity;
    for (let i = 0; i < actualVoxels; i++) {
      if ((i & 0xffff) === 0) throwIfAborted();
      const v = hrVoxels[i];
      if (!Number.isFinite(v)) continue;
      if (v < normLo) normLo = v;
      if (v > normHi) normHi = v;
    }
  }
  const normRange = normHi - normLo || 1;
  const normInv = 1 / normRange;
  let defaultLevelRaw = getFloat(first, 'WindowCenter');
  let defaultWindowRaw = getFloat(first, 'WindowWidth');
  if (!(defaultWindowRaw > 0) || !Number.isFinite(defaultLevelRaw)) {
    const step = Math.max(1, Math.ceil(actualVoxels / 50000));
    const samples = [];
    for (let i = 0; i < actualVoxels; i += step) {
      if (Number.isFinite(hrVoxels[i])) samples.push(hrVoxels[i]);
    }
    if (samples.length) {
      const automatic = autoWindowLevel(samples);
      defaultLevelRaw = automatic.wl;
      defaultWindowRaw = automatic.ww;
    } else {
      defaultLevelRaw = normLo + normRange / 2;
      defaultWindowRaw = normRange;
    }
  }
  for (let i = 0; i < actualVoxels; i++) {
    if ((i & 0xffff) === 0) throwIfAborted();
    const raw = hrVoxels[i];
    if (!Number.isFinite(raw)) {
      hrVoxels[i] = 0;
      continue;
    }
    let v = (raw - normLo) * normInv;
    if (v < 0) v = 0; if (v > 1) v = 1;
    if (isInverted) v = 1 - v;
    hrVoxels[i] = v;
    displayVolume[i] = Math.round(v * 255);
  }
  const sliceBytes = Array.from(
    { length: rawSliceIdx },
    (_, index) => displayVolume.subarray(index * voxelsPerSlice, (index + 1) * voxelsPerSlice),
  );
  const defaultWindow = Math.max(1, Math.min(512, defaultWindowRaw * normInv * 255));
  const normalizedDefaultLevel = (defaultLevelRaw - normLo) * normInv * 255;
  const defaultLevel = Math.max(0, Math.min(255, isInverted ? 255 - normalizedDefaultLevel : normalizedDefaultLevel));

  const geometry = geometryFromDicomMetas(acceptedMetas);
  const pixelSpacing = geometry.pixelSpacing || [0, 0];
  const thickness = Number(geometry.sliceThickness || 0);
  const sliceSpacing = Number(geometry.sliceSpacing || thickness || 0);
  const orientation = geometry.orientation || [...DEFAULT_IOP];
  const firstIPP = geometry.firstIPP || [0, 0, 0];
  const lastIPP = geometry.lastIPP || firstIPP;
  const reliableVolumeStack = importClassification.kind === 'volume-stack' && geometry.sliceSpacingRegular !== false;
  const patientFrameTrusted = acceptedMetas.every(meta => isOrthonormalImagePlane(meta.ImageOrientationPatient));

  const seriesDesc = getStr(first, 'SeriesDescription') || getStr(first, 'StudyDescription');
  const bodyPart = getStr(first, 'BodyPartExamined');
  const studyDate = getStr(first, 'StudyDate');
  const geometryKind = reliableVolumeStack ? 'volumeStack' : geometryKindForImportKind(importClassification.kind);
  const reconstructionCapability = reliableVolumeStack
    ? 'display-volume'
    : reconstructionCapabilityForGeometryKind(geometryKind);

  let name = seriesDesc;
  if (!name) {
    const parts = [modality];
    if (bodyPart) parts.push(bodyPart);
    parts.push(`${rawSliceIdx} slices`);
    name = parts.join(' · ');
  }

  let description = `${cols}×${rows} · ${rawSliceIdx} slices`;
  if (pixelSpacing[0] > 0) description += ` · ${pixelSpacing[0].toFixed(2)} mm`;
  if (sliceSpacing > 0) description += ` / ${sliceSpacing.toFixed(1)} mm`;
  description += ' · local import';

  const entry = {
    slug,
    name,
    description,
    modality,
    slices: rawSliceIdx,
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
    patientFrameTrusted,
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

    _bodyPart: bodyPart,
    _studyDate: studyDate,
    _photometric: photometric,
    _defaultWindow: defaultWindow,
    _defaultLevel: defaultLevel,
    _displayDomain: { minimum: normLo, maximum: normHi, polarity: isInverted ? 'MONOCHROME1' : 'MONOCHROME2' },
    _spacingKnown: pixelSpacing[0] > 0,
    _dicomImportClassification: importClassification,
  };
  if (acceptedSourceFiles.length) entry.sourceFiles = acceptedSourceFiles;
  if (desktopImportIds.size === 1) entry._desktopImportId = [...desktopImportIds][0];
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

  return {
    entry,
    sliceBytes,
    rawVolume: hrVoxels,
    desktopSourcePaths: acceptedDesktopPaths,
  };
}
