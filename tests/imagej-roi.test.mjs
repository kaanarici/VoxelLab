import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { test } from 'node:test';

const {
  encodeImageJRoi,
  imageJRoiToAnnotation,
  imageJRoiZip,
  parseImageJRoi,
  parseImageJRoiZipEntries,
  parseImageJRoiZip,
} = await import('../js/microscopy/imagej-roi.js');

function roiHeader({ type, top, left, bottom, right, count = 0 }) {
  const buffer = Buffer.alloc(64 + count * 4);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(type, 6);
  buffer.writeInt16BE(top, 8);
  buffer.writeInt16BE(left, 10);
  buffer.writeInt16BE(bottom, 12);
  buffer.writeInt16BE(right, 14);
  buffer.writeUInt16BE(count, 16);
  return buffer;
}

function polygonRoi({ name = 'nucleus.roi', type = 0, left = 2, top = 3, points }) {
  const buffer = roiHeader({ type, left, top, right: 14, bottom: 12, count: points.length });
  points.forEach(([x], index) => buffer.writeInt16BE(x - left, 64 + index * 2));
  points.forEach(([, y], index) => buffer.writeInt16BE(y - top, 64 + points.length * 2 + index * 2));
  return parseImageJRoi(buffer, { name });
}

function writeInternalRoiName(buffer, label) {
  const nameOffset = 96;
  const nameLength = label.length;
  const expanded = Buffer.alloc(nameOffset + nameLength * 2);
  buffer.copy(expanded);
  expanded.writeInt32BE(64, 60);
  expanded.writeInt32BE(nameOffset, 80);
  expanded.writeInt32BE(nameLength, 84);
  for (let index = 0; index < nameLength; index += 1) {
    expanded.writeUInt16BE(label.charCodeAt(index), nameOffset + index * 2);
  }
  return expanded;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function compressedZipEntry(name, payload, { dataDescriptor = false } = {}) {
  const compressed = deflateRawSync(payload);
  const encodedName = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  if (dataDescriptor) local.writeUInt16LE(0x08, 6);
  local.writeUInt16LE(8, 8);
  if (!dataDescriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
  }
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  const descriptor = dataDescriptor ? Buffer.alloc(16) : null;
  if (descriptor) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(payload.length, 12);
  }
  const central = Buffer.alloc(46 + encodedName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  if (dataDescriptor) central.writeUInt16LE(0x08, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  encodedName.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length + (descriptor?.length || 0), 16);
  return Buffer.concat([local, compressed, ...(descriptor ? [descriptor] : []), central, eocd]);
}

function storedLocalZipEntry(name, payload) {
  const encodedName = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  return Buffer.concat([local, payload]);
}

function unsupportedDescriptorThenStoredZip(unsupportedName, unsupportedPayload, storedName, storedPayload) {
  const unsupportedEncodedName = Buffer.from(unsupportedName);
  const unsupportedLocal = Buffer.alloc(30 + unsupportedEncodedName.length);
  unsupportedLocal.writeUInt32LE(0x04034b50, 0);
  unsupportedLocal.writeUInt16LE(20, 4);
  unsupportedLocal.writeUInt16LE(0x08, 6);
  unsupportedLocal.writeUInt16LE(12, 8);
  unsupportedLocal.writeUInt16LE(unsupportedEncodedName.length, 26);
  unsupportedEncodedName.copy(unsupportedLocal, 30);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32(unsupportedPayload), 4);
  descriptor.writeUInt32LE(unsupportedPayload.length, 8);
  descriptor.writeUInt32LE(unsupportedPayload.length, 12);

  const stored = storedLocalZipEntry(storedName, storedPayload);
  const central = Buffer.alloc(46 + unsupportedEncodedName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x08, 8);
  central.writeUInt16LE(12, 10);
  central.writeUInt32LE(crc32(unsupportedPayload), 16);
  central.writeUInt32LE(unsupportedPayload.length, 20);
  central.writeUInt32LE(unsupportedPayload.length, 24);
  central.writeUInt16LE(unsupportedEncodedName.length, 28);
  unsupportedEncodedName.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(unsupportedLocal.length + unsupportedPayload.length + descriptor.length + stored.length, 16);
  return Buffer.concat([unsupportedLocal, unsupportedPayload, descriptor, stored, central, eocd]);
}

