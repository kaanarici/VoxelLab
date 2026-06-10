import { DEFAULT_IOP } from '../core/geometry.js';
import { lengthUnitToMm, normalizeLengthUnit } from '../core/physical-units.js';
import {
  buildMicroscopyDataset,
  channelMetadata,
  datasetSpacingMm,
} from './microscopy-dataset-model.js';
import { rawDisplayRangeToByteRange } from './microscopy-display-range.js';
import {
  assertMicroscopyTiffSequenceCompatible,
  metadataForMicroscopyTiffSequence,
  microscopyTiffSequenceName,
  normalizeMicroscopyTiffSequence,
} from './microscopy-sequence-import.js';
import { omeChannelMetadata } from './microscopy-ome-channel-metadata.js';

const TIFF_TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  ImageDescription: 270,
  StripOffsets: 273,
  XResolution: 282,
  YResolution: 283,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  SampleFormat: 339,
};

const TYPE_BYTES = new Map([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [7, 1],
  [8, 2], [9, 4], [10, 8], [11, 4], [12, 8],
]);

function scalar(value, fallback = 0) {
  return Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback);
}

function asArray(value) {
  return Array.isArray(value) ? value : [value].filter(v => v != null);
}

function readAscii(view, offset, count) {
  let length = count;
  while (length > 0 && view.getUint8(offset + length - 1) === 0) length--;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
}

function readValues(view, type, count, offset, littleEndian) {
  if (type === 2) return readAscii(view, offset, count);
  const values = [];
  for (let i = 0; i < count; i++) {
    const base = offset + i * (TYPE_BYTES.get(type) || 1);
    if (type === 1 || type === 7) values.push(view.getUint8(base));
    else if (type === 3) values.push(view.getUint16(base, littleEndian));
    else if (type === 4) values.push(view.getUint32(base, littleEndian));
    else if (type === 8) values.push(view.getInt16(base, littleEndian));
    else if (type === 9) values.push(view.getInt32(base, littleEndian));
    else if (type === 11) values.push(view.getFloat32(base, littleEndian));
    else if (type === 12) values.push(view.getFloat64(base, littleEndian));
    else if (type === 5 || type === 10) {
      const num = type === 5 ? view.getUint32(base, littleEndian) : view.getInt32(base, littleEndian);
      const den = type === 5 ? view.getUint32(base + 4, littleEndian) : view.getInt32(base + 4, littleEndian);
      values.push(den ? num / den : 0);
    }
  }
  return count === 1 ? values[0] : values;
}

function readIfd(view, offset, littleEndian) {
  const entries = view.getUint16(offset, littleEndian);
  const tags = new Map();
  let cursor = offset + 2;
  for (let i = 0; i < entries; i++) {
    const tag = view.getUint16(cursor, littleEndian);
    const type = view.getUint16(cursor + 2, littleEndian);
    const count = view.getUint32(cursor + 4, littleEndian);
    const bytes = (TYPE_BYTES.get(type) || 1) * count;
    const valueOffset = bytes <= 4 ? cursor + 8 : view.getUint32(cursor + 8, littleEndian);
    tags.set(tag, readValues(view, type, count, valueOffset, littleEndian));
    cursor += 12;
  }
  return {
    tags,
    nextOffset: view.getUint32(cursor, littleEndian),
  };
}

function readPagePixels(view, page, buffer) {
  const compression = Number(scalar(page.tags.get(TIFF_TAG.Compression), 1));
  if (compression !== 1) {
    throw new Error(`TIFF compression ${compression} is not supported yet; export uncompressed OME-TIFF/TIFF first.`);
  }
  const samplesPerPixel = Number(page.samplesPerPixel ?? scalar(page.tags.get(TIFF_TAG.SamplesPerPixel), 1));
  if (samplesPerPixel !== 1) {
    throw new Error(`Microscopy TIFF import currently supports single-channel planes; found SamplesPerPixel=${samplesPerPixel}.`);
  }
  const bits = Number(page.bitsPerSample ?? scalar(page.tags.get(TIFF_TAG.BitsPerSample), 8));
  if (bits !== 8 && bits !== 16) {
    throw new Error(`Microscopy TIFF import supports 8- or 16-bit grayscale planes; found ${bits}-bit.`);
  }
  const sampleFormat = Number(page.sampleFormat ?? scalar(page.tags.get(TIFF_TAG.SampleFormat), 1));
  if (sampleFormat !== 1 && sampleFormat !== 2) {
    throw new Error(`Microscopy TIFF import supports signed or unsigned integer grayscale planes; found SampleFormat=${sampleFormat}.`);
  }
  const offsets = asArray(page.tags.get(TIFF_TAG.StripOffsets));
  const byteCounts = asArray(page.tags.get(TIFF_TAG.StripByteCounts));
  const expectedPixels = page.width * page.height;
  const bytes = new Uint8Array(expectedPixels * (bits / 8));
  let write = 0;
  for (let i = 0; i < offsets.length; i++) {
    const offset = Number(offsets[i]);
    const byteCount = Number(byteCounts[i] || 0);
    if (!byteCount) continue;
    bytes.set(new Uint8Array(buffer, offset, byteCount), write);
    write += byteCount;
  }
  const pixels = new Float32Array(expectedPixels);
  const pixelView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < expectedPixels; i++) {
    if (bits === 8) pixels[i] = sampleFormat === 2 ? pixelView.getInt8(i) : pixelView.getUint8(i);
    else pixels[i] = sampleFormat === 2 ? pixelView.getInt16(i * 2, page.littleEndian) : pixelView.getUint16(i * 2, page.littleEndian);
  }
  return pixels;
}

