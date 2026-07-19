import { state } from '../core/state.js';
import { setSeriesOverlayHints } from '../runtime/overlay-kinds.js';
import { frameMetasForInstance } from './dicom-frame-meta.js';
import { normalizeModality } from './dicom-meta.js';
import { isCompressed } from './dicom-codecs.js';
import {
  bytesFromValue,
  emptyLabelSlices,
  numberList,
  positiveSpacing2,
  sameNumber,
  sameOrientation,
  seqFirst,
  sliceIndexForIPP,
  sourceGridSpacing,
  voxelPointForLps,
} from './derived-common.js';

function shapeColor(index) {
  const hue = (index * 57) % 360;
  const sat = 0.72;
  const light = 0.58;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function segFrameOriginMatchesSourceGrid(frameMeta, sourceSeries, tolerancePx = 0.05) {
  const ipp = numberList(frameMeta?.ImagePositionPatient, 3);
  if (ipp.length < 3) return false;
  const voxelPoint = voxelPointForLps(sourceSeries, ipp);
  if (!voxelPoint) return false;
  const nearestZ = Math.round(voxelPoint[2]);
  return Math.abs(voxelPoint[0]) <= tolerancePx
    && Math.abs(voxelPoint[1]) <= tolerancePx
    && Math.abs(voxelPoint[2] - nearestZ) <= tolerancePx;
}

function segFrameMatchesSourceGrid(frameMeta, sourceSeries) {
  const frameRef = String(frameMeta?.FrameOfReferenceUID || '');
  const sourceRef = String(sourceSeries?.frameOfReferenceUID || '');
  if (frameRef && sourceRef && frameRef !== sourceRef) return false;
  if (!sameOrientation(numberList(frameMeta?.ImageOrientationPatient, 6), sourceSeries?.orientation)) return false;
  const frameSpacing = positiveSpacing2(frameMeta?.PixelSpacing);
  const sourceSpacing = positiveSpacing2(sourceSeries?.pixelSpacing);
  if (!frameSpacing || !sourceSpacing) return false;
  return sameNumber(frameSpacing[0], sourceSpacing[0])
    && sameNumber(frameSpacing[1], sourceSpacing[1])
    && segFrameOriginMatchesSourceGrid(frameMeta, sourceSeries);
}

function bitPackedFrame(bytes, pixelCount) {
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const byte = bytes[i >> 3] || 0;
    out[i] = (byte >> (i & 7)) & 1;
  }
  return out;
}

function segFramePixels(bytes, pixelCount, bitsAllocated) {
  if (bitsAllocated !== 1 || bytes.byteLength >= pixelCount) return bytes.slice(0, pixelCount);
  return bitPackedFrame(bytes, pixelCount);
}

function buildRegionMeta(sourceSeries, segmentDefs) {
  const spacing = sourceGridSpacing(sourceSeries);
  const voxelMl = spacing ? (spacing.row * spacing.col * spacing.slice) / 1000 : null;
  const regions = {};
  const colors = {};
  for (const segment of segmentDefs) {
    const region = {
      name: segment.name,
      source: segment.kind,
    };
    if (voxelMl != null) region.mL = +(segment.voxelCount * voxelMl).toFixed(3);
    regions[segment.label] = region;
    colors[segment.label] = segment.color;
  }
  return { regions, colors };
}

function labelSlicesToImages(labelSlices, width, height) {
  return labelSlices.map((labels) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < labels.length; i++) {
      const value = labels[i];
      const base = i * 4;
      image.data[base] = value;
      image.data[base + 1] = value;
      image.data[base + 2] = value;
      image.data[base + 3] = value ? 255 : 0;
    }
    ctx.putImageData(image, 0, 0);
    const img = new Image();
    img.src = canvas.toDataURL('image/png');
    return img;
  });
}

function mergeLabelSlices(existing, incoming, offset) {
  return existing.map((slice, index) => {
    const merged = slice.slice();
    const next = incoming[index];
    for (let i = 0; i < merged.length; i++) {
      if (next[i] > 0) merged[i] = next[i] + offset;
    }
    return merged;
  });
}

function nextLocalLabelOffset(meta = null) {
  const regionIds = Object.keys(meta?.regions || {}).map(Number).filter(Number.isFinite);
  return regionIds.length ? Math.max(...regionIds) : 0;
}

