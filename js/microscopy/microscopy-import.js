import { PAKO_ESM_URL } from '../core/dependencies.js';
import { isMetricLengthUnit, normalizeLengthUnit } from '../core/physical-units.js';
import {
  assertMicroscopyTiffSequenceCompatible,
  metadataForMicroscopyTiffSequence,
  microscopyTiffSequenceName,
  normalizeMicroscopyTiffSequence,
} from './microscopy-sequence-import.js';
import { omeChannelMetadata } from './microscopy-ome-channel-metadata.js';
import {
  decodeTiffLzwStrip,
  MAX_TIFF_COMPRESSED_STRIP_BYTES,
} from './microscopy-tiff-lzw.js';
import {
  assertOmePosition,
  buildMicroscopySeriesResults,
  nextZct,
  omePositionKey,
} from './microscopy-series-results.js';

export { buildMicroscopySeriesResults } from './microscopy-series-results.js';

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
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
};

// Compressed TIFF strips are untrusted input. Limit both stored and expanded
// payloads before making a pixel buffer; each supported strip has an exact size.
const MAX_TIFF_PLANE_PIXELS = 4096 * 4096;
const MAX_TIFF_EAGER_PAGE_BYTES = 192 * 1024 * 1024;
const MAX_TIFF_DOCUMENT_RETAINED_BYTES = 512 * 1024 * 1024;
const SOURCE_FINGERPRINT_WINDOW_BYTES = 4 * 1024;
const SOURCE_FINGERPRINT_WINDOWS = 16;
const IN_NODE = typeof globalThis.process !== 'undefined'
  && Boolean(globalThis.process.versions?.node)
  && typeof globalThis.window === 'undefined';
let pako = null;

// Sample evenly across the input so persistence identity does not require a
// second full-file pass or scale its working set with a large TIFF.
function boundedSourceFingerprint(buffer) {
  const bytes = new Uint8Array(buffer);
  const windowBytes = Math.min(SOURCE_FINGERPRINT_WINDOW_BYTES, bytes.byteLength);
  const windowCount = windowBytes === 0
    ? 0
    : Math.min(SOURCE_FINGERPRINT_WINDOWS, Math.ceil(bytes.byteLength / windowBytes));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const maxStart = bytes.byteLength - windowBytes;
    const start = windowCount === 1 ? 0 : Math.floor((maxStart * windowIndex) / (windowCount - 1));
    first = Math.imul(first ^ start, 0x01000193);
    second = Math.imul(second ^ start, 0x85ebca6b);
    for (let offset = start; offset < start + windowBytes; offset += 1) {
      const byte = bytes[offset];
      first = Math.imul(first ^ byte, 0x01000193);
      second = Math.imul(second ^ byte, 0x85ebca6b);
    }
  }
  const hex = value => (value >>> 0).toString(16).padStart(8, '0');
  return `sample-v1:${bytes.byteLength}:${hex(first)}${hex(second)}`;
}

function microscopySourceSignature(file, buffer) {
  return {
    name: String(file?.name || ''),
    relativePath: String(file?.webkitRelativePath || file?.relativePath || '').replaceAll('\\', '/'),
    byteLength: buffer.byteLength,
    sampleFingerprint: boundedSourceFingerprint(buffer),
  };
}

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

function tiffResourceLimit(reason) {
  const error = new Error(`TIFF resource limit: ${reason}`);
  error.tiffResourceLimit = true;
  return error;
}

function expectedStripBytes(page, stripIndex, rowsPerStrip, bytesPerPixel) {
  const rowStart = stripIndex * rowsPerStrip;
  const rows = Math.min(rowsPerStrip, page.height - rowStart);
  const bytes = rows * page.width * bytesPerPixel;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('TIFF strip geometry exceeds safe integer precision.');
  }
  return bytes;
}

function stripBytes(buffer, offset, byteCount, stripIndex) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteCount) || offset < 0 || byteCount < 0
    || offset > buffer.byteLength || byteCount > buffer.byteLength - offset) {
    throw new Error(`TIFF strip ${stripIndex + 1} points outside the file.`);
  }
  return new Uint8Array(buffer, offset, byteCount);
}