export function parseTiffPages(buffer) {
  const view = new DataView(buffer);
  const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') throw new Error('Not a TIFF file');
  const magic = view.getUint16(2, littleEndian);
  if (magic !== 42) throw new Error('BigTIFF is not supported yet; export classic OME-TIFF/TIFF first.');
  const pages = [];
  const seen = new Set();
  let offset = view.getUint32(4, littleEndian);
  while (offset && !seen.has(offset)) {
    seen.add(offset);
    const ifd = readIfd(view, offset, littleEndian);
    const width = Number(scalar(ifd.tags.get(TIFF_TAG.ImageWidth)));
    const height = Number(scalar(ifd.tags.get(TIFF_TAG.ImageLength)));
    if (width > 0 && height > 0) {
      const page = {
        ...ifd,
        width,
        height,
        littleEndian,
        bitsPerSample: Number(scalar(ifd.tags.get(TIFF_TAG.BitsPerSample), 8)),
        samplesPerPixel: Number(scalar(ifd.tags.get(TIFF_TAG.SamplesPerPixel), 1)),
        sampleFormat: Number(scalar(ifd.tags.get(TIFF_TAG.SampleFormat), 1)),
      };
      page.pixels = readPagePixels(view, page, buffer);
      page.photometric = Number(scalar(ifd.tags.get(TIFF_TAG.PhotometricInterpretation), 1));
      pages.push(page);
    }
    offset = ifd.nextOffset;
  }
  return pages;
}

