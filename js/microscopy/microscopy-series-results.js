import { DEFAULT_IOP } from '../core/geometry.js';
import { lengthUnitToMm, normalizeLengthUnit } from '../core/physical-units.js';
import {
  buildMicroscopyDataset,
  channelMetadata,
  datasetSpacingMm,
} from './microscopy-dataset-model.js';
import { rawDisplayRangeToByteRange } from './microscopy-display-range.js';
import {
  microscopyRawVolumeForPlanes,
  microscopyVolumeFailureReason,
  microscopyZCoverage,
} from './microscopy-volume.js';

function omeAxisSize(meta, axis) {
  const raw = meta[`size${axis.toUpperCase()}`];
  return Number(raw == null ? 1 : raw);
}

export function omePositionKey(position) {
  return `${position.c}|${position.z}|${position.t}`;
}

export function assertOmePosition(position, meta) {
  for (const axis of ['z', 'c', 't']) {
    const coordinate = Number(position?.[axis]);
    const size = omeAxisSize(meta, axis);
    if (!Number.isSafeInteger(coordinate) || coordinate < 0) {
      throw new Error(`OME-TIFF ${axis.toUpperCase()} coordinate must be a finite non-negative integer.`);
    }
    if (!Number.isSafeInteger(size) || size <= 0 || coordinate >= size) {
      throw new Error(`OME-TIFF TiffData ${axis.toUpperCase()} coordinate ${coordinate} is outside declared Size${axis.toUpperCase()}=${size}.`);
    }
  }
}

export function nextZct(position, meta) {
  const axes = String(meta.dimensionOrder || 'XYZCT').replace(/[XY]/g, '').toUpperCase().split('');
  const next = { ...position };
  for (const axis of axes) {
    const key = axis.toLowerCase();
    const size = Number(meta[`size${axis}`] || 1);
    next[key]++;
    if (next[key] < size) break;
    next[key] = 0;
  }
  return next;
}

function planeAssignmentsFor(pages, meta) {
  const assignments = [];
  const positions = new Set();
  const explicitMappings = meta.tiffData instanceof Map ? meta.tiffData : null;
  if (explicitMappings) {
    for (const pageIndex of explicitMappings.keys()) {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) {
        throw new Error(`OME-TIFF TiffData IFD ${pageIndex} is outside the ${pages.length} decoded IFDs.`);
      }
    }
  }
  let walked = { z: 0, c: 0, t: 0 };
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    if (explicitMappings && !explicitMappings.has(pageIndex)) continue;
    const position = explicitMappings ? explicitMappings.get(pageIndex) : walked;
    assertOmePosition(position, meta);
    const key = omePositionKey(position);
    if (positions.has(key)) {
      if (!explicitMappings) break;
      throw new Error(`OME-TIFF metadata maps C/Z/T position ${key} more than once.`);
    }
    positions.add(key);
    assignments.push({ page: pages[pageIndex], pageIndex, position });
    if (!explicitMappings) walked = nextZct(walked, meta);
  }
  return assignments;
}

function normalizeVolumePixels(planes) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const plane of planes) {
    for (const value of plane.pixels) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 0, range: 1 };
  return { lo, hi, range: hi - lo || 1 };
}