export function serializeSegPayload(labelSlices, regionMeta) {
  const sparseSlices = [];
  let pairCount = 0;
  for (const labels of labelSlices) {
    const sparse = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label > 0) {
        sparse.push(i, label);
        pairCount += 1;
      }
    }
    sparseSlices.push(sparse);
  }
  if (pairCount > 200000) return null;
  return {
    format: 'seg-overlay-v1',
    sparseSlices,
    regionMeta,
  };
}

export function deserializeSegPayload(payload, width, height, slices) {
  if (payload?.format !== 'seg-overlay-v1' || !Array.isArray(payload?.sparseSlices)) return null;
  const total = width * height;
  const labelSlices = emptyLabelSlices(width, height, slices);
  for (let z = 0; z < Math.min(slices, payload.sparseSlices.length); z++) {
    const sparse = payload.sparseSlices[z];
    if (!Array.isArray(sparse)) continue;
    const target = labelSlices[z];
    for (let i = 0; i + 1 < sparse.length; i += 2) {
      const index = Number(sparse[i]);
      const label = Number(sparse[i + 1]);
      if (Number.isInteger(index) && index >= 0 && index < total && Number.isFinite(label) && label > 0) {
        target[index] = label;
      }
    }
  }
  return {
    labelSlices,
    regionMeta: payload?.regionMeta || { regions: {}, colors: {} },
  };
}

export function preflightRegionOverlayAttachment(sourceSeries) {
  const existingMeta = state._localRegionMetaBySlug[sourceSeries.slug] || null;
  const existingSlices = state._localRegionLabelSlicesBySlug[sourceSeries.slug] || null;
  if (sourceSeries.hasRegions && !existingMeta && !existingSlices) {
    throw new Error(`${sourceSeries.name} already uses the region-overlay slot; refusing to overwrite it with imported SEG data`);
  }
}

export function attachRegionOverlay(sourceSeries, overlay) {
  preflightRegionOverlayAttachment(sourceSeries);
  const existingMeta = state._localRegionMetaBySlug[sourceSeries.slug] || null;
  const existingSlices = state._localRegionLabelSlicesBySlug[sourceSeries.slug] || null;

  const offset = nextLocalLabelOffset(existingMeta);
  const mergedSlices = existingSlices
    ? mergeLabelSlices(existingSlices, overlay.labelSlices, offset)
    : mergeLabelSlices(emptyLabelSlices(sourceSeries.width, sourceSeries.height, sourceSeries.slices), overlay.labelSlices, offset);
  const mergedMeta = existingMeta ? {
    regions: { ...(existingMeta.regions || {}) },
    colors: { ...(existingMeta.colors || {}) },
  } : { regions: {}, colors: {} };
  for (const [label, region] of Object.entries(overlay.regionMeta.regions)) {
    const shifted = Number(label) + offset;
    mergedMeta.regions[shifted] = region;
    mergedMeta.colors[shifted] = overlay.regionMeta.colors[label];
  }

  state._localRegionMetaBySlug[sourceSeries.slug] = mergedMeta;
  state._localRegionLabelSlicesBySlug[sourceSeries.slug] = mergedSlices;
  state._localStacks[`${sourceSeries.slug}_regions`] = labelSlicesToImages(mergedSlices, sourceSeries.width, sourceSeries.height);
  setSeriesOverlayHints(sourceSeries, {
    labels: {
      source: overlay.overlaySource || (overlay.kind === 'seg' ? 'dicom-seg' : 'local-regions'),
      legacyKinds: [overlay.legacySlot || 'regions', overlay.kind],
    },
  });
  sourceSeries.hasRegions = true;
  return { count: Object.keys(overlay.regionMeta.regions).length };
}

export function segSourceSeriesUID(meta) {
  const referenced = seqFirst(meta?.ReferencedSeriesSequence);
  return String(referenced?.SeriesInstanceUID || '');
}

function segmentDefinitions(meta) {
  const sequence = Array.isArray(meta?.SegmentSequence) ? meta.SegmentSequence : [];
  return sequence.map((segment, index) => ({
    number: Number(segment?.SegmentNumber || index + 1),
    label: index + 1,
    name: String(segment?.SegmentLabel || segment?.SegmentDescription || `Segment ${index + 1}`),
    color: shapeColor(index + 1),
    voxelCount: 0,
    kind: 'dicom-seg',
  }));
}

function segTransferSyntax(meta, values) {
  const declared = String(meta?.TransferSyntaxUID || '').trim();
  if (declared) return declared;
  const retrieved = values.map((value) => String(value?.transferSyntaxUID || '').trim()).filter(Boolean);
  return retrieved.length && retrieved.every((syntax) => syntax === retrieved[0]) ? retrieved[0] : '';
}