async function ensurePako() {
  if (pako) return pako;
  pako = IN_NODE ? await import('pako') : await import(PAKO_ESM_URL);
  return pako;
}

function joinInflatedParts(parts, length, expectedBytes, stripIndex) {
  if (length !== expectedBytes) {
    throw new Error(`TIFF Deflate strip ${stripIndex + 1} inflated to ${length} bytes; expected ${expectedBytes}.`);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function collectInflatedPart(parts, state, part, expectedBytes, stripIndex) {
  const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (bytes.byteLength > expectedBytes - state.length) {
    throw tiffResourceLimit(`strip ${stripIndex + 1} expands beyond its ${expectedBytes} byte geometry.`);
  }
  parts.push(bytes.slice());
  state.length += bytes.byteLength;
}

async function inflateWithPlatform(source, expectedBytes, stripIndex) {
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const parts = [];
  const state = { length: 0 };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collectInflatedPart(parts, state, value, expectedBytes, stripIndex);
    }
  } finally {
    reader.releaseLock?.();
  }
  return joinInflatedParts(parts, state.length, expectedBytes, stripIndex);
}

async function inflateWithPako(source, expectedBytes, stripIndex) {
  const pk = await ensurePako();
  const Inflate = pk.Inflate || pk.default?.Inflate;
  if (typeof Inflate !== 'function') throw new Error('TIFF Deflate decoder pako.Inflate is unavailable.');
  const inflator = new Inflate();
  const parts = [];
  const state = { length: 0 };
  inflator.onData = part => collectInflatedPart(parts, state, part, expectedBytes, stripIndex);
  try {
    inflator.push(source, true);
  } catch (error) {
    if (error?.tiffResourceLimit) throw error;
    throw new Error(`TIFF Deflate strip ${stripIndex + 1} could not be decompressed.`);
  }
  if (inflator.err || inflator.ended !== true) {
    throw new Error(`TIFF Deflate strip ${stripIndex + 1} could not be decompressed completely.`);
  }
  return joinInflatedParts(parts, state.length, expectedBytes, stripIndex);
}

async function inflateTiffDeflateStrip(source, expectedBytes, stripIndex) {
  if (expectedBytes > MAX_TIFF_COMPRESSED_STRIP_BYTES) {
    throw tiffResourceLimit(`strip ${stripIndex + 1} decoded size ${expectedBytes} exceeds the ${MAX_TIFF_COMPRESSED_STRIP_BYTES} byte budget.`);
  }
  if (source.byteLength > MAX_TIFF_COMPRESSED_STRIP_BYTES) {
    throw tiffResourceLimit(`strip ${stripIndex + 1} encoded size ${source.byteLength} exceeds the ${MAX_TIFF_COMPRESSED_STRIP_BYTES} byte budget.`);
  }
  if (typeof DecompressionStream === 'function') {
    try {
      return await inflateWithPlatform(source, expectedBytes, stripIndex);
    } catch (error) {
      if (error?.tiffResourceLimit) throw error;
    }
  }
  return inflateWithPako(source, expectedBytes, stripIndex);
}

function undoHorizontalPredictor(bytes, page, rowsPerStrip, bytesPerSample, samplesPerPixel, stripIndex) {
  const predictor = Number(scalar(page.tags.get(TIFF_TAG.Predictor), 1));
  if (predictor === 1) return;
  if (predictor !== 2) {
    throw new Error(`Microscopy TIFF import supports Predictor=1 or Predictor=2; found Predictor=${predictor}.`);
  }
  if (Number(page.sampleFormat) === 3) {
    throw new Error('Microscopy TIFF floating-point samples require Predictor=1.');
  }
  const rows = Math.min(rowsPerStrip, page.height - stripIndex * rowsPerStrip);
  const pixelBytes = bytesPerSample * samplesPerPixel;
  const rowBytes = page.width * pixelBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let row = 0; row < rows; row++) {
    const rowOffset = row * rowBytes;
    for (let column = 1; column < page.width; column++) {
      for (let sample = 0; sample < samplesPerPixel; sample += 1) {
        const offset = rowOffset + column * pixelBytes + sample * bytesPerSample;
        const previousOffset = offset - pixelBytes;
        if (bytesPerSample === 1) bytes[offset] = (bytes[offset] + bytes[previousOffset]) & 0xff;
        else if (bytesPerSample === 2) {
          view.setUint16(offset, (view.getUint16(offset, page.littleEndian) + view.getUint16(previousOffset, page.littleEndian)) & 0xffff, page.littleEndian);
        } else {
          view.setUint32(offset, (view.getUint32(offset, page.littleEndian) + view.getUint32(previousOffset, page.littleEndian)) >>> 0, page.littleEndian);
        }
      }
    }
  }
}