function attrsFromTag(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}\\b([^>]*)>`, 'i'));
  if (!match) return {};
  const attrs = {};
  for (const item of match[1].matchAll(/([A-Za-z0-9_:.-]+)="([^"]*)"/g)) {
    attrs[item[1]] = item[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return attrs;
}

function tiffDataMappings(text, meta) {
  const items = [...text.matchAll(/<TiffData\b([^>]*)\/?>/gi)];
  if (!items.length) return null;
  const mappings = new Map();
  for (const item of items) {
    const attrs = {};
    for (const attr of item[1].matchAll(/([A-Za-z0-9_:.-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    let cursor = {
      z: Number(attrs.FirstZ || 0),
      c: Number(attrs.FirstC || 0),
      t: Number(attrs.FirstT || 0),
    };
    const ifd = Number(attrs.IFD || 0);
    const planeCount = Number(attrs.PlaneCount || 1);
    for (let n = 0; n < planeCount; n++) {
      mappings.set(ifd + n, { ...cursor });
      cursor = nextZct(cursor, meta);
    }
  }
  return mappings;
}

export function parseOmeXmlMetadata(description = '', pageCount = 1) {
  if (!/<OME[\s>]/i.test(description)) return null;
  const pixels = attrsFromTag(description, 'Pixels');
  const channels = omeChannelMetadata(description);
  const unit = normalizeLengthUnit(pixels.PhysicalSizeXUnit || pixels.PhysicalSizeYUnit || pixels.PhysicalSizeZUnit || 'µm');
  const physicalUnits = {
    x: pixels.PhysicalSizeXUnit || unit,
    y: pixels.PhysicalSizeYUnit || unit,
    z: pixels.PhysicalSizeZUnit || unit,
  };
  const meta = {
    source: 'OME-TIFF',
    sizeX: Number(pixels.SizeX || 0),
    sizeY: Number(pixels.SizeY || 0),
    sizeZ: Number(pixels.SizeZ || 1),
    sizeC: Number(pixels.SizeC || 1),
    sizeT: Number(pixels.SizeT || 1),
    dimensionOrder: pixels.DimensionOrder || 'XYZCT',
    physicalSizeX: Number(pixels.PhysicalSizeX || 0),
    physicalSizeY: Number(pixels.PhysicalSizeY || 0),
    physicalSizeZ: Number(pixels.PhysicalSizeZ || 0),
    physicalUnit: unit,
    physicalUnits,
    channelNames: channels.map(channel => channel.name),
    channels,
  };
  if (!(meta.sizeZ > 0)) meta.sizeZ = pageCount;
  if (!(meta.sizeC > 0)) meta.sizeC = 1;
  if (!(meta.sizeT > 0)) meta.sizeT = 1;
  meta.tiffData = tiffDataMappings(description, meta);
  return meta;
}

function positiveTagNumber(tags, tag) {
  const value = Number(tags?.get?.(tag) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseImageJDescriptionMetadata(description = '', pageCount = 1, page = null) {
  if (!/^ImageJ=/m.test(description)) return null;
  const lines = Object.fromEntries(description.split(/\r?\n/).map((line) => {
    const idx = line.indexOf('=');
    return idx > 0 ? [line.slice(0, idx), line.slice(idx + 1)] : null;
  }).filter(Boolean));
  const sizeC = Number(lines.channels || 1) || 1;
  const sizeT = Number(lines.frames || 1) || 1;
  const imageCount = Number(lines.images || pageCount) || pageCount;
  const zDenominator = Math.max(1, sizeC * sizeT);
  const inferredSizeZ = Math.max(1, imageCount % zDenominator === 0 ? imageCount / zDenominator : imageCount);
  // ImageJ's TIFF decoder maps X/YResolution to reciprocal pixel size.
  // Reference: https://wsr.imagej.net/source/html/ij/io/TiffDecoder.java.html
  const xResolution = positiveTagNumber(page?.tags, TIFF_TAG.XResolution);
  const yResolution = positiveTagNumber(page?.tags, TIFF_TAG.YResolution);
  const imageJUnit = String(lines.unit || '').trim();
  const hasImageJUnit = imageJUnit.length > 0;
  const xSize = Number(lines.pixel_width || 0) || (hasImageJUnit && xResolution > 0 ? 1 / xResolution : 0);
  const ySize = Number(lines.pixel_height || lines.pixel_width || 0)
    || (hasImageJUnit && yResolution > 0 ? 1 / yResolution : xSize);
  return {
    source: 'ImageJ-TIFF',
    sizeZ: Number(lines.slices || inferredSizeZ) || inferredSizeZ,
    sizeC,
    sizeT,
    dimensionOrder: 'XYCZT',
    physicalSizeX: xSize,
    physicalSizeY: ySize,
    physicalSizeZ: Number(lines.spacing || 0),
    physicalUnit: hasImageJUnit ? normalizeLengthUnit(imageJUnit) : '',
    warnings: hasImageJUnit ? [] : ['missing_z_physical_size'],
    channelNames: [],
  };
}

function defaultMetadata(pages) {
  return {
    source: 'TIFF',
    sizeZ: pages.length || 1,
    sizeC: 1,
    sizeT: 1,
    dimensionOrder: 'XYZCT',
    physicalSizeX: 0,
    physicalSizeY: 0,
    physicalSizeZ: 0,
    physicalUnit: 'µm',
    channelNames: [],
  };
}

function metadataForPages(pages) {
  const descriptionPage = pages.find(page => page.tags.get(TIFF_TAG.ImageDescription)) || null;
  const description = descriptionPage?.tags.get(TIFF_TAG.ImageDescription) || '';
  return parseOmeXmlMetadata(description, pages.length)
    || parseImageJDescriptionMetadata(description, pages.length, descriptionPage)
    || defaultMetadata(pages);
}

function nextZct(position, meta) {
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

function zctForPlane(index, meta) {
  if (meta.tiffData?.has(index)) return meta.tiffData.get(index);
  let position = { z: 0, c: 0, t: 0 };
  for (let i = 0; i < index; i++) position = nextZct(position, meta);
  return position;
}

function normalizeVolumePixels(planes) {
  let lo = Infinity, hi = -Infinity;
  for (const plane of planes) {
    for (const value of plane.pixels) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 0, range: 1 };
  const range = hi - lo || 1;
  return { lo, hi, range };
}

function displayRangeForChannel(channel) {
  if (channel?.displayRangeSource !== 'metadata') return null;
  return channel.displayRange;
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
    let v = Math.round(((plane.pixels[i] - lo) / range) * 255);
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    if (invert) v = 255 - v;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
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

// Cap on retained raw single-channel plane bytes per series. Above this the raw store is
// dropped (analysis disables, fail-closed) rather than risk bloating device memory — the
// lightweight, runs-anywhere promise outranks raw-domain analysis on oversized stacks.
const MAX_RAW_RETENTION_BYTES = 1.5e9;

export function buildMicroscopySeriesResults(pages, metadata, fileName, slugBase = `micro_${Date.now().toString(36)}`) {
  if (!pages.length) throw new Error('No TIFF image planes found');
  const planePositions = pages.map((_, index) => zctForPlane(index, metadata));
  const dataset = buildMicroscopyDataset({ pages, metadata, fileName, slugBase, planePositions });
  const byKey = new Map();
  pages.forEach((page, index) => {
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
    const displayRange = displayRangeForChannel(channelMetadata(dataset, Number(channelText) || 0));
    localStacks[key] = planes.map(plane => canvasForPlane(plane, valueRange, displayRange));
    rawPlanes[key] = planes.map((plane) => {
      rawBytes += plane.pixels.byteLength;
      return { pixels: plane.pixels, width: plane.width, height: plane.height };
    });
  }
  const retainedRawPlanes = rawBytes <= MAX_RAW_RETENTION_BYTES ? rawPlanes : null;
  const defaultKey = localStacks['0|0'] ? '0|0' : sortedKeys[0];
  const defaultPlanes = byKey.get(defaultKey) || [];
  const [defaultCText, defaultTText] = defaultKey.split('|');
  const defaultC = Number(defaultCText) || 0;
  const defaultT = Number(defaultTText) || 0;
  const width = defaultPlanes[0]?.width || dataset.levels[0].width;
  const height = defaultPlanes[0]?.height || dataset.levels[0].height;
  const channelName = channelMetadata(dataset, defaultC).name;
  const spacingText = rowMm > 0 && colMm > 0 ? ` · ${(colMm / unitToMm).toFixed(3)} ${unit}/px` : '';
  const axesText = `Z ${metadata.sizeZ || defaultPlanes.length} · C ${metadata.sizeC || 1} · T ${metadata.sizeT || 1}`;
  const slug = cleanSlugPart(slugBase);
  return [{
    entry: {
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
      sliceSpacingRegular: true,
      tr: 0,
      te: 0,
      sequence: metadata.source,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, zKnown ? (defaultPlanes.length - 1) * zMm : 0],
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
      geometryKind: 'microscopyStack',
      reconstructionCapability: '2d-only',
      renderability: '2d',
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
      },
      microscopyDataset: dataset,
      _spacingKnown: rowMm > 0 && colMm > 0,
      _sliceSpacingKnown: zKnown,
    },
    sliceCanvases: localStacks[defaultKey],
    localStacks,
    rawPlanes: retainedRawPlanes,
  }];
}

export async function parseMicroscopyFiles(files, onProgress = () => {}) {
  const tiffs = Array.from(files).filter(file => /\.(ome\.)?tiff?$/i.test(file?.name || ''));
  if (!tiffs.length) return null;
  const seed = Date.now().toString(36);
  const results = [];
  const parsed = [];
  for (let i = 0; i < tiffs.length; i++) {
    const file = tiffs[i];
    onProgress('reading', file.name);
    const buffer = await file.arrayBuffer();
    const pages = parseTiffPages(buffer);
    const metadata = metadataForPages(pages);
    parsed.push({ file, pages, metadata, sourceIndex: i });
  }
  const sequence = tiffs.length > 1 ? normalizeMicroscopyTiffSequence(parsed.map(({ file, sourceIndex }) => ({
    name: file.name,
    path: file.path || file.webkitRelativePath || '',
    sourceIndex,
  }))) : null;
  const groups = sequence?.groups || parsed.map(item => ({
    planes: [{ name: item.file.name, sourceIndex: item.sourceIndex }],
    warnings: [],
  }));
  for (const group of groups) {
    const items = group.planes.map(plane => parsed[plane.sourceIndex]).filter(Boolean);
    const stackAsSequence = items.length > 1 && items.every(item => item.pages.length === 1);
    if (stackAsSequence) {
      const pages = items.map(item => item.pages[0]);
      assertMicroscopyTiffSequenceCompatible(pages);
      const name = microscopyTiffSequenceName(group);
      results.push(...buildMicroscopySeriesResults(
        pages,
        metadataForMicroscopyTiffSequence(pages, items[0].metadata, group),
        `${name}.tiff`,
        `micro_${seed}_${results.length + 1}`,
      ));
      continue;
    }
    for (const item of items) {
      results.push(...buildMicroscopySeriesResults(
        item.pages,
        item.metadata,
        item.file.name,
        `micro_${seed}_${results.length + 1}`,
      ));
    }
  }
  return results.length ? results : null;
}
