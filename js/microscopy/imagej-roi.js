import { PAKO_ESM_URL } from '../core/dependencies.js';
import { inPlanePixelSpacing } from '../core/geometry.js';
import { storedZip } from '../zip-store.js';
export { isImageJRoiFile, isImageJRoiZipFile } from './microscopy-file-kinds.js';

const IMAGEJ_ROI_SCHEMA = 'imagej.roi.v1';
const TYPES = Object.freeze({
  polygon: 0,
  rect: 1,
  oval: 2,
  line: 3,
  polyline: 5,
  freehand: 7,
  traced: 8,
  angle: 9,
  point: 10,
});
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const IMAGEJ_ROI_SUB_PIXEL_RESOLUTION = 0x0080;
const IMAGEJ_ROI_HEADER2_BYTES = 64;
const MAX_IMAGEJ_ROI_ZIP_ENTRIES = 1_024;
const MAX_IMAGEJ_ROI_ZIP_ENTRY_ENCODED_BYTES = 8 * 1024 * 1024;
const MAX_IMAGEJ_ROI_ZIP_ENTRY_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_IMAGEJ_ROI_ZIP_TOTAL_ENCODED_BYTES = 64 * 1024 * 1024;
const MAX_IMAGEJ_ROI_ZIP_TOTAL_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGEJ_ROI_ZIP_INPUT_BYTES = 80 * 1024 * 1024;
export const MAX_IMAGEJ_ROI_FILE_INPUT_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();
let pako = null;
const IN_NODE = typeof globalThis.process !== 'undefined'
  && Boolean(globalThis.process.versions?.node)
  && typeof globalThis.window === 'undefined';

async function ensurePako() {
  if (pako) return pako;
  const mod = IN_NODE ? await import('pako') : await import(PAKO_ESM_URL);
  pako = mod;
  return pako;
}

function short(view, offset) {
  return view.getInt16(offset, false);
}

function ushort(view, offset) {
  return view.getUint16(offset, false);
}

function int(view, offset) {
  return view.getInt32(offset, false);
}

function setShort(view, offset, value) {
  view.setInt16(offset, value, false);
}

function setUshort(view, offset, value) {
  view.setUint16(offset, value, false);
}

function setInt(view, offset, value) {
  view.setInt32(offset, value, false);
}

function setFloat(view, offset, value) {
  view.setFloat32(offset, value, false);
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('ImageJ ROI ZIP inflater returned non-byte data.');
}

function inflatedSizeLimit(maxOutputBytes) {
  const unit = maxOutputBytes === 1 ? 'byte' : 'bytes';
  return imageJRoiZipResourceLimit(`inflated entry exceeds its declared decoded size of ${maxOutputBytes} ${unit}.`);
}

async function readBoundedInflatedStream(stream, maxOutputBytes) {
  const reader = stream.getReader();
  const output = new Uint8Array(maxOutputBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = byteView(value);
      if (chunk.byteLength > maxOutputBytes - length) {
        await Promise.resolve(reader.cancel()).catch(() => {});
        throw inflatedSizeLimit(maxOutputBytes);
      }
      output.set(chunk, length);
      length += chunk.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  return output.subarray(0, length);
}

function inflateRawWithPako(pk, bytes, maxOutputBytes) {
  const output = new Uint8Array(maxOutputBytes);
  const inflator = new pk.Inflate({
    raw: true,
    chunkSize: Math.min(64 * 1024, Math.max(1, maxOutputBytes + 1)),
  });
  let length = 0;
  inflator.onData = (value) => {
    const chunk = byteView(value);
    if (chunk.byteLength > maxOutputBytes - length) throw inflatedSizeLimit(maxOutputBytes);
    output.set(chunk, length);
    length += chunk.byteLength;
  };
  const ok = inflator.push(bytes, true);
  if (!ok || inflator.err) throw new Error(inflator.msg || 'ImageJ ROI ZIP entry could not be inflated.');
  return output.subarray(0, length);
}

async function inflateRawBytes(bytes, maxOutputBytes = MAX_IMAGEJ_ROI_ZIP_ENTRY_DECODED_BYTES) {
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await readBoundedInflatedStream(stream, maxOutputBytes);
    } catch (error) {
      if (error?.imageJRoiZipResourceLimit) throw error;
      // Fall through to pako when a browser exposes DecompressionStream but not deflate-raw.
    }
  }
  const pk = await ensurePako();
  return inflateRawWithPako(pk, bytes, maxOutputBytes);
}

