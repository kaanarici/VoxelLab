import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROI_TYPE = {
  polygon: 0,
  rect: 1,
  oval: 2,
  line: 3,
  freehand: 7,
  angle: 9,
  point: 10,
  unsupported: 6,
};

async function writeRoiFile(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function boundedRoiHeader(type, { left, top, right, bottom }, extraBytes = 0) {
  const buffer = Buffer.alloc(64 + extraBytes);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(type, 6);
  buffer.writeInt16BE(top, 8);
  buffer.writeInt16BE(left, 10);
  buffer.writeInt16BE(bottom, 12);
  buffer.writeInt16BE(right, 14);
  return buffer;
}

function writeStackPosition(buffer, header2Offset, position) {
  buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, 56);
  buffer.writeInt32BE(header2Offset, 60);
  buffer.writeInt32BE(Math.floor(Number(position.c || 0)) || 0, header2Offset + 4);
  buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, header2Offset + 8);
  buffer.writeInt32BE(Math.floor(Number(position.t || 0)) || 0, header2Offset + 12);
}

export async function writeImageJOvalRoi(path, bounds) {
  await writeRoiFile(path, boundedRoiHeader(ROI_TYPE.oval, bounds));
}

export async function writeImageJRectRoi(path, bounds) {
  await writeRoiFile(path, boundedRoiHeader(ROI_TYPE.rect, bounds));
}

export async function writeUnsupportedImageJRoi(path) {
  await writeRoiFile(path, boundedRoiHeader(ROI_TYPE.unsupported, { left: 3, top: 4, right: 12, bottom: 14 }));
}

export async function writeImageJPolygonRoi(path, { type = ROI_TYPE.polygon, points, position = null }) {
  const left = Math.min(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const right = Math.max(...points.map(([x]) => x));
  const bottom = Math.max(...points.map(([, y]) => y));
  const header2Offset = 64 + points.length * 4;
  const buffer = boundedRoiHeader(
    type,
    { left, top, right, bottom },
    (header2Offset - 64) + (position ? 32 : 0),
  );
  buffer.writeUInt16BE(points.length, 16);
  points.forEach(([x], index) => buffer.writeInt16BE(x - left, 64 + index * 2));
  points.forEach(([, y], index) => buffer.writeInt16BE(y - top, 64 + points.length * 2 + index * 2));
  if (position) writeStackPosition(buffer, header2Offset, position);
  await writeRoiFile(path, buffer);
}

export async function writeImageJPointRoi(path, { points, position = null }) {
  await writeImageJPolygonRoi(path, { type: ROI_TYPE.point, points, position });
}

export async function writeImageJAngleRoi(path, { points, position = null }) {
  await writeImageJPolygonRoi(path, { type: ROI_TYPE.angle, points, position });
}

export async function writeImageJLineRoi(path, { x1, y1, x2, y2, position = null }) {
  const header2Offset = 64;
  const buffer = boundedRoiHeader(ROI_TYPE.line, {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  }, position ? 32 : 0);
  buffer.writeFloatBE(x1, 18);
  buffer.writeFloatBE(y1, 22);
  buffer.writeFloatBE(x2, 26);
  buffer.writeFloatBE(y2, 30);
  if (position) writeStackPosition(buffer, header2Offset, position);
  await writeRoiFile(path, buffer);
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function writeCompressedImageJRoiZip(path, entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const payload = await readFile(entry.path);
    const method = Number.isFinite(entry.method) ? entry.method : 8;
    const compressed = method === 8 ? deflateRawSync(payload) : payload;
    const name = Buffer.from(entry.name);
    const descriptor = entry.dataDescriptor ? Buffer.alloc(16) : null;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    if (entry.dataDescriptor) local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.dataDescriptor) {
      local.writeUInt32LE(crc32(payload), 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(payload.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    if (descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc32(payload), 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(payload.length, 12);
    }
    parts.push(local, compressed, ...(descriptor ? [descriptor] : []));
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    if (entry.dataDescriptor) central.writeUInt16LE(0x08, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(payload), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length + (descriptor?.length || 0);
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([...parts, central, eocd]));
}