test('parseImageJRoi decodes ImageJ polygon coordinates relative to bounds', () => {
  const roi = polygonRoi({ points: [[2, 3], [12, 4], [8, 11]] });

  assert.equal(roi.shape, 'polygon');
  assert.equal(roi.name, 'nucleus');
  assert.deepEqual(roi.points, [[2, 3], [12, 4], [8, 11]]);
});

test('parseImageJRoi decodes freehand and traced ROI coordinates as polygon geometry', () => {
  const points = [[2, 3], [12, 4], [10, 9], [4, 11]];
  const freehand = polygonRoi({ type: 7, name: 'freehand-cell.roi', points });
  const traced = polygonRoi({ type: 8, name: 'traced-cell.roi', points });

  assert.equal(freehand.shape, 'polygon');
  assert.equal(freehand.name, 'freehand-cell');
  assert.deepEqual(freehand.points, points);
  assert.equal(traced.shape, 'polygon');
  assert.equal(traced.name, 'traced-cell');
  assert.deepEqual(traced.points, points);
});

test('parseImageJRoi decodes oval ROI bounds as VoxelLab ellipse points', () => {
  const buffer = roiHeader({ type: 2, left: 4, top: 5, right: 13, bottom: 15 });
  const roi = parseImageJRoi(buffer, { name: 'cell-body.roi' });

  assert.equal(roi.shape, 'ellipse');
  assert.equal(roi.name, 'cell-body');
  assert.deepEqual(roi.points, [[4, 5], [13, 15]]);
});

test('parseImageJRoi decodes rectangular ROI bounds as polygon corners', () => {
  const buffer = roiHeader({ type: 1, left: 3, top: 4, right: 12, bottom: 13 });
  const roi = parseImageJRoi(buffer, { name: 'cell-box.roi' });

  assert.equal(roi.shape, 'polygon');
  assert.equal(roi.name, 'cell-box');
  assert.deepEqual(roi.points, [[3, 4], [12, 4], [12, 13], [3, 13]]);
});

test('parseImageJRoi decodes straight line coordinates', () => {
  const buffer = roiHeader({ type: 3, left: 3, top: 4, right: 12, bottom: 14 });
  buffer.writeFloatBE(3, 18);
  buffer.writeFloatBE(4, 22);
  buffer.writeFloatBE(12, 26);
  buffer.writeFloatBE(14, 30);
  const roi = parseImageJRoi(buffer, { name: 'axon-length.roi' });

  assert.equal(roi.shape, 'line');
  assert.equal(roi.name, 'axon-length');
  assert.deepEqual(roi.points, [[3, 4], [12, 14]]);
});

test('parseImageJRoi preserves ImageJ internal ROI names as labels', () => {
  const buffer = roiHeader({ type: 2, left: 4, top: 5, right: 13, bottom: 15 });
  const roi = parseImageJRoi(writeInternalRoiName(buffer, 'Cell body 42'), { name: 'safe-file-name.roi' });

  assert.equal(roi.name, 'safe-file-name');
  assert.equal(roi.label, 'Cell body 42');
});

test('parseImageJRoi decodes angle ROI coordinates', () => {
  const roi = polygonRoi({
    type: 9,
    name: 'branch-angle.roi',
    points: [[6, 4], [2, 4], [6, 8]],
  });

  assert.equal(roi.shape, 'angle');
  assert.equal(roi.name, 'branch-angle');
  assert.deepEqual(roi.points, [[6, 4], [2, 4], [6, 8]]);
});

test('parseImageJRoi rejects unsupported ImageJ ROI types', () => {
  const buffer = roiHeader({ type: 5, left: 3, top: 4, right: 12, bottom: 14 });

  assert.throws(() => parseImageJRoi(buffer, { name: 'unsupported.roi' }), /Unsupported ImageJ ROI type/);
});

test('imageJRoiToAnnotation rejects ROIs outside the active image bounds', () => {
  const roi = polygonRoi({ points: [[40, 40], [44, 40], [40, 44]] });
  const converted = imageJRoiToAnnotation(roi, { slug: 'cells', width: 16, height: 16, slices: 1 }, 0);

  assert.equal(converted, null);
});