function canvasForPlane(plane, { lo, hi, range }, displayRange = null) {
  const canvas = document.createElement('canvas');
  canvas.width = plane.width;
  canvas.height = plane.height;
  canvas._microscopyRawRange = [lo, hi];
  canvas._microscopyInvertDisplayRange = plane.photometric === 0;
  const displayByteRange = rawDisplayRangeToByteRange(displayRange, [lo, hi], {
    invert: canvas._microscopyInvertDisplayRange,
  });
  if (displayByteRange) canvas._microscopyDisplayByteRange = displayByteRange;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(plane.width, plane.height);
  const invert = plane.photometric === 0;
  for (let i = 0; i < plane.pixels.length; i++) {
    let value = Math.round(((plane.pixels[i] - lo) / range) * 255);
    if (value < 0) value = 0;
    if (value > 255) value = 255;
    if (invert) value = 255 - value;
    image.data[i * 4] = value;
    image.data[i * 4 + 1] = value;
    image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function baseName(fileName) {
  return String(fileName || 'microscopy').replace(/\.(ome\.)?tiff?$/i, '') || 'microscopy';
}

function cleanSlugPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'microscopy';
}

// Keep only a bounded raw-plane store for analysis and C/T volume rebuilding;
// oversized stacks still import for display but fail closed for raw operations.
const MAX_RAW_RETENTION_BYTES = 1.5e9;

export function buildMicroscopySeriesResults(pages, metadata, fileName, slugBase = `micro_${Date.now().toString(36)}`) {
  if (!pages.length) throw new Error('No TIFF image planes found');
  const assignments = planeAssignmentsFor(pages, metadata);
  if (!assignments.length) throw new Error('OME-TIFF metadata does not assign any decoded IFDs to image planes.');
  const hasInterleavedChannels = assignments.some(assignment => Array.isArray(assignment.page?.channelPixels));
  if (hasInterleavedChannels && metadata.source !== 'TIFF') {
    throw new Error('Interleaved RGB/RGBA TIFF planes with OME/ImageJ C/Z/T metadata are not supported; export scalar channels first.');
  }
  if (hasInterleavedChannels && assignments.some((assignment) => (
    !Array.isArray(assignment.page?.channelPixels)
    || assignment.page.channelPixels.length !== Number(metadata.sizeC)
  ))) {
    throw new Error('Interleaved RGB/RGBA TIFF stacks must use one consistent channel layout across every plane.');
  }
  const expandedAssignments = assignments.flatMap((assignment) => {
    const channels = assignment.page?.channelPixels;
    if (!channels) return [assignment];
    if (Number(metadata.sizeC) !== channels.length || Number(assignment.position?.c || 0) !== 0) {
      throw new Error('Interleaved RGB/RGBA TIFF metadata must describe one packed RGB(A) plane per Z position.');
    }
    return channels.map((pixels, channelIndex) => ({
      ...assignment,
      page: {
        ...assignment.page,
        pixels,
        channelPixels: null,
        samplesPerPixel: 1,
      },
      position: { ...assignment.position, c: channelIndex },
    }));
  });
  const assignedPages = expandedAssignments.map(assignment => assignment.page);
  const planePositions = expandedAssignments.map(assignment => assignment.position);
  const dataset = buildMicroscopyDataset({ pages: assignedPages, metadata, fileName, slugBase, planePositions });
  dataset.planes.forEach((plane, index) => {
    plane.pageIndex = expandedAssignments[index].pageIndex;
  });
  const byKey = new Map();
  assignedPages.forEach((page, index) => {
    const pos = planePositions[index];
    const key = `${pos.c || 0}|${pos.t || 0}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...page, z: pos.z || 0, c: pos.c || 0, t: pos.t || 0 });
  });

  const { rowMm, colMm, zMm, zKnown, unit: datasetUnit } = datasetSpacingMm(dataset);
  const unit = normalizeLengthUnit(metadata.physicalUnit || datasetUnit || 'µm');
  const unitToMm = lengthUnitToMm(unit);
  const name = baseName(fileName);
  const localStacks = {};
  const rawPlanes = {};
  let rawBytes = 0;
  const sortedKeys = [...byKey.keys()].sort((a, b) => {
    const [ac, at] = a.split('|').map(Number);
    const [bc, bt] = b.split('|').map(Number);
    return (at - bt) || (ac - bc);
  });
  for (const key of sortedKeys) {
    const planes = byKey.get(key);
    planes.sort((a, b) => a.z - b.z);
    const valueRange = normalizeVolumePixels(planes);
    const [channelText] = key.split('|');
    const channel = channelMetadata(dataset, Number(channelText) || 0);
    const displayRange = channel?.displayRangeSource === 'metadata' ? channel.displayRange : null;
    localStacks[key] = planes.map(plane => canvasForPlane(plane, valueRange, displayRange));
    rawPlanes[key] = planes.map((plane) => {
      rawBytes += plane.pixels.byteLength;
      return {
        pixels: plane.pixels,
        width: plane.width,
        height: plane.height,
        photometric: plane.photometric,
        z: plane.z,
      };
    });
  }
  const retainedRawPlanes = rawBytes <= MAX_RAW_RETENTION_BYTES ? rawPlanes : null;
  const defaultKey = localStacks['0|0'] ? '0|0' : sortedKeys[0];
  const defaultPlanes = byKey.get(defaultKey) || [];
  const declaredSizeZ = Number(dataset.axes.find(axis => axis?.name === 'z')?.size || metadata.sizeZ || 1);
  const coverageByKey = Object.fromEntries(sortedKeys.map(key => [
    key,
    microscopyZCoverage(byKey.get(key), declaredSizeZ),
  ]));
  const defaultCoverage = coverageByKey[defaultKey];
  const allStacksComplete = sortedKeys.length > 0
    && sortedKeys.every(key => coverageByKey[key].complete);
  const [defaultCText, defaultTText] = defaultKey.split('|');
  const defaultC = Number(defaultCText) || 0;
  const defaultT = Number(defaultTText) || 0;
  const width = defaultPlanes[0]?.width || dataset.levels[0].width;
  const height = defaultPlanes[0]?.height || dataset.levels[0].height;
  const channelName = channelMetadata(dataset, defaultC).name;
  const spacingText = rowMm > 0 && colMm > 0 ? ` · ${(colMm / unitToMm).toFixed(3)} ${unit}/px` : '';
  const axesText = `Z ${metadata.sizeZ || defaultPlanes.length} · C ${metadata.sizeC || 1} · T ${metadata.sizeT || 1}`;
  const slug = cleanSlugPart(slugBase);
  const calibratedMicroscopyVolume = rowMm > 0
    && colMm > 0
    && zKnown
    && declaredSizeZ >= 2
    && allStacksComplete;
  let rawVolume;
  let microscopyVolumeEligible = false;
  let volumeBlockReason = '';
  if (calibratedMicroscopyVolume) {
    try {
      rawVolume = microscopyRawVolumeForPlanes(defaultPlanes, width, height, declaredSizeZ);
      microscopyVolumeEligible = true;
    } catch (error) {
      volumeBlockReason = microscopyVolumeFailureReason(error);
    }
  } else if (!(rowMm > 0 && colMm > 0)) volumeBlockReason = 'missing_xy_calibration';
  else if (!zKnown) volumeBlockReason = 'missing_z_calibration';
  else if (declaredSizeZ < 2) volumeBlockReason = 'insufficient_z_planes';
  else volumeBlockReason = 'incomplete_z_coverage';
  const firstZ = defaultCoverage?.firstZ || 0;
  const lastZ = defaultCoverage?.lastZ || firstZ;
  const entry = {
    slug,
    name,
    description: `${width}×${height}×${defaultPlanes.length} · ${axesText} · ${metadata.source}${spacingText}`,
    modality: 'MIC',
    imageDomain: 'microscopy',
    slices: defaultPlanes.length,
    width,
    height,
    pixelSpacing: rowMm > 0 && colMm > 0 ? [rowMm, colMm] : [0, 0],
    sliceThickness: zKnown ? zMm : 0,
    sliceSpacing: zKnown ? zMm : 0,
    sliceSpacingRegular: defaultCoverage?.complete === true,
    tr: 0,
    te: 0,
    sequence: metadata.source,
    firstIPP: [0, 0, zKnown ? firstZ * zMm : 0],
    lastIPP: [0, 0, zKnown ? lastZ * zMm : 0],
    orientation: [...DEFAULT_IOP],
    group: null,
    hasBrain: false,
    hasSeg: false,
    hasSym: false,
    hasRegions: false,
    hasStats: false,
    hasAnalysis: false,
    hasMaskRaw: false,
    hasRaw: false,
    geometryKind: microscopyVolumeEligible ? 'volumeStack' : 'microscopyStack',
    reconstructionCapability: microscopyVolumeEligible ? 'display-volume' : '2d-only',
    renderability: microscopyVolumeEligible ? 'volume' : '2d',
    physicalUnit: unit,
    microscopy: {
      format: metadata.source,
      dimensionOrder: metadata.dimensionOrder,
      axes: ['x', 'y', 'z', 'c', 't'],
      sizeZ: metadata.sizeZ,
      sizeC: metadata.sizeC,
      sizeT: metadata.sizeT,
      channelIndex: defaultC,
      channelName,
      timeIndex: defaultT,
      physicalUnit: unit,
      physicalSizeX: metadata.physicalSizeX || 0,
      physicalSizeY: metadata.physicalSizeY || 0,
      physicalSizeZ: metadata.physicalSizeZ || 0,
      datasetId: dataset.id,
      availablePositions: sortedKeys,
      sourceFiles: metadata.sourceFiles || [fileName],
      sequenceProvenance: metadata.sequenceProvenance || null,
      sequenceWarnings: metadata.warnings || [],
      volumeEligible: microscopyVolumeEligible,
      volumeBlockReason,
      zPositionsByStack: Object.fromEntries(sortedKeys.map(key => [key, coverageByKey[key].positions])),
    },
    microscopyDataset: dataset,
    _spacingKnown: rowMm > 0 && colMm > 0,
    _sliceSpacingKnown: zKnown,
  };
  if (!microscopyVolumeEligible && volumeBlockReason === 'volume_resource_limit') {
    entry.microscopyDataset.source.warnings = [...new Set([
      ...(entry.microscopyDataset.source.warnings || []),
      'microscopy_volume_resource_limit',
    ])];
  }
  return [{
    entry,
    sliceCanvases: localStacks[defaultKey],
    localStacks,
    rawPlanes: retainedRawPlanes,
    rawVolume,
  }];
}