async function boundedInflatedResult(result, maxOutputBytes) {
  const value = await result;
  if (value && typeof value.getReader === 'function') {
    return readBoundedInflatedStream(value, maxOutputBytes);
  }
  const bytes = byteView(value);
  if (bytes.byteLength > maxOutputBytes) throw inflatedSizeLimit(maxOutputBytes);
  return bytes;
}

function finitePoint([x, y]) {
  return Number.isFinite(x) && Number.isFinite(y);
}

function pointsInBounds(points = [], series = {}) {
  const width = Number(series.width || 0);
  const height = Number(series.height || 0);
  if (!(width > 0) || !(height > 0)) return true;
  return points.every(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height);
}

function positiveInt(value, fallback = 1) {
  const n = Math.floor(Number(value));
  return n > 0 ? n : fallback;
}

function explicitImageJIndex(value) {
  const n = Math.floor(Number(value || 0));
  return n > 0 ? n - 1 : null;
}

function microscopyAxisSize(series = {}, name, fallback = 1) {
  return positiveInt(
    series.microscopyDataset?.axes?.find(axis => axis?.name === name)?.size,
    positiveInt(fallback, 1),
  );
}

function polygonPoints(view, left, top, n) {
  const xBase = 64;
  const yBase = xBase + 2 * n;
  return Array.from({ length: n }, (_, index) => [
    left + Math.max(0, short(view, xBase + index * 2)),
    top + Math.max(0, short(view, yBase + index * 2)),
  ]);
}

function subPixelPolygonPoints(view, n, byteLength) {
  const xBase = 64 + 4 * n;
  const yBase = xBase + 4 * n;
  if (yBase + 4 * n > byteLength) throw new Error('ImageJ ROI PolyLine sub-pixel coordinates are incomplete.');
  return Array.from({ length: n }, (_, index) => [
    view.getFloat32(xBase + index * 4, false),
    view.getFloat32(yBase + index * 4, false),
  ]);
}

function utf16BEBytes(text) {
  const value = String(text || '').trim();
  const out = new Uint8Array(value.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < value.length; index += 1) view.setUint16(index * 2, value.charCodeAt(index), false);
  return out;
}

function utf16BEText(view, offset, length) {
  const chars = [];
  for (let index = 0; index < length; index += 1) chars.push(String.fromCharCode(view.getUint16(offset + index * 2, false)));
  return chars.join('').trim();
}

function internalRoiName(view, header2Offset, byteLength) {
  if (!(header2Offset > 0) || header2Offset + 24 > byteLength) return '';
  const nameOffset = int(view, header2Offset + 16);
  const nameLength = int(view, header2Offset + 20);
  if (!(nameLength > 0) || nameOffset < 0 || nameOffset + nameLength * 2 > byteLength) return '';
  return utf16BEText(view, nameOffset, nameLength);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function angleDegrees(points = [], series = {}) {
  const [[x1, y1], [vx, vy], [x3, y3]] = points;
  const spacing = inPlanePixelSpacing(series);
  const dx1 = (x1 - vx) * spacing.colMm;
  const dy1 = (y1 - vy) * spacing.rowMm;
  const dx2 = (x3 - vx) * spacing.colMm;
  const dy2 = (y3 - vy) * spacing.rowMm;
  const mag1 = Math.hypot(dx1, dy1);
  const mag2 = Math.hypot(dx2, dy2);
  if (mag1 < 0.001 || mag2 < 0.001) return 0;
  const cos = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (mag1 * mag2)));
  return Math.acos(cos) * (180 / Math.PI);
}