test('imageJRoiToAnnotation rejects partially out-of-bounds ROI geometry', () => {
  const series = { slug: 'cells', width: 16, height: 16, slices: 1 };
  const polygon = polygonRoi({ points: [[2, 3], [12, 4], [20, 11]] });
  const point = polygonRoi({ type: 10, name: 'spots.roi', points: [[4, 5], [17, 8]] });
  const line = parseImageJRoi(encodeImageJRoi({
    kind: 'line',
    label: 'axon',
    points: [[2, 4], [20, 4]],
  }), { name: 'axon.roi' });

  assert.equal(imageJRoiToAnnotation(polygon, series, 0), null);
  assert.equal(imageJRoiToAnnotation(point, series, 0), null);
  assert.equal(imageJRoiToAnnotation(line, series, 0), null);
});

test('imageJRoiToAnnotation maps stack positions and microscopy scope', () => {
  const buffer = roiHeader({ type: 10, left: 2, top: 4, right: 8, bottom: 9, count: 2 });
  buffer.writeInt16BE(1, 64);
  buffer.writeInt16BE(5, 66);
  buffer.writeInt16BE(2, 68);
  buffer.writeInt16BE(4, 70);
  buffer.writeInt32BE(2, 56);
  const roi = parseImageJRoi(buffer, { name: 'spots.roi' });
  const converted = imageJRoiToAnnotation(roi, {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 3,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 0 },
  }, 0);

  assert.equal(converted.sliceIdx, 1);
  assert.equal(converted.entry.shape, 'point');
  assert.deepEqual(converted.entry.pts, [[3, 6], [7, 8]]);
  assert.deepEqual(converted.entry.stats, { count: 2, pixels: 2 });
  assert.deepEqual(converted.entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 0 });
});

test('imageJRoiToAnnotation rejects ImageJ ROI stack positions outside microscopy axes', () => {
  const series = {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 2,
    microscopy: { sizeC: 2, sizeT: 2, channelIndex: 0, timeIndex: 0 },
    microscopyDataset: {
      axes: [{ name: 'z', size: 2 }, { name: 'c', size: 2 }, { name: 't', size: 2 }],
      channels: [{ index: 0, name: 'DAPI' }, { index: 1, name: 'GFP' }],
    },
  };
  const valid = parseImageJRoi(encodeImageJRoi({
    kind: 'point',
    label: 'valid',
    slice: 2,
    channelIndex: 2,
    timeIndex: 2,
    points: [[3, 6]],
  }), { name: 'valid.roi' });
  const converted = imageJRoiToAnnotation(valid, series, 0);

  assert.equal(converted.sliceIdx, 1);
  assert.deepEqual(converted.entry.microscopy, { channelIndex: 1, channelName: 'GFP', timeIndex: 1 });
  for (const bad of [
    { slice: 3, channelIndex: 1, timeIndex: 1 },
    { slice: 1, channelIndex: 3, timeIndex: 1 },
    { slice: 1, channelIndex: 1, timeIndex: 3 },
  ]) {
    const roi = parseImageJRoi(encodeImageJRoi({
      kind: 'point',
      label: 'bad-position',
      points: [[3, 6]],
      ...bad,
    }), { name: 'bad-position.roi' });
    assert.equal(imageJRoiToAnnotation(roi, series, 0), null);
  }
});

test('imageJRoiToAnnotation maps straight line ROI into calibrated measurement entry', () => {
  const buffer = roiHeader({ type: 3, left: 2, top: 4, right: 10, bottom: 4 });
  buffer.writeFloatBE(2, 18);
  buffer.writeFloatBE(4, 22);
  buffer.writeFloatBE(10, 26);
  buffer.writeFloatBE(4, 30);
  const roi = parseImageJRoi(buffer, { name: 'axon-length.roi' });
  const converted = imageJRoiToAnnotation(roi, {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 1,
    pixelSpacing: [0.00025, 0.0005],
    _spacingKnown: true,
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
  }, 0);

  assert.equal(converted.kind, 'line');
  assert.equal(converted.entry.label, 'axon-length');
  assert.deepEqual([converted.entry.x1, converted.entry.y1, converted.entry.x2, converted.entry.y2], [2, 4, 10, 4]);
  assert.equal(converted.entry.unit, 'mm');
  assert.equal(converted.entry.spacingKnown, true);
  assert.equal(converted.entry.mm, 0.004);
  assert.deepEqual(converted.entry.microscopy, { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 });
});