function uniformSampleValue(value, samplesPerPixel, fallback, label) {
  const values = asArray(value == null ? fallback : value).map(Number);
  if (!values.length || values.some(item => !Number.isFinite(item)) || values.some(item => item !== values[0])) {
    throw new Error(`Microscopy TIFF ${label} must use one value for every sample.`);
  }
  if (values.length !== 1 && values.length !== samplesPerPixel) {
    throw new Error(`Microscopy TIFF ${label} count must be 1 or SamplesPerPixel.`);
  }
  return values[0];
}

function scalarSampleValue(view, offset, bits, sampleFormat, littleEndian) {
  if (bits === 8) return sampleFormat === 2 ? view.getInt8(offset) : view.getUint8(offset);
  if (bits === 16) return sampleFormat === 2 ? view.getInt16(offset, littleEndian) : view.getUint16(offset, littleEndian);
  if (sampleFormat === 3) return view.getFloat32(offset, littleEndian);
  return sampleFormat === 2 ? view.getInt32(offset, littleEndian) : view.getUint32(offset, littleEndian);
}

function scalarArrayType(bits, sampleFormat) {
  if (bits === 8) return sampleFormat === 2 ? Int8Array : Uint8Array;
  if (bits === 16) return sampleFormat === 2 ? Int16Array : Uint16Array;
  if (sampleFormat === 3) return Float32Array;
  return sampleFormat === 2 ? Int32Array : Uint32Array;
}