export function parseImageJRoi(buffer, { name = '' } = {}) {
  const bytes = buffer instanceof ArrayBuffer
    ? buffer
    : buffer?.buffer?.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  if (!bytes || bytes.byteLength < 64) throw new Error('ImageJ ROI file is too small.');
  if (bytes.byteLength > MAX_IMAGEJ_ROI_FILE_INPUT_BYTES) {
    throw new Error(`ImageJ ROI file exceeds the ${MAX_IMAGEJ_ROI_FILE_INPUT_BYTES} byte input budget.`);
  }
  const view = new DataView(bytes);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'Iout') throw new Error('Not an ImageJ ROI file.');
  const version = ushort(view, 4);
  const type = view.getUint8(6);
  const top = short(view, 8);
  const left = short(view, 10);
  const bottom = short(view, 12);
  const right = short(view, 14);
  const count = ushort(view, 16) || int(view, 18);
  const options = ushort(view, 50);
  const position = int(view, 56);
  const header2Offset = int(view, 60);
  const c = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 4) : 0;
  const z = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 8) : 0;
  const t = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 12) : 0;
  const fileName = String(name || '').split(/[\\/]/).pop().replace(/\.roi$/i, '');
  const label = internalRoiName(view, header2Offset, bytes.byteLength) || fileName;
  const preserveSubPixelCoordinates = type === TYPES.polyline && Boolean(options & IMAGEJ_ROI_SUB_PIXEL_RESOLUTION);
  let shape = '';
  let points = [];
  if (type === TYPES.rect) {
    shape = 'polygon';
    points = [[left, top], [right, top], [right, bottom], [left, bottom]];
  } else if (type === TYPES.oval) {
    shape = 'ellipse';
    points = [[left, top], [right, bottom]];
  } else if (type === TYPES.line) {
    shape = 'line';
    points = [
      [view.getFloat32(18, false), view.getFloat32(22, false)],
      [view.getFloat32(26, false), view.getFloat32(30, false)],
    ];
  } else if (type === TYPES.polyline) {
    if (count < 2) throw new Error('ImageJ ROI PolyLine requires at least two points.');
    shape = count === 2 ? 'line' : 'polyline';
    if (options & IMAGEJ_ROI_SUB_PIXEL_RESOLUTION) {
      points = subPixelPolygonPoints(view, count, bytes.byteLength);
    } else {
      if (64 + 4 * count > bytes.byteLength) throw new Error('ImageJ ROI PolyLine coordinates are incomplete.');
      points = polygonPoints(view, left, top, count);
    }
  } else if ([TYPES.polygon, TYPES.freehand, TYPES.traced].includes(type)) {
    if (!(count >= 3) || 64 + 4 * count > bytes.byteLength) throw new Error('ImageJ ROI polygon coordinates are incomplete.');
    shape = 'polygon';
    points = polygonPoints(view, left, top, count);
  } else if (type === TYPES.angle) {
    if (count !== 3 || 64 + 4 * count > bytes.byteLength) throw new Error('ImageJ ROI angle coordinates are incomplete.');
    shape = 'angle';
    points = polygonPoints(view, left, top, count);
  } else if (type === TYPES.point) {
    if (!(count >= 1) || 64 + 4 * count > bytes.byteLength) throw new Error('ImageJ ROI point coordinates are incomplete.');
    shape = 'point';
    points = polygonPoints(view, left, top, count);
  } else {
    throw new Error('Unsupported ImageJ ROI type.');
  }
  if (!points.every(finitePoint)) {
    const kind = type === TYPES.polyline ? ' PolyLine' : '';
    throw new Error(`ImageJ ROI${kind} has non-finite coordinates.`);
  }
  points = points.map(([x, y]) => preserveSubPixelCoordinates ? [x, y] : [Math.round(x), Math.round(y)]);
  if (shape === 'line' && points.length !== 2) throw new Error('ImageJ ROI line requires exactly two points.');
  if (shape === 'polyline' && points.length < 3) throw new Error('ImageJ ROI PolyLine requires at least three points.');
  if (shape === 'angle' && points.length !== 3) throw new Error('ImageJ ROI angle requires exactly three points.');
  if (shape === 'polygon' && points.length < 3) throw new Error('ImageJ ROI polygon requires at least three points.');
  if (!points.length) throw new Error('ImageJ ROI has no usable coordinates.');
  return {
    schema: IMAGEJ_ROI_SCHEMA,
    name: fileName || label,
    label,
    version,
    shape,
    points,
    position,
    channelPosition: c,
    zPosition: z || position,
    timePosition: t,
  };
}