test('imageJRoiToAnnotation prefers ImageJ internal labels over file basenames', () => {
  const buffer = roiHeader({ type: 3, left: 2, top: 4, right: 10, bottom: 4 });
  buffer.writeFloatBE(2, 18);
  buffer.writeFloatBE(4, 22);
  buffer.writeFloatBE(10, 26);
  buffer.writeFloatBE(4, 30);
  const roi = parseImageJRoi(writeInternalRoiName(buffer, 'Axon length curated'), { name: 'axon-length.roi' });
  const converted = imageJRoiToAnnotation(roi, {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 1,
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
  }, 0);

  assert.equal(converted.entry.label, 'Axon length curated');
});

test('imageJRoiToAnnotation maps angle ROI into calibrated angle measurement entry', () => {
  const roi = polygonRoi({
    type: 9,
    name: 'branch-angle.roi',
    points: [[6, 4], [2, 4], [6, 8]],
  });
  const converted = imageJRoiToAnnotation(roi, {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 1,
    pixelSpacing: [0.00025, 0.0005],
    _spacingKnown: true,
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
  }, 0);

  assert.equal(converted.kind, 'angle');
  assert.equal(converted.entry.label, 'branch-angle');
  assert.deepEqual(converted.entry.p1, { x: 6, y: 4 });
  assert.deepEqual(converted.entry.vertex, { x: 2, y: 4 });
  assert.deepEqual(converted.entry.p3, { x: 6, y: 8 });
  assert.equal(Number(converted.entry.deg.toFixed(3)), 26.565);
  assert.deepEqual(converted.entry.microscopy, { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 });
});

test('encodeImageJRoi preserves polygon geometry and C/Z/T positions', () => {
  const bytes = encodeImageJRoi({
    kind: 'polygon',
    label: 'cell',
    slice: 3,
    channelIndex: 2,
    timeIndex: 4,
    points: [[2, 3], [12, 4], [8, 11]],
  });
  const roi = parseImageJRoi(bytes, { name: 'cell.roi' });

  assert.equal(roi.shape, 'polygon');
  assert.equal(roi.label, 'cell');
  assert.deepEqual(roi.points, [[2, 3], [12, 4], [8, 11]]);
  assert.equal(roi.zPosition, 3);
  assert.equal(roi.channelPosition, 2);
  assert.equal(roi.timePosition, 4);
});

test('encodeImageJRoi preserves straight line geometry and C/Z/T positions', () => {
  const bytes = encodeImageJRoi({
    kind: 'line',
    label: 'axon',
    slice: 2,
    channelIndex: 1,
    timeIndex: 3,
    points: [[2, 4], [10, 4]],
  });
  const roi = parseImageJRoi(bytes, { name: 'axon.roi' });

  assert.equal(roi.shape, 'line');
  assert.equal(roi.label, 'axon');
  assert.deepEqual(roi.points, [[2, 4], [10, 4]]);
  assert.equal(roi.zPosition, 2);
  assert.equal(roi.channelPosition, 1);
  assert.equal(roi.timePosition, 3);
});

