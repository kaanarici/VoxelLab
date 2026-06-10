import { PAKO_ESM_URL } from '../core/dependencies.js';
import { inPlanePixelSpacing } from '../core/geometry.js';
export { isImageJRoiFile, isImageJRoiZipFile } from './microscopy-file-kinds.js';

const IMAGEJ_ROI_SCHEMA = 'imagej.roi.v1';
const TYPES = Object.freeze({
  polygon: 0,
  rect: 1,
  oval: 2,
  line: 3,
  freehand: 7,
  traced: 8,
  angle: 9,
  point: 10,
});
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_DEFAULT_TIME = 0;
const ZIP_DEFAULT_DATE = 33;
const textEncoder = new TextEncoder();
let pako = null;

async function ensurePako() {
  if (pako) return pako;
  const mod = await import(PAKO_ESM_URL);
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

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Fall through to pako when a browser exposes DecompressionStream but not deflate-raw.
    }
  }
  const pk = await ensurePako();
  return pk.inflateRaw(bytes);
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
  const position = int(view, 56);
  const header2Offset = int(view, 60);
  const c = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 4) : 0;
  const z = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 8) : 0;
  const t = header2Offset > 0 && header2Offset + 16 <= bytes.byteLength ? int(view, header2Offset + 12) : 0;
  const fileName = String(name || '').split(/[\\/]/).pop().replace(/\.roi$/i, '');
  const label = internalRoiName(view, header2Offset, bytes.byteLength) || fileName;
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
  points = points.filter(finitePoint).map(([x, y]) => [Math.round(x), Math.round(y)]);
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
  if (row.kind === 'angle' && n !== 3) return null;
  if (row.kind === 'line' && points.length < 2) return null;
  const box = bounds(points);
  const coordinatesBytes = n * 4;
  const header2Offset = 64 + coordinatesBytes;
  const nameBytes = utf16BEBytes(row.label || row.name || '');
  const buffer = new ArrayBuffer(header2Offset + 32 + nameBytes.byteLength);
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
    setInt(view, header2Offset + 16, header2Offset + 32);
    setInt(view, header2Offset + 20, nameBytes.byteLength / 2);
    bytes.set(nameBytes, header2Offset + 32);
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
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function centralDirectoryByLocalOffset(bytes, view, decoder) {
  const eocdOffset = endOfCentralDirectoryOffset(view);
  if (eocdOffset < 0) return new Map();
  const entries = new Map();
  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  for (let index = 0; index < entryCount && offset + 46 <= bytes.byteLength; index += 1) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    const localOffset = view.getUint32(offset + 42, true);
    entries.set(localOffset, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
    });
    offset = nextOffset;
  }
  return entries;
}

export function imageJRoiZip(rows = []) {
  const seenNames = new Set();
  const files = rows.map((row, index) => ({
    name: uniqueZipEntryName(imageJRoiFilename(row, index), seenNames),
    bytes: encodeImageJRoi(row),
  })).filter(file => file.bytes?.byteLength > 0);
  if (!files.length) return null;
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = textEncoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(10, ZIP_DEFAULT_TIME, true);
    localView.setUint16(12, ZIP_DEFAULT_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    localParts.push(local, file.bytes);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(12, ZIP_DEFAULT_TIME, true);
    centralView.setUint16(14, ZIP_DEFAULT_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength + file.bytes.byteLength;
  }
  const centralOffset = offset;
  const central = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, centralOffset, true);
  return concatBytes([...localParts, central, eocd]);
}

export async function parseImageJRoiZipEntries(buffer, { inflateRaw = inflateRawBytes } = {}) {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const centralEntries = centralDirectoryByLocalOffset(bytes, view, decoder);
  const rois = [];
  const skipped = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === ZIP_LOCAL_FILE_HEADER) {
    const flags = view.getUint16(offset + 6, true);
    let method = view.getUint16(offset + 8, true);
    let compressedSize = view.getUint32(offset + 18, true);
    let uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const centralEntry = centralEntries.get(offset);
    if (flags & 0x08) {
      if (!centralEntry || centralEntry.name !== name) throw new Error('ImageJ ROI ZIP data descriptor metadata is incomplete.');
      method = centralEntry.method;
      compressedSize = centralEntry.compressedSize;
      uncompressedSize = centralEntry.uncompressedSize;
    }
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength || (method === 0 && compressedSize !== uncompressedSize)) throw new Error('ImageJ ROI ZIP entry is incomplete.');
    if (/\.roi$/i.test(name)) {
      const roiName = name.split(/[\\/]/).pop();
      if (![0, 8].includes(method)) {
        skipped.push({ name: roiName, reason: 'unsupported_compression' });
      } else {
        try {
          const entryBytes = bytes.subarray(dataStart, dataEnd);
          const roiBytes = method === 8 ? await inflateRaw(entryBytes) : entryBytes;
          if (method === 8 && roiBytes.byteLength !== uncompressedSize) throw new Error('ImageJ ROI ZIP entry inflated to an unexpected size.');
          rois.push(parseImageJRoi(roiBytes, { name: roiName }));
        } catch (error) {
          skipped.push({ name: roiName, reason: error?.message || 'unsupported_roi' });
        }
      }
    }
    offset = dataEnd;
    if (flags & 0x08) {
      const descriptorLength = offset + 16 <= bytes.byteLength && view.getUint32(offset, true) === ZIP_DATA_DESCRIPTOR ? 16 : 12;
      if (offset + descriptorLength > bytes.byteLength) throw new Error('ImageJ ROI ZIP entry is incomplete.');
      offset += descriptorLength;
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
  if (!['ellipse', 'polygon', 'point', 'line', 'angle'].includes(roi.shape) || !pointsInBounds(roi.points, series)) return null;
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