async function readPagePixels(view, page, buffer) {
  const compression = Number(scalar(page.tags.get(TIFF_TAG.Compression), 1));
  if (compression !== 1 && compression !== 5 && compression !== 8 && compression !== 32946) {
    throw new Error(`TIFF compression ${compression} is not supported yet; export uncompressed OME-TIFF/TIFF first.`);
  }
  if ([TIFF_TAG.TileWidth, TIFF_TAG.TileLength, TIFF_TAG.TileOffsets, TIFF_TAG.TileByteCounts].some(tag => page.tags.has(tag))) {
    throw new Error('Tiled TIFF pyramids are not supported yet; export stripped OME-TIFF/TIFF first.');
  }
  const samplesPerPixel = Number(page.samplesPerPixel ?? scalar(page.tags.get(TIFF_TAG.SamplesPerPixel), 1));
  if (!Number.isSafeInteger(samplesPerPixel) || samplesPerPixel < 1 || samplesPerPixel > 4) {
    throw new Error(`Microscopy TIFF import supports one, three, or four interleaved samples; found SamplesPerPixel=${samplesPerPixel}.`);
  }
  const planarConfiguration = Number(scalar(page.tags.get(TIFF_TAG.PlanarConfiguration), 1));
  if (samplesPerPixel > 1 && planarConfiguration !== 1) {
    throw new Error('Microscopy TIFF import supports chunky/interleaved RGB(A) planes, not planar-separated samples.');
  }
  const photometric = Number(page.photometric ?? scalar(page.tags.get(TIFF_TAG.PhotometricInterpretation), 1));
  if (samplesPerPixel > 1 && (samplesPerPixel < 3 || photometric !== 2)) {
    throw new Error('Microscopy TIFF import accepts multi-sample planes only when they are RGB/RGBA photometric data.');
  }
  const bits = uniformSampleValue(page.tags.get(TIFF_TAG.BitsPerSample) ?? page.bitsPerSample, samplesPerPixel, 8, 'BitsPerSample');
  if (bits !== 8 && bits !== 16 && bits !== 32) {
    throw new Error(`Microscopy TIFF import supports 8-, 16-, or 32-bit scalar samples; found ${bits}-bit.`);
  }
  const sampleFormat = uniformSampleValue(page.tags.get(TIFF_TAG.SampleFormat) ?? page.sampleFormat, samplesPerPixel, 1, 'SampleFormat');
  if (sampleFormat !== 1 && sampleFormat !== 2 && sampleFormat !== 3) {
    throw new Error(`Microscopy TIFF import supports unsigned, signed, or float scalar samples; found SampleFormat=${sampleFormat}.`);
  }
  if (sampleFormat === 3 && bits !== 32) {
    throw new Error(`Microscopy TIFF import supports float samples only at 32 bits; found ${bits}-bit float.`);
  }
  const offsets = asArray(page.tags.get(TIFF_TAG.StripOffsets));
  const byteCounts = asArray(page.tags.get(TIFF_TAG.StripByteCounts));
  const expectedPixels = page.width * page.height;
  const bytesPerSample = bits / 8;
  const bytesPerPixel = bytesPerSample * samplesPerPixel;
  if (!Number.isSafeInteger(expectedPixels) || expectedPixels <= 0) throw new Error('TIFF image dimensions exceed safe integer precision.');
  const eagerPageBytes = expectedPixels * samplesPerPixel * (bytesPerSample + Float32Array.BYTES_PER_ELEMENT + 4);
  if (expectedPixels > MAX_TIFF_PLANE_PIXELS || !Number.isSafeInteger(eagerPageBytes)
    || eagerPageBytes > MAX_TIFF_EAGER_PAGE_BYTES) {
    throw tiffResourceLimit(
      `page geometry ${page.width}×${page.height} exceeds the ${MAX_TIFF_PLANE_PIXELS} pixel or ${MAX_TIFF_EAGER_PAGE_BYTES} byte eager-allocation budget.`,
    );
  }
  const rowsPerStrip = Number(scalar(page.tags.get(TIFF_TAG.RowsPerStrip), page.height));
  if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip <= 0) throw new Error('TIFF RowsPerStrip must be a positive integer.');
  const stripCount = Math.ceil(page.height / rowsPerStrip);
  if (offsets.length !== stripCount || byteCounts.length !== stripCount) {
    throw new Error(`TIFF strip geometry requires ${stripCount} strips; found ${offsets.length} offsets and ${byteCounts.length} byte counts.`);
  }
  for (let i = 0; i < stripCount; i++) {
    const expectedBytes = expectedStripBytes(page, i, rowsPerStrip, bytesPerPixel);
    if (expectedBytes > MAX_TIFF_COMPRESSED_STRIP_BYTES) {
      throw tiffResourceLimit(
        `strip ${i + 1} decoded size ${expectedBytes} exceeds the ${MAX_TIFF_COMPRESSED_STRIP_BYTES} byte budget.`,
      );
    }
  }
  const bytes = new Uint8Array(expectedPixels * bytesPerPixel);
  let write = 0;
  for (let i = 0; i < stripCount; i++) {
    const offset = Number(offsets[i]);
    const byteCount = Number(byteCounts[i]);
    const expectedBytes = expectedStripBytes(page, i, rowsPerStrip, bytesPerPixel);
    const source = stripBytes(buffer, offset, byteCount, i);
    const decoded = compression === 1
      ? source
      : compression === 5
        ? decodeTiffLzwStrip(source, expectedBytes, i)
        : await inflateTiffDeflateStrip(source, expectedBytes, i);
    if (decoded.byteLength !== expectedBytes) {
      throw new Error(`TIFF strip ${i + 1} has ${decoded.byteLength} bytes; expected ${expectedBytes} from its geometry.`);
    }
    undoHorizontalPredictor(decoded, page, rowsPerStrip, bytesPerSample, samplesPerPixel, i);
    bytes.set(decoded, write);
    write += expectedBytes;
  }
  const PixelArray = scalarArrayType(bits, sampleFormat);
  const channelPixels = Array.from({ length: samplesPerPixel }, () => new PixelArray(expectedPixels));
  const pixelView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < expectedPixels; i++) {
    for (let sample = 0; sample < samplesPerPixel; sample += 1) {
      const value = scalarSampleValue(pixelView, (i * samplesPerPixel + sample) * bytesPerSample, bits, sampleFormat, page.littleEndian);
      if (!Number.isFinite(value)) throw new Error('Microscopy TIFF float samples must be finite.');
      channelPixels[sample][i] = value;
    }
  }
  return { pixels: channelPixels[0], channelPixels: samplesPerPixel > 1 ? channelPixels : null };
}