function bounds(points = []) {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function cleanLabel(label = 'roi') {
  return String(label || 'roi').trim().replace(/\.roi$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'roi';
}

function header2Position(row = {}) {
  return {
    c: Math.floor(Number(row.channelIndex || 0)) > 0 ? Math.floor(Number(row.channelIndex)) : 0,
    z: Math.floor(Number(row.slice || 0)) > 0 ? Math.floor(Number(row.slice)) : 0,
    t: Math.floor(Number(row.timeIndex || 0)) > 0 ? Math.floor(Number(row.timeIndex)) : 0,
  };
}

function imageJRoiType(kind) {
  if (kind === 'ellipse') return TYPES.oval;
  if (kind === 'point') return TYPES.point;
  if (kind === 'line') return TYPES.line;
  if (kind === 'angle') return TYPES.angle;
  if (kind === 'polygon') return TYPES.polygon;
  if (kind === 'polyline') return TYPES.polyline;
  return null;
}

export function encodeImageJRoi(row = {}) {
  const points = (Array.isArray(row.points) ? row.points : [])
    .filter(finitePoint)
    .map(([x, y]) => [Math.round(x), Math.round(y)]);
  const type = imageJRoiType(row.kind);
  if (!points.length || type == null) return null;
  const n = row.kind === 'ellipse' || row.kind === 'line' ? 0 : points.length;
  if (row.kind === 'polygon' && n < 3) return null;
  if (row.kind === 'polyline' && n < 3) return null;
  if (row.kind === 'angle' && n !== 3) return null;
  if (row.kind === 'line' && points.length < 2) return null;
  const box = bounds(points);
  const coordinatesBytes = n * 4;
  const header2Offset = 64 + coordinatesBytes;
  const nameBytes = utf16BEBytes(row.label || row.name || '');
  const buffer = new ArrayBuffer(header2Offset + IMAGEJ_ROI_HEADER2_BYTES + nameBytes.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(textEncoder.encode('Iout'), 0);
  setUshort(view, 4, 227);
  view.setUint8(6, type);
  setShort(view, 8, box.top);
  setShort(view, 10, box.left);
  setShort(view, 12, box.bottom);
  setShort(view, 14, box.right);
  setUshort(view, 16, n);
  if (row.kind === 'line') {
    setFloat(view, 18, points[0][0]);
    setFloat(view, 22, points[0][1]);
    setFloat(view, 26, points[1][0]);
    setFloat(view, 30, points[1][1]);
  }
  setInt(view, 56, Math.floor(Number(row.slice || 0)) || 0);
  setInt(view, 60, header2Offset);
  if (n > 0) {
    points.forEach(([x], index) => setShort(view, 64 + index * 2, Math.max(0, x - box.left)));
    points.forEach(([, y], index) => setShort(view, 64 + n * 2 + index * 2, Math.max(0, y - box.top)));
  }
  const position = header2Position(row);
  setInt(view, header2Offset + 4, position.c);
  setInt(view, header2Offset + 8, position.z);
  setInt(view, header2Offset + 12, position.t);
  if (nameBytes.byteLength > 0) {
    setInt(view, header2Offset + 16, header2Offset + IMAGEJ_ROI_HEADER2_BYTES);
    setInt(view, header2Offset + 20, nameBytes.byteLength / 2);
    bytes.set(nameBytes, header2Offset + IMAGEJ_ROI_HEADER2_BYTES);
  }
  return bytes;
}

export function imageJRoiFilename(row = {}, index = 0) {
  const label = cleanLabel(row.label || `${row.kind || 'roi'}-${index + 1}`);
  const z = Math.floor(Number(row.slice || 0)) > 0 ? `z${Math.floor(Number(row.slice))}` : 'z1';
  const c = Math.floor(Number(row.channelIndex || 0)) > 0 ? `c${Math.floor(Number(row.channelIndex))}` : 'c1';
  const t = Math.floor(Number(row.timeIndex || 0)) > 0 ? `t${Math.floor(Number(row.timeIndex))}` : 't1';
  return `${label}_${z}_${c}_${t}.roi`;
}

function uniqueZipEntryName(name, seen) {
  let candidate = name;
  for (let suffix = 2; seen.has(candidate.toLowerCase()); suffix += 1) {
    candidate = name.replace(/\.roi$/i, `-${suffix}.roi`);
  }
  seen.add(candidate.toLowerCase());
  return candidate;
}

function endOfCentralDirectoryOffset(view) {
  const minOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY
      && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  return -1;
}

function imageJRoiZipResourceLimit(reason) {
  const error = new Error(`ImageJ ROI ZIP resource limit: ${reason}`);
  error.imageJRoiZipResourceLimit = true;
  return error;
}

function assertImageJRoiZipEntryBudget(compressedSize, uncompressedSize, totals) {
  if (compressedSize > MAX_IMAGEJ_ROI_ZIP_ENTRY_ENCODED_BYTES) {
    throw imageJRoiZipResourceLimit(`encoded entry exceeds the ${MAX_IMAGEJ_ROI_ZIP_ENTRY_ENCODED_BYTES} byte budget.`);
  }
  if (uncompressedSize > MAX_IMAGEJ_ROI_ZIP_ENTRY_DECODED_BYTES) {
    throw imageJRoiZipResourceLimit(`decoded entry exceeds the ${MAX_IMAGEJ_ROI_ZIP_ENTRY_DECODED_BYTES} byte budget.`);
  }
  if (compressedSize > MAX_IMAGEJ_ROI_ZIP_TOTAL_ENCODED_BYTES - totals.encoded) {
    throw imageJRoiZipResourceLimit(`cumulative encoded entries exceed the ${MAX_IMAGEJ_ROI_ZIP_TOTAL_ENCODED_BYTES} byte budget.`);
  }
  if (uncompressedSize > MAX_IMAGEJ_ROI_ZIP_TOTAL_DECODED_BYTES - totals.decoded) {
    throw imageJRoiZipResourceLimit(`cumulative decoded entries exceed the ${MAX_IMAGEJ_ROI_ZIP_TOTAL_DECODED_BYTES} byte budget.`);
  }
  totals.encoded += compressedSize;
  totals.decoded += uncompressedSize;
}

function zipStructureError(reason) {
  return new Error(`ImageJ ROI ZIP is malformed: ${reason}`);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertArchiveInput(bytes) {
  if (bytes.byteLength > MAX_IMAGEJ_ROI_ZIP_INPUT_BYTES) {
    throw imageJRoiZipResourceLimit(`archive exceeds the ${MAX_IMAGEJ_ROI_ZIP_INPUT_BYTES} byte input budget.`);
  }
  if (bytes.byteLength < 22) throw zipStructureError('end-of-central-directory record is missing.');
}

function centralDirectoryByLocalOffset(bytes, view, decoder) {
  const eocdOffset = endOfCentralDirectoryOffset(view);
  if (eocdOffset < 0) throw zipStructureError('end-of-central-directory record is missing.');
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntryCount = view.getUint16(eocdOffset + 8, true);
  const entries = new Map();
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw zipStructureError('multi-disk archives are not supported.');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipStructureError('ZIP64 archives are not supported.');
  }
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) {
    throw zipStructureError('end-of-central-directory comment envelope is invalid.');
  }
  if (centralOffset > eocdOffset || centralSize !== eocdOffset - centralOffset) {
    throw zipStructureError('central directory range is invalid.');
  }
  if (entryCount > MAX_IMAGEJ_ROI_ZIP_ENTRIES) {
    throw imageJRoiZipResourceLimit(`entry count exceeds the ${MAX_IMAGEJ_ROI_ZIP_ENTRIES} entry budget.`);
  }
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY) {
      throw zipStructureError('central directory is incomplete.');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    const localOffset = view.getUint32(offset + 42, true);
    if (nextOffset > eocdOffset || localOffset >= centralOffset || entries.has(localOffset)) {
      throw zipStructureError('central directory contains an invalid local-entry offset.');
    }
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    entries.set(localOffset, {
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      name: decoder.decode(nameBytes),
      nameBytes,
      localOffset,
    });
    offset = nextOffset;
  }
  if (offset !== eocdOffset) throw zipStructureError('central directory does not match its declared range.');
  return { entries, centralOffset };
}

function assertCentralEntryMatchesLocal(centralEntry, { nameBytes, flags, method, compressedSize, uncompressedSize, crc, hasDataDescriptor }) {
  if (!centralEntry
    || !bytesEqual(centralEntry.nameBytes, nameBytes)
    || centralEntry.method !== method
    || centralEntry.flags !== flags) {
    throw zipStructureError('central-directory metadata does not match its local entry.');
  }
  if (hasDataDescriptor) {
    const localIsZeroed = crc === 0 && compressedSize === 0 && uncompressedSize === 0;
    const localMatchesCentral = crc === centralEntry.crc
      && compressedSize === centralEntry.compressedSize
      && uncompressedSize === centralEntry.uncompressedSize;
    if (!localIsZeroed && !localMatchesCentral) throw zipStructureError('data-descriptor local sizes do not match central metadata.');
    return;
  }
  if (centralEntry.compressedSize !== compressedSize
    || centralEntry.uncompressedSize !== uncompressedSize
    || centralEntry.crc !== crc) {
    throw zipStructureError('central-directory metadata does not match its local entry.');
  }
}

function readAndValidateDataDescriptor(view, offset, byteLength, centralEntry) {
  if (!centralEntry) throw zipStructureError('data descriptor metadata is incomplete.');
  const hasSignature = offset + 4 <= byteLength && view.getUint32(offset, true) === ZIP_DATA_DESCRIPTOR;
  const valueOffset = offset + (hasSignature ? 4 : 0);
  if (valueOffset + 12 > byteLength) throw zipStructureError('entry data descriptor is incomplete.');
  const crc = view.getUint32(valueOffset, true);
  const compressedSize = view.getUint32(valueOffset + 4, true);
  const uncompressedSize = view.getUint32(valueOffset + 8, true);
  if (crc !== centralEntry.crc
    || compressedSize !== centralEntry.compressedSize
    || uncompressedSize !== centralEntry.uncompressedSize) {
    throw zipStructureError('data descriptor does not match central-directory metadata.');
  }
  return valueOffset + 12;
}

export function imageJRoiZip(rows = []) {
  const seenNames = new Set();
  const files = rows.map((row, index) => ({
    name: uniqueZipEntryName(imageJRoiFilename(row, index), seenNames),
    bytes: encodeImageJRoi(row),
  })).filter(file => file.bytes?.byteLength > 0);
  return storedZip(files);
}

export async function parseImageJRoiZipEntries(buffer, { inflateRaw = inflateRawBytes } = {}) {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  assertArchiveInput(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const { entries: centralEntries, centralOffset } = centralDirectoryByLocalOffset(bytes, view, decoder);
  const rois = [];
  const skipped = [];
  const totals = { encoded: 0, decoded: 0 };
  const orderedEntries = [...centralEntries.values()].sort((left, right) => left.localOffset - right.localOffset);
  if (orderedEntries.length !== centralEntries.size || (orderedEntries.length && orderedEntries[0].localOffset !== 0)) {
    throw zipStructureError('local entries do not cover the archive from its start.');
  }
  const validatedEntries = [];
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const centralEntry = orderedEntries[index];
    const offset = centralEntry.localOffset;
    const nextOffset = orderedEntries[index + 1]?.localOffset ?? centralOffset;
    if (offset + 30 > centralOffset || view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw zipStructureError('central directory references a missing local entry.');
    }
    const flags = view.getUint16(offset + 6, true);
    const localMethod = view.getUint16(offset + 8, true);
    const localCrc = view.getUint32(offset + 14, true);
    const localCompressedSize = view.getUint32(offset + 18, true);
    const localUncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart > nextOffset) throw zipStructureError('local entry header extends beyond its declared range.');
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decoder.decode(nameBytes);
    const hasDataDescriptor = Boolean(flags & ZIP_DATA_DESCRIPTOR_FLAG);
    assertCentralEntryMatchesLocal(centralEntry, {
      nameBytes,
      flags,
      method: localMethod,
      compressedSize: localCompressedSize,
      uncompressedSize: localUncompressedSize,
      crc: localCrc,
      hasDataDescriptor,
    });
    const method = centralEntry.method;
    const compressedSize = centralEntry.compressedSize;
    const uncompressedSize = centralEntry.uncompressedSize;
    assertImageJRoiZipEntryBudget(compressedSize, uncompressedSize, totals);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > nextOffset || (method === 0 && compressedSize !== uncompressedSize)) throw zipStructureError('local entry data is incomplete.');
    const descriptorEnd = hasDataDescriptor
      ? readAndValidateDataDescriptor(view, dataEnd, nextOffset, centralEntry)
      : dataEnd;
    if (descriptorEnd !== nextOffset) throw zipStructureError('local entry range contains undeclared bytes.');
    validatedEntries.push({
      name,
      flags,
      method,
      expectedCrc: centralEntry.crc,
      compressedSize,
      uncompressedSize,
      dataStart,
      dataEnd,
    });
  }
  for (const entry of validatedEntries) {
    const { name, flags, method, expectedCrc, uncompressedSize, dataStart, dataEnd } = entry;
    if (/\.roi$/i.test(name)) {
      const roiName = name.split(/[\\/]/).pop();
      if (flags & ZIP_ENCRYPTED_FLAG) {
        skipped.push({ name: roiName, reason: 'unsupported_encryption' });
      } else if (![0, 8].includes(method)) {
        skipped.push({ name: roiName, reason: 'unsupported_compression' });
      } else {
        try {
          const entryBytes = bytes.subarray(dataStart, dataEnd);
          const roiBytes = method === 8
            ? await boundedInflatedResult(inflateRaw(entryBytes, uncompressedSize), uncompressedSize)
            : entryBytes;
          if (method === 8 && roiBytes.byteLength !== uncompressedSize) throw new Error('ImageJ ROI ZIP entry inflated to an unexpected size.');
          if (crc32(roiBytes) !== expectedCrc) {
            skipped.push({ name: roiName, reason: 'checksum_mismatch' });
          } else {
            rois.push(parseImageJRoi(roiBytes, { name: roiName }));
          }
        } catch (error) {
          if (error?.imageJRoiZipResourceLimit) throw error;
          skipped.push({ name: roiName, reason: error?.message || 'unsupported_roi' });
        }
      }
    }
  }
  if (!rois.length) throw new Error('ImageJ ROI ZIP had no supported .roi entries.');
  return { rois, skipped };
}

