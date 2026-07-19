import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import {
  compressedLocalZipEntry,
  compressedZipEntry,
  localZipEntryWithSizes,
  storedLocalZipEntry,
  unsupportedDescriptorThenStoredZip,
  withDeclaredUncompressedSize,
  zipArchive,
} from './fixtures/imagej-roi-zip-helpers.mjs';

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

function writeImageJRoiHeader2(buffer, { label = '', channel = 0, slice = 0, time = 0 } = {}) {
  const header2Offset = buffer.length;
  const nameOffset = header2Offset + 64;
  const expanded = Buffer.alloc(nameOffset + label.length * 2);
  buffer.copy(expanded);
  expanded.writeInt32BE(header2Offset, 60);
  expanded.writeInt32BE(channel, header2Offset + 4);
  expanded.writeInt32BE(slice, header2Offset + 8);
  expanded.writeInt32BE(time, header2Offset + 12);
  if (label) {
    expanded.writeInt32BE(nameOffset, header2Offset + 16);
    expanded.writeInt32BE(label.length, header2Offset + 20);
    for (let index = 0; index < label.length; index += 1) {
      expanded.writeUInt16BE(label.charCodeAt(index), nameOffset + index * 2);
    }
  }
  return expanded;
}

function writeInternalRoiName(buffer, label) {
  const nameOffset = 128;
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

test('parseImageJRoi decodes ImageJ polygon coordinates relative to bounds', () => {
  const roi = polygonRoi({ points: [[2, 3], [12, 4], [8, 11]] });

  assert.equal(roi.shape, 'polygon');
  assert.equal(roi.name, 'nucleus');
  assert.deepEqual(roi.points, [[2, 3], [12, 4], [8, 11]]);
});

test('parseImageJRoi reads absolute sub-pixel coordinates from two-vertex PolyLines', () => {
  const buffer = Buffer.alloc(64 + 12 * 2);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(5, 6);
  buffer.writeUInt16BE(2, 16);
  buffer.writeUInt16BE(0x80, 50);
  buffer.writeFloatBE(2.25, 72);
  buffer.writeFloatBE(10.75, 76);
  buffer.writeFloatBE(4.5, 80);
  buffer.writeFloatBE(10.125, 84);

  const roi = parseImageJRoi(buffer, { name: 'subpixel-segment.roi' });

  assert.equal(roi.shape, 'line');
  assert.deepEqual(roi.points, [[2.25, 4.5], [10.75, 10.125]]);
});

test('parseImageJRoi rejects truncated sub-pixel PolyLine coordinate arrays', () => {
  const buffer = Buffer.alloc(64 + 12 * 2 - 1);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(5, 6);
  buffer.writeUInt16BE(2, 16);
  buffer.writeUInt16BE(0x80, 50);

  assert.throws(
    () => parseImageJRoi(buffer, { name: 'truncated-subpixel.roi' }),
    /ImageJ ROI PolyLine sub-pixel coordinates are incomplete\./,
  );
});

test('parseImageJRoi rejects non-finite sub-pixel PolyLine coordinates', () => {
  const buffer = Buffer.alloc(64 + 12 * 2);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(5, 6);
  buffer.writeUInt16BE(2, 16);
  buffer.writeUInt16BE(0x80, 50);
  buffer.writeFloatBE(Number.NaN, 72);
  buffer.writeFloatBE(10.75, 76);
  buffer.writeFloatBE(4.5, 80);
  buffer.writeFloatBE(10.125, 84);

  assert.throws(
    () => parseImageJRoi(buffer, { name: 'non-finite-subpixel.roi' }),
    /ImageJ ROI PolyLine has non-finite coordinates\./,
  );
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

test('parseImageJRoi rejects non-finite straight-line coordinates at the parser boundary', () => {
  const buffer = roiHeader({ type: 3, left: 3, top: 4, right: 12, bottom: 14 });
  buffer.writeFloatBE(Number.NaN, 18);
  buffer.writeFloatBE(4, 22);
  buffer.writeFloatBE(12, 26);
  buffer.writeFloatBE(14, 30);

  assert.throws(
    () => parseImageJRoi(buffer, { name: 'broken-line.roi' }),
    /ImageJ ROI has non-finite coordinates\./,
  );
});

test('parseImageJRoi normalizes a two-vertex PolyLine into a positioned straight line', () => {
  const buffer = roiHeader({ type: 5, left: 2, top: 4, right: 10, bottom: 10, count: 2 });
  buffer.writeInt16BE(0, 64);
  buffer.writeInt16BE(8, 66);
  buffer.writeInt16BE(0, 68);
  buffer.writeInt16BE(6, 70);
  const roi = parseImageJRoi(writeImageJRoiHeader2(buffer, {
    label: 'Curated axon segment',
    channel: 2,
    slice: 3,
    time: 4,
  }), { name: 'axon-segment.roi' });

  assert.equal(roi.shape, 'line');
  assert.equal(roi.name, 'axon-segment');
  assert.equal(roi.label, 'Curated axon segment');
  assert.deepEqual(roi.points, [[2, 4], [10, 10]]);
  assert.equal(roi.channelPosition, 2);
  assert.equal(roi.zPosition, 3);
  assert.equal(roi.timePosition, 4);
});

test('parseImageJRoi rejects PolyLines with fewer than two vertices', () => {
  for (const count of [0, 1]) {
    const buffer = roiHeader({ type: 5, left: 2, top: 4, right: 10, bottom: 10, count });
    assert.throws(
      () => parseImageJRoi(buffer, { name: `polyline-${count}.roi` }),
      /ImageJ ROI PolyLine requires at least two points\./,
    );
  }
});

test('parseImageJRoi preserves multi-vertex PolyLines as open geometry', () => {
  const roi = polygonRoi({
    type: 5,
    name: 'axon-path.roi',
    points: [[2, 4], [7, 4], [7, 10], [12, 10]],
  });

  assert.equal(roi.shape, 'polyline');
  assert.deepEqual(roi.points, [[2, 4], [7, 4], [7, 10], [12, 10]]);
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
  const buffer = roiHeader({ type: 4, left: 3, top: 4, right: 12, bottom: 14 });

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

test('imageJRoiToAnnotation maps a two-vertex PolyLine through calibrated anisotropic line measurement', () => {
  const buffer = roiHeader({ type: 5, left: 2, top: 4, right: 10, bottom: 10, count: 2 });
  buffer.writeInt16BE(0, 64);
  buffer.writeInt16BE(8, 66);
  buffer.writeInt16BE(0, 68);
  buffer.writeInt16BE(6, 70);
  const roi = parseImageJRoi(buffer, { name: 'axon-segment.roi' });
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
  assert.deepEqual([converted.entry.x1, converted.entry.y1, converted.entry.x2, converted.entry.y2], [2, 4, 10, 10]);
  assert.equal(converted.entry.unit, 'mm');
  assert.equal(converted.entry.mm, Math.hypot(8 * 0.0005, 6 * 0.00025));
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

test('imageJRoiToAnnotation maps an open PolyLine into a calibrated ROI length', () => {
  const roi = polygonRoi({
    type: 5,
    name: 'axon-path.roi',
    points: [[2, 4], [6, 4], [6, 7]],
  });
  const converted = imageJRoiToAnnotation(roi, {
    slug: 'cells',
    imageDomain: 'microscopy',
    width: 16,
    height: 16,
    slices: 1,
    pixelSpacing: [0.002, 0.001],
    _spacingKnown: true,
    microscopy: { channelIndex: 0, channelName: 'DAPI', timeIndex: 0 },
  }, 0);

  assert.equal(converted.kind, 'roi');
  assert.equal(converted.entry.shape, 'polyline');
  assert.equal(converted.entry.stats.length_px, 7);
  assert.equal(converted.entry.stats.length_mm, 0.01);
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

test('encodeImageJRoi writes a canonical 64-byte Header2 before every ROI name', () => {
  for (const { label, channel, slice, time } of [
    { label: '', channel: 1, slice: 2, time: 3 },
    { label: 'A', channel: 2, slice: 3, time: 4 },
    { label: 'nucleus curated', channel: 3, slice: 4, time: 5 },
  ]) {
    const bytes = encodeImageJRoi({
      kind: 'point',
      label,
      channelIndex: channel,
      slice,
      timeIndex: time,
      points: [[2, 3]],
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header2Offset = 68;
    const expectedNameOffset = label ? header2Offset + 64 : 0;

    assert.equal(view.getInt32(60, false), header2Offset);
    assert.equal(view.getInt32(header2Offset + 4, false), channel);
    assert.equal(view.getInt32(header2Offset + 8, false), slice);
    assert.equal(view.getInt32(header2Offset + 12, false), time);
    assert.equal(view.getInt32(header2Offset + 16, false), expectedNameOffset);
    assert.equal(view.getInt32(header2Offset + 20, false), label.length);
    assert.equal(bytes.byteLength, header2Offset + 64 + label.length * 2);
    if (label) assert.equal(view.getUint16(expectedNameOffset, false), label.charCodeAt(0));

    const roi = parseImageJRoi(bytes, { name: 'fallback.roi' });
    assert.equal(roi.label, label || 'fallback');
    assert.equal(roi.channelPosition, channel);
    assert.equal(roi.zPosition, slice);
    assert.equal(roi.timePosition, time);
  }
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

test('encodeImageJRoi round-trips open PolyLine geometry', () => {
  const points = [[2, 4], [7, 4], [7, 10], [12, 10]];
  const bytes = encodeImageJRoi({
    kind: 'polyline',
    label: 'axon path',
    slice: 2,
    channelIndex: 1,
    timeIndex: 3,
    points,
  });
  const roi = parseImageJRoi(bytes, { name: 'axon-path.roi' });

  assert.equal(roi.shape, 'polyline');
  assert.equal(roi.label, 'axon path');
  assert.deepEqual(roi.points, points);
  assert.equal(roi.zPosition, 2);
});

test('imageJRoiZip round-trips multiple VoxelLab ROI and measurement rows as uncompressed ROI entries', async () => {
  const zip = imageJRoiZip([
    { kind: 'ellipse', label: 'cell body', slice: 1, channelIndex: 1, timeIndex: 1, points: [[4, 5], [13, 15]] },
    { kind: 'point', label: 'spots', slice: 2, channelIndex: 1, timeIndex: 1, points: [[3, 6], [7, 8]] },
    { kind: 'line', label: 'axon length', slice: 2, channelIndex: 1, timeIndex: 1, points: [[2, 4], [10, 4]] },
    { kind: 'polyline', label: 'axon path', slice: 2, channelIndex: 1, timeIndex: 1, points: [[2, 4], [6, 4], [6, 8]] },
    { kind: 'angle', label: 'branch angle', slice: 3, channelIndex: 2, timeIndex: 1, points: [[6, 4], [2, 4], [6, 8]] },
  ]);
  const rois = await parseImageJRoiZip(zip);

  assert.equal(rois.length, 5);
  assert.deepEqual(rois.map(roi => roi.shape), ['ellipse', 'point', 'line', 'polyline', 'angle']);
  assert.deepEqual(rois.map(roi => roi.label), ['cell body', 'spots', 'axon length', 'axon path', 'branch angle']);
  assert.deepEqual(rois[0].points, [[4, 5], [13, 15]]);
  assert.deepEqual(rois[1].points, [[3, 6], [7, 8]]);
  assert.deepEqual(rois[2].points, [[2, 4], [10, 4]]);
  assert.deepEqual(rois[3].points, [[2, 4], [6, 4], [6, 8]]);
  assert.deepEqual(rois[4].points, [[6, 4], [2, 4], [6, 8]]);
  assert.deepEqual(rois.map(roi => roi.zPosition), [1, 2, 2, 2, 3]);
  assert.equal(rois[4].channelPosition, 2);
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

test('parseImageJRoiZip bounds native inflation by the declared decoded size', async () => {
  assert.equal(typeof globalThis.DecompressionStream, 'function');
  const payload = encodeImageJRoi({
    kind: 'line',
    label: 'forged native stream',
    points: [[2, 4], [10, 4]],
  });
  const forged = withDeclaredUncompressedSize(compressedZipEntry('forged-native.roi', payload), 1);

  await assert.rejects(
    () => parseImageJRoiZip(forged),
    /ImageJ ROI ZIP resource limit: inflated entry exceeds its declared decoded size of 1 byte\./,
  );
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

test('parseImageJRoiZipEntries skips checksum-mismatched stored and deflated ROIs while importing valid entries', async () => {
  const valid = encodeImageJRoi({
    kind: 'line', label: 'valid', points: [[2, 4], [10, 4]],
  });
  const invalidStored = encodeImageJRoi({
    kind: 'point', label: 'bad stored', points: [[3, 6]],
  });
  const invalidDeflated = encodeImageJRoi({
    kind: 'polygon', label: 'bad deflated', points: [[2, 3], [12, 4], [8, 11]],
  });
  const result = await parseImageJRoiZipEntries(zipArchive([
    storedLocalZipEntry('bad-stored.roi', invalidStored, { crc: 0 }),
    storedLocalZipEntry('valid.roi', valid),
    compressedLocalZipEntry('bad-deflated.roi', invalidDeflated, { crc: 0 }),
  ]), { inflateRaw: bytes => inflateRawSync(bytes) });

  assert.deepEqual(result.rois.map(roi => roi.name), ['valid']);
  assert.deepEqual(result.skipped, [
    { name: 'bad-stored.roi', reason: 'checksum_mismatch' },
    { name: 'bad-deflated.roi', reason: 'checksum_mismatch' },
  ]);
});

test('parseImageJRoiZipEntries rejects data descriptors whose checksum or sizes differ from central metadata', async () => {
  const payload = encodeImageJRoi({
    kind: 'line', label: 'streamed axon', points: [[2, 4], [10, 4]],
  });
  const malformed = compressedZipEntry('streamed.roi', payload, { dataDescriptor: true });
  const descriptorOffset = 30 + malformed.readUInt16LE(26) + deflateRawSync(payload).length;
  malformed.writeUInt32LE(0, descriptorOffset + 4);

  await assert.rejects(
    () => parseImageJRoiZipEntries(malformed, { inflateRaw: bytes => inflateRawSync(bytes) }),
    /ImageJ ROI ZIP is malformed: data descriptor does not match central-directory metadata\./,
  );
});

test('parseImageJRoiZipEntries skips encrypted ROIs and continues with valid entries', async () => {
  const encrypted = encodeImageJRoi({ kind: 'point', label: 'private', points: [[3, 6]] });
  const valid = encodeImageJRoi({ kind: 'line', label: 'valid', points: [[2, 4], [10, 4]] });
  const result = await parseImageJRoiZipEntries(zipArchive([
    storedLocalZipEntry('encrypted.roi', encrypted, { flags: 0x01 }),
    storedLocalZipEntry('valid.roi', valid),
  ]));

  assert.deepEqual(result.rois.map(roi => roi.name), ['valid']);
  assert.deepEqual(result.skipped, [{ name: 'encrypted.roi', reason: 'unsupported_encryption' }]);
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
  const unsupported = roiHeader({ type: 6, left: 3, top: 4, right: 12, bottom: 14, count: 3 });
  const result = await parseImageJRoiZipEntries(zipArchive([
    storedLocalZipEntry('spots.roi', supported),
    storedLocalZipEntry('unsupported.roi', unsupported),
  ]));

  assert.equal(result.rois.length, 1);
  assert.equal(result.rois[0].name, 'spots');
  assert.equal(result.rois[0].shape, 'point');
  assert.deepEqual(result.skipped, [{ name: 'unsupported.roi', reason: 'Unsupported ImageJ ROI type.' }]);
});

test('parseImageJRoiZipEntries imports two-vertex and open multi-vertex PolyLines', async () => {
  const supported = roiHeader({ type: 5, left: 2, top: 4, right: 10, bottom: 10, count: 2 });
  supported.writeInt16BE(0, 64);
  supported.writeInt16BE(8, 66);
  supported.writeInt16BE(0, 68);
  supported.writeInt16BE(6, 70);
  const open = roiHeader({ type: 5, left: 2, top: 4, right: 10, bottom: 10, count: 3 });
  open.writeInt16BE(0, 64);
  open.writeInt16BE(4, 66);
  open.writeInt16BE(8, 68);
  open.writeInt16BE(0, 70);
  open.writeInt16BE(6, 72);
  open.writeInt16BE(6, 74);
  const result = await parseImageJRoiZipEntries(zipArchive([
    storedLocalZipEntry('supported-polyline.roi', supported),
    storedLocalZipEntry('open-polyline.roi', open),
  ]));

  assert.equal(result.rois.length, 2);
  assert.equal(result.rois[0].shape, 'line');
  assert.deepEqual(result.rois[0].points, [[2, 4], [10, 10]]);
  assert.equal(result.rois[1].shape, 'polyline');
  assert.deepEqual(result.rois[1].points, [[2, 4], [6, 10], [10, 10]]);
  assert.deepEqual(result.skipped, []);
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
    () => parseImageJRoiZipEntries(zipArchive([storedLocalZipEntry('unsupported.roi', unsupported)])),
    /no supported \.roi entries/,
  );
});

test('parseImageJRoiZipEntries enforces the ROI ZIP entry-count budget', async () => {
  const entries = Array.from({ length: 1_025 }, (_, index) => storedLocalZipEntry(`entry-${index}.txt`, Buffer.alloc(0)));

  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive(entries)),
    /ImageJ ROI ZIP resource limit: entry count exceeds the 1024 entry budget\./,
  );
});

test('parseImageJRoiZipEntries enforces per-entry byte budgets before decompression', async () => {
  const tooLargeEncoded = localZipEntryWithSizes('encoded.roi', {
    compressedSize: 8 * 1024 * 1024 + 1,
    uncompressedSize: 8 * 1024 * 1024 + 1,
  });
  const tooLargeDecoded = localZipEntryWithSizes('decoded.roi', {
    method: 8,
    compressedSize: 1,
    uncompressedSize: 8 * 1024 * 1024 + 1,
    payload: Buffer.from([0]),
  });

  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive([tooLargeEncoded])),
    /ImageJ ROI ZIP resource limit: encoded entry exceeds the 8388608 byte budget\./,
  );
  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive([tooLargeDecoded]), { inflateRaw: () => assert.fail('inflation must not run') }),
    /ImageJ ROI ZIP resource limit: decoded entry exceeds the 8388608 byte budget\./,
  );
});

test('parseImageJRoiZipEntries rejects injected inflated bytes beyond a forged declared size', async () => {
  const forged = localZipEntryWithSizes('forged-bytes.roi', {
    method: 8,
    compressedSize: 1,
    uncompressedSize: 1,
    payload: Buffer.from([0]),
  });

  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive([forged]), { inflateRaw: () => Uint8Array.from([1, 2]) }),
    /ImageJ ROI ZIP resource limit: inflated entry exceeds its declared decoded size of 1 byte\./,
  );
});

test('parseImageJRoiZipEntries cancels injected inflated streams beyond a forged declared size', async () => {
  const forged = localZipEntryWithSizes('forged-stream.roi', {
    method: 8,
    compressedSize: 1,
    uncompressedSize: 1,
    payload: Buffer.from([0]),
  });
  let canceled = false;

  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive([forged]), {
      inflateRaw: () => new ReadableStream({
        pull(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          canceled = true;
        },
      }),
    }),
    /ImageJ ROI ZIP resource limit: inflated entry exceeds its declared decoded size of 1 byte\./,
  );
  assert.equal(canceled, true);
});

test('parseImageJRoiZipEntries enforces cumulative decoded bytes before the next inflation', async () => {
  const entries = Array.from({ length: 9 }, (_, index) => localZipEntryWithSizes(`entry-${index}.roi`, {
    method: 8,
    compressedSize: 1,
    uncompressedSize: 8 * 1024 * 1024,
    payload: Buffer.from([0]),
  }));
  let inflateCalls = 0;

  await assert.rejects(
    () => parseImageJRoiZipEntries(zipArchive(entries), {
      inflateRaw: () => {
        inflateCalls += 1;
        return new Uint8Array(0);
      },
    }),
    /ImageJ ROI ZIP resource limit: cumulative decoded entries exceed the 67108864 byte budget\./,
  );
  assert.equal(inflateCalls, 0);
});