test('imageJRoiZip round-trips multiple VoxelLab ROI and measurement rows as uncompressed ROI entries', async () => {
  const zip = imageJRoiZip([
    { kind: 'ellipse', label: 'cell body', slice: 1, channelIndex: 1, timeIndex: 1, points: [[4, 5], [13, 15]] },
    { kind: 'point', label: 'spots', slice: 2, channelIndex: 1, timeIndex: 1, points: [[3, 6], [7, 8]] },
    { kind: 'line', label: 'axon length', slice: 2, channelIndex: 1, timeIndex: 1, points: [[2, 4], [10, 4]] },
    { kind: 'angle', label: 'branch angle', slice: 3, channelIndex: 2, timeIndex: 1, points: [[6, 4], [2, 4], [6, 8]] },
  ]);
  const rois = await parseImageJRoiZip(zip);

  assert.equal(rois.length, 4);
  assert.deepEqual(rois.map(roi => roi.shape), ['ellipse', 'point', 'line', 'angle']);
  assert.deepEqual(rois.map(roi => roi.label), ['cell body', 'spots', 'axon length', 'branch angle']);
  assert.deepEqual(rois[0].points, [[4, 5], [13, 15]]);
  assert.deepEqual(rois[1].points, [[3, 6], [7, 8]]);
  assert.deepEqual(rois[2].points, [[2, 4], [10, 4]]);
  assert.deepEqual(rois[3].points, [[6, 4], [2, 4], [6, 8]]);
  assert.deepEqual(rois.map(roi => roi.zPosition), [1, 2, 2, 3]);
  assert.equal(rois[3].channelPosition, 2);
});