export async function parseImageJRoiZip(buffer, options = {}) {
  const result = await parseImageJRoiZipEntries(buffer, options);
  return result.rois;
}

export function imageJRoiToAnnotation(roi = {}, series = {}, fallbackSliceIdx = 0) {
  const zSize = microscopyAxisSize(series, 'z', series.slices || series.microscopy?.sizeZ || 1);
  const roiZ = explicitImageJIndex(roi.zPosition);
  if (roiZ != null && roiZ >= zSize) return null;
  const sliceIdx = roiZ ?? Math.max(0, Math.min(zSize - 1, Math.floor(Number(fallbackSliceIdx) || 0)));
  if (!['ellipse', 'polygon', 'polyline', 'point', 'line', 'angle'].includes(roi.shape) || !pointsInBounds(roi.points, series)) return null;
  const roiC = explicitImageJIndex(roi.channelPosition);
  const roiT = explicitImageJIndex(roi.timePosition);
  const sizeC = microscopyAxisSize(series, 'c', series.microscopy?.sizeC || 1);
  const sizeT = microscopyAxisSize(series, 't', series.microscopy?.sizeT || 1);
  if (series.imageDomain === 'microscopy' && ((roiC != null && roiC >= sizeC) || (roiT != null && roiT >= sizeT))) return null;
  const channelIndex = roiC ?? Math.floor(Number(series.microscopy?.channelIndex || 0));
  const timeIndex = roiT ?? Math.floor(Number(series.microscopy?.timeIndex || 0));
  const channel = series.microscopyDataset?.channels?.find(item => Number(item?.index) === channelIndex);
  const label = roi.label || roi.name;
  const microscopy = series.imageDomain === 'microscopy' ? {
    channelIndex,
    channelName: channel?.name || series.microscopy?.channelName || '',
    timeIndex,
  } : null;
  if (roi.shape === 'line') {
    const [[x1, y1], [x2, y2]] = roi.points;
    const spacing = inPlanePixelSpacing(series);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = spacing.known
      ? Math.sqrt((dx * spacing.colMm) ** 2 + (dy * spacing.rowMm) ** 2)
      : Math.sqrt(dx * dx + dy * dy);
    return {
      kind: 'line',
      sliceIdx,
      entry: {
        x1, y1, x2, y2,
        mm: distance,
        unit: spacing.known ? 'mm' : 'px',
        spacingKnown: spacing.known,
        label: label || 'ImageJ line',
        microscopy,
        source: 'ImageJ ROI',
        createdAt: Date.now(),
      },
    };
  }
  if (roi.shape === 'angle') {
    const [p1, vertex, p3] = roi.points.map(([x, y]) => ({ x, y }));
    return {
      kind: 'angle',
      sliceIdx,
      entry: {
        p1,
        vertex,
        p3,
        deg: angleDegrees(roi.points, series),
        label: label || 'ImageJ angle',
        microscopy,
        source: 'ImageJ ROI',
        createdAt: Date.now(),
      },
    };
  }
  if (roi.shape === 'polyline') {
    const spacing = inPlanePixelSpacing(series);
    let lengthPx = 0;
    let lengthMm = 0;
    for (let index = 1; index < roi.points.length; index += 1) {
      const [x1, y1] = roi.points[index - 1];
      const [x2, y2] = roi.points[index];
      lengthPx += Math.hypot(x2 - x1, y2 - y1);
      if (spacing.known) {
        lengthMm += Math.hypot((x2 - x1) * spacing.colMm, (y2 - y1) * spacing.rowMm);
      }
    }
    return {
      kind: 'roi',
      sliceIdx,
      entry: {
        shape: 'polyline',
        pts: roi.points.map(point => point.slice()),
        label: label || 'ImageJ PolyLine',
        microscopy,
        stats: {
          length_px: lengthPx,
          length_mm: spacing.known ? lengthMm : null,
        },
        source: 'ImageJ ROI',
        createdAt: Date.now(),
      },
    };
  }
  return {
    kind: 'roi',
    sliceIdx,
    entry: {
      shape: roi.shape,
      pts: roi.points.map(point => point.slice()),
      label: label || 'ImageJ ROI',
      microscopy,
      ...(roi.shape === 'point' ? { stats: { count: roi.points.length, pixels: roi.points.length } } : {}),
      source: 'ImageJ ROI',
      createdAt: Date.now(),
    },
  };
}