export async function parseTiffPages(buffer, { maxDocumentRetainedBytes = MAX_TIFF_DOCUMENT_RETAINED_BYTES } = {}) {
  const view = new DataView(buffer);
  const byteOrder = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') throw new Error('Not a TIFF file');
  const magic = view.getUint16(2, littleEndian);
  if (magic !== 42) throw new Error('BigTIFF is not supported yet; export classic OME-TIFF/TIFF first.');
  const pages = [];
  const seen = new Set();
  const requestedDocumentBudget = Math.floor(Number(maxDocumentRetainedBytes));
  const documentBudget = requestedDocumentBudget > 0
    ? Math.min(requestedDocumentBudget, MAX_TIFF_DOCUMENT_RETAINED_BYTES)
    : MAX_TIFF_DOCUMENT_RETAINED_BYTES;
  let modeledRetainedBytes = 0;
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
      const modeledPageBytes = page.width * page.height * page.samplesPerPixel * (Float32Array.BYTES_PER_ELEMENT + 4);
      if (!Number.isSafeInteger(modeledPageBytes) || modeledPageBytes <= 0
        || modeledPageBytes > documentBudget - modeledRetainedBytes) {
        throw tiffResourceLimit(
          `document pages exceed the ${documentBudget} byte retained-pixel and canvas budget.`,
        );
      }
      modeledRetainedBytes += modeledPageBytes;
      page.photometric = Number(scalar(ifd.tags.get(TIFF_TAG.PhotometricInterpretation), 1));
      const decoded = await readPagePixels(view, page, buffer);
      page.pixels = decoded.pixels;
      page.channelPixels = decoded.channelPixels;
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

function tiffDataMappings(text, meta, pageCount) {
  const items = [...text.matchAll(/<TiffData\b([^>]*)\/?>/gi)];
  if (!items.length) return null;
  const mappings = new Map();
  const positions = new Set();
  const requireNonNegativeInteger = (attrs, name, fallback) => {
    const raw = attrs[name];
    const lexeme = raw?.trim();
    if (raw !== undefined && !/^\+?\d+$/.test(lexeme)) {
      throw new Error(`OME-TIFF TiffData ${name} must be a finite non-negative integer.`);
    }
    const value = Number(lexeme ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`OME-TIFF TiffData ${name} must be a finite non-negative integer.`);
    }
    return value;
  };
  for (const item of items) {
    const attrs = {};
    for (const attr of item[1].matchAll(/([A-Za-z0-9_:.-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    const isAttributeFreeDefault = Object.keys(attrs).length === 0;
    let cursor = {
      z: requireNonNegativeInteger(attrs, 'FirstZ', 0),
      c: requireNonNegativeInteger(attrs, 'FirstC', 0),
      t: requireNonNegativeInteger(attrs, 'FirstT', 0),
    };
    const hasExplicitIfd = attrs.IFD !== undefined;
    const ifd = requireNonNegativeInteger(attrs, 'IFD', 0);
    if (ifd >= pageCount) {
      throw new Error(`OME-TIFF TiffData IFD ${ifd} is outside the ${pageCount} decoded IFDs.`);
    }
    const planeCount = requireNonNegativeInteger(attrs, 'PlaneCount', hasExplicitIfd ? 1 : pageCount);
    if (planeCount > pageCount - ifd) {
      throw new Error(`OME-TIFF TiffData IFD ${ifd + planeCount - 1} is outside the ${pageCount} decoded IFDs.`);
    }
    const itemPositions = new Set();
    for (let n = 0; n < planeCount; n++) {
      const pageIndex = ifd + n;
      if (mappings.has(pageIndex)) {
        throw new Error(`OME-TIFF metadata maps IFD ${pageIndex} more than once.`);
      }
      assertOmePosition(cursor, meta);
      const key = omePositionKey(cursor);
      // OME permits only the attribute-free default TiffData element to leave
      // extra decoded IFDs unassigned after the declared pixel cube ends.
      if (itemPositions.has(key)) {
        if (isAttributeFreeDefault) break;
        throw new Error('OME-TIFF TiffData mapping exceeds the declared Z/C/T pixel cube.');
      }
      if (positions.has(key)) {
        throw new Error(`OME-TIFF metadata maps C/Z/T position ${key} more than once.`);
      }
      itemPositions.add(key);
      positions.add(key);
      mappings.set(pageIndex, { ...cursor });
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
  meta.tiffData = tiffDataMappings(description, meta, pageCount);
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
  const canUseResolutionFallback = hasImageJUnit && isMetricLengthUnit(imageJUnit);
  const hasResolutionFallback = xResolution > 0 || yResolution > 0;
  const explicitPixelWidth = Number(lines.pixel_width || 0) || 0;
  const explicitPixelHeight = Number(lines.pixel_height || lines.pixel_width || 0) || 0;
  // ImageJ often writes inch+DPI for display; only metric resolution tags are microscope scale.
  const xSize = explicitPixelWidth || (canUseResolutionFallback && xResolution > 0 ? 1 / xResolution : 0);
  const ySize = explicitPixelHeight || (canUseResolutionFallback && yResolution > 0 ? 1 / yResolution : xSize);
  const warnings = hasImageJUnit ? [] : ['missing_z_physical_size'];
  if (hasImageJUnit && hasResolutionFallback && !explicitPixelWidth && !canUseResolutionFallback) {
    warnings.push('imagej_non_metric_resolution');
  }
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
    warnings,
    channelNames: [],
  };
}

function defaultMetadata(pages) {
  const first = pages[0] || {};
  const samplesPerPixel = Number(first.samplesPerPixel || 1);
  const interleavedRgb = samplesPerPixel >= 3 && Number(first.photometric) === 2;
  const channelNames = interleavedRgb
    ? ['Red', 'Green', 'Blue', ...(samplesPerPixel === 4 ? ['Alpha'] : [])]
    : [];
  const channels = interleavedRgb
    ? [
      { name: 'Red', color: '#FF0000' },
      { name: 'Green', color: '#00FF00' },
      { name: 'Blue', color: '#0000FF' },
      ...(samplesPerPixel === 4 ? [{ name: 'Alpha', color: '#FFFFFF' }] : []),
    ]
    : [];
  return {
    source: 'TIFF',
    sizeZ: pages.length || 1,
    sizeC: interleavedRgb ? samplesPerPixel : 1,
    sizeT: 1,
    dimensionOrder: 'XYZCT',
    physicalSizeX: 0,
    physicalSizeY: 0,
    physicalSizeZ: 0,
    physicalUnit: 'µm',
    channelNames,
    channels,
  };
}

function metadataForPages(pages) {
  const descriptionPage = pages.find(page => page.tags.get(TIFF_TAG.ImageDescription)) || null;
  const description = descriptionPage?.tags.get(TIFF_TAG.ImageDescription) || '';
  return parseOmeXmlMetadata(description, pages.length)
    || parseImageJDescriptionMetadata(description, pages.length, descriptionPage)
    || defaultMetadata(pages);
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
    const pages = await parseTiffPages(buffer);
    const metadata = metadataForPages(pages);
    metadata.sourceSignatures = [microscopySourceSignature(file, buffer)];
    const convertWarnings = Array.isArray(file._voxellabConvertWarnings)
      ? file._voxellabConvertWarnings.map(String).filter(Boolean)
      : [];
    if (convertWarnings.length) metadata.warnings = [...(metadata.warnings || []), ...convertWarnings];
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
      const metadata = metadataForMicroscopyTiffSequence(pages, items[0].metadata, group);
      metadata.sourceSignatures = items.flatMap(item => item.metadata.sourceSignatures || []);
      results.push(...buildMicroscopySeriesResults(
        pages,
        metadata,
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