function assertSupportedSegEncoding(meta, values) {
  const segmentationType = String(meta?.SegmentationType || '').trim().toUpperCase();
  if (segmentationType !== 'BINARY') {
    throw new Error(`segmentation_type_unsupported: SEG import requires BINARY segmentation (SegmentationType=${segmentationType || 'missing'})`);
  }
  const transferSyntax = segTransferSyntax(meta, values);
  if (!transferSyntax) throw new Error('seg_native_pixel_data_unproven: SEG import requires a declared native uncompressed TransferSyntaxUID');
  if (isCompressed(transferSyntax)) throw new Error(`seg_compressed_pixel_data_unsupported: SEG import requires native uncompressed pixel data (TransferSyntaxUID=${transferSyntax})`);
}

export function buildSegOverlayImport(dataset, sourceSeries) {
  const meta = dataset?.meta || {};
  if (normalizeModality(meta.Modality) !== 'SEG') return null;
  const rows = Number(meta.Rows || 0);
  const cols = Number(meta.Columns || 0);
  if (rows !== sourceSeries.height || cols !== sourceSeries.width) {
    throw new Error(`SEG rows/columns ${cols}×${rows} do not match source series ${sourceSeries.width}×${sourceSeries.height}`);
  }

  const frames = frameMetasForInstance(meta) || [];
  const perFrame = Array.isArray(meta.PerFrameFunctionalGroupsSequence) ? meta.PerFrameFunctionalGroupsSequence : [];
  const pixelData = dataset?.pixelData;
  const values = Array.isArray(pixelData?.Value) ? pixelData.Value : [];
  const inline = pixelData?.InlineBinary;
  assertSupportedSegEncoding(meta, values);
  const framePixelCount = rows * cols;
  const bitsAllocated = Number(meta.BitsAllocated || 1);
  const packedFrameByteCount = bitsAllocated === 1 ? Math.ceil(framePixelCount / 8) : framePixelCount;
  const frameValues = values.length === frames.length ? values.map((value) => bytesFromValue(value)) : null;
  const packedBytes = frameValues ? null : bytesFromValue(values[0] ?? inline);
  const packedBytesAreUnpacked = bitsAllocated === 1 && packedBytes?.byteLength === frames.length * framePixelCount;
  const frameByteCount = packedBytesAreUnpacked ? framePixelCount : packedFrameByteCount;
  if ((!frameValues && !packedBytes.length) || !frames.length) {
    throw new Error('SEG import requires frame metadata and uncompressed pixel data');
  }

  const segments = segmentDefinitions(meta);
  const segmentByNumber = new Map(segments.map((segment) => [segment.number, segment]));
  const labelSlices = emptyLabelSlices(cols, rows, sourceSeries.slices);

  for (let index = 0; index < frames.length; index++) {
    const frameMeta = frames[index];
    const segIdent = seqFirst(perFrame[index]?.SegmentIdentificationSequence);
    const segmentNumber = Number(segIdent?.ReferencedSegmentNumber || 1);
    const segment = segmentByNumber.get(segmentNumber);
    if (!segment) continue;
    const ipp = numberList(frameMeta.ImagePositionPatient, 3);
    const sliceIndex = ipp.length >= 3 ? sliceIndexForIPP(sourceSeries, ipp) : index;
    if (sliceIndex < 0 || sliceIndex >= sourceSeries.slices) continue;
    if (!segFrameMatchesSourceGrid(frameMeta, sourceSeries)) {
      throw new Error('SEG frame geometry does not match the source voxel grid; resampling is required before overlay import');
    }
    const frameBytes = frameValues
      ? frameValues[index]
      : packedBytes.slice(index * frameByteCount, (index + 1) * frameByteCount);
    const pixels = segFramePixels(frameBytes, framePixelCount, bitsAllocated);
    const target = labelSlices[sliceIndex];
    for (let i = 0; i < framePixelCount; i++) {
      if (pixels[i] > 0) {
        target[i] = segment.label;
        segment.voxelCount += 1;
      }
    }
  }

  return {
    kind: 'seg',
    overlayKind: 'labels',
    legacySlot: 'regions',
    overlaySource: 'dicom-seg',
    name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'SEG import'),
    labelSlices,
    regionMeta: buildRegionMeta(sourceSeries, segments.filter((segment) => segment.voxelCount > 0)),
  };
}