test('imageJRoiZip writes deterministic ZIP timestamps', () => {
  const zip = imageJRoiZip([
    { kind: 'line', label: 'axon', slice: 1, channelIndex: 1, timeIndex: 1, points: [[1, 1], [4, 1]] },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralOffset = 30 + view.getUint16(26, true) + view.getUint32(18, true);

  assert.equal(view.getUint16(10, true), 0);
  assert.equal(view.getUint16(12, true), 33);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint16(centralOffset + 12, true), 0);
  assert.equal(view.getUint16(centralOffset + 14, true), 33);
});

test('imageJRoiZip keeps duplicate labels as distinct ROI Manager entries', async () => {
  const zip = imageJRoiZip([
    { kind: 'line', label: 'axon', slice: 1, channelIndex: 1, timeIndex: 1, points: [[1, 1], [4, 1]] },
    { kind: 'line', label: 'axon', slice: 1, channelIndex: 1, timeIndex: 1, points: [[2, 2], [5, 2]] },
    { kind: 'angle', label: 'axon', slice: 1, channelIndex: 1, timeIndex: 1, points: [[6, 4], [2, 4], [6, 8]] },
  ]);
  const rois = await parseImageJRoiZip(zip);

  assert.deepEqual(rois.map(roi => roi.name), [
    'axon_z1_c1_t1',
    'axon_z1_c1_t1-2',
    'axon_z1_c1_t1-3',
  ]);
  assert.deepEqual(rois.map(roi => roi.shape), ['line', 'line', 'angle']);
  assert.deepEqual(rois[1].points, [[2, 2], [5, 2]]);
  assert.deepEqual(rois[2].points, [[6, 4], [2, 4], [6, 8]]);
});

test('parseImageJRoiZip imports deflated ROI Manager entries for supported ROI types', async () => {
  const payload = encodeImageJRoi({
    kind: 'polygon',
    label: 'compressed cell',
    slice: 2,
    channelIndex: 1,
    timeIndex: 3,
    points: [[2, 3], [12, 4], [8, 11]],
  });
  const rois = await parseImageJRoiZip(compressedZipEntry('compressed-cell.roi', payload), {
    inflateRaw: (bytes) => inflateRawSync(bytes),
  });

  assert.equal(rois.length, 1);
  assert.equal(rois[0].name, 'compressed-cell');
  assert.equal(rois[0].shape, 'polygon');
  assert.deepEqual(rois[0].points, [[2, 3], [12, 4], [8, 11]]);
  assert.equal(rois[0].zPosition, 2);
  assert.equal(rois[0].timePosition, 3);
});

test('parseImageJRoiZip uses native deflate streams for compressed ROI Manager entries', async () => {
  const nativeDecompressionStream = globalThis.DecompressionStream;
  assert.equal(typeof nativeDecompressionStream, 'function');
  const formats = [];
  globalThis.DecompressionStream = class CountingDecompressionStream {
    constructor(format) {
      formats.push(format);
      return new nativeDecompressionStream(format);
    }
  };

  try {
    const payload = encodeImageJRoi({
      kind: 'line',
      label: 'native stream axon',
      slice: 1,
      channelIndex: 1,
      timeIndex: 1,
      points: [[2, 4], [10, 4]],
    });
    const rois = await parseImageJRoiZip(compressedZipEntry('native-stream-axon.roi', payload));

    assert.equal(rois.length, 1);
    assert.equal(rois[0].name, 'native-stream-axon');
    assert.equal(rois[0].shape, 'line');
    assert.deepEqual(rois[0].points, [[2, 4], [10, 4]]);
    assert.deepEqual(formats, ['deflate-raw']);
  } finally {
    globalThis.DecompressionStream = nativeDecompressionStream;
  }
});

test('parseImageJRoiZip imports deflated ROI Manager entries that use data descriptors', async () => {
  const payload = encodeImageJRoi({
    kind: 'line',
    label: 'streamed axon',
    slice: 1,
    channelIndex: 2,
    timeIndex: 1,
    points: [[2, 4], [10, 4]],
  });
  const rois = await parseImageJRoiZip(compressedZipEntry('streamed/axon.roi', payload, { dataDescriptor: true }), {
    inflateRaw: (bytes) => inflateRawSync(bytes),
  });

  assert.equal(rois.length, 1);
  assert.equal(rois[0].name, 'axon');
  assert.equal(rois[0].shape, 'line');
  assert.deepEqual(rois[0].points, [[2, 4], [10, 4]]);
  assert.equal(rois[0].channelPosition, 2);
});

test('parseImageJRoiZip normalizes Windows-style folder paths to ROI basenames', async () => {
  const payload = encodeImageJRoi({
    kind: 'angle',
    label: 'branch angle',
    slice: 1,
    channelIndex: 1,
    timeIndex: 1,
    points: [[6, 4], [2, 4], [6, 8]],
  });
  const rois = await parseImageJRoiZip(compressedZipEntry('roi-set\\angles\\branch-angle.roi', payload), {
    inflateRaw: (bytes) => inflateRawSync(bytes),
  });

  assert.equal(rois.length, 1);
  assert.equal(rois[0].name, 'branch-angle');
  assert.equal(rois[0].shape, 'angle');
  assert.deepEqual(rois[0].points, [[6, 4], [2, 4], [6, 8]]);
});

test('parseImageJRoiZipEntries imports supported ROI Manager entries and reports unsupported entries', async () => {
  const supported = encodeImageJRoi({
    kind: 'point',
    label: 'spots',
    slice: 1,
    channelIndex: 1,
    timeIndex: 1,
    points: [[3, 6], [7, 8]],
  });
  const unsupported = roiHeader({ type: 5, left: 3, top: 4, right: 12, bottom: 14 });
  const result = await parseImageJRoiZipEntries(Buffer.concat([
    storedLocalZipEntry('spots.roi', supported),
    storedLocalZipEntry('unsupported.roi', unsupported),
  ]));

  assert.equal(result.rois.length, 1);
  assert.equal(result.rois[0].name, 'spots');
  assert.equal(result.rois[0].shape, 'point');
  assert.deepEqual(result.skipped, [{ name: 'unsupported.roi', reason: 'Unsupported ImageJ ROI type.' }]);
});

test('parseImageJRoiZipEntries skips unsupported data-descriptor entries and continues importing', async () => {
  const supported = encodeImageJRoi({
    kind: 'line',
    label: 'axon',
    slice: 1,
    channelIndex: 1,
    timeIndex: 1,
    points: [[3, 4], [12, 4]],
  });
  const result = await parseImageJRoiZipEntries(unsupportedDescriptorThenStoredZip(
    'unsupported-compressed.roi',
    Buffer.from('unsupported compression payload'),
    'axon.roi',
    supported,
  ));

  assert.equal(result.rois.length, 1);
  assert.equal(result.rois[0].name, 'axon');
  assert.equal(result.rois[0].shape, 'line');
  assert.deepEqual(result.rois[0].points, [[3, 4], [12, 4]]);
  assert.deepEqual(result.skipped, [{ name: 'unsupported-compressed.roi', reason: 'unsupported_compression' }]);
});

test('parseImageJRoiZipEntries rejects ROI Manager archives with no supported entries', async () => {
  const unsupported = roiHeader({ type: 5, left: 3, top: 4, right: 12, bottom: 14 });

  await assert.rejects(
    () => parseImageJRoiZipEntries(storedLocalZipEntry('unsupported.roi', unsupported)),
    /no supported \.roi entries/,
  );
});
