import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function uint16LeChunk(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
  return buffer;
}

export function sequencePlane(width, height, base) {
  return Array.from({ length: width * height }, (_, index) => (base + index) % 256);
}

function writeIfdEntries(buffer, startCursor, entries) {
  let cursor = startCursor;
  for (const [tag, type, count, value] of entries) {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(count, cursor + 4);
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, cursor + 8);
    else buffer.writeUInt32LE(value, cursor + 8);
    cursor += 12;
  }
  return cursor;
}

function classicPlaneEntries(width, height, pixelOffset, pixelByteCount) {
  return [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixelByteCount],
    [339, 3, 1, 1],
  ];
}

export async function writeTinySequenceTiff(path, pixels, options = {}) {
  const width = options.width || pixels.length;
  const height = options.height || 1;
  if (pixels.length !== width * height) {
    throw new Error(`sequence TIFF pixel count ${pixels.length} does not match ${width}x${height}`);
  }
  const ifdOffset = 8;
  const pixelOffset = ifdOffset + 2 + 10 * 12 + 4;
  const buffer = Buffer.alloc(pixelOffset + pixels.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(10, ifdOffset);
  const nextIfdCursor = writeIfdEntries(
    buffer,
    ifdOffset + 2,
    classicPlaneEntries(width, height, pixelOffset, pixels.length),
  );
  buffer.writeUInt32LE(0, nextIfdCursor);
  Buffer.from(pixels).copy(buffer, pixelOffset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

export function contrastingHyperstackPlaneValue(pageIndex, index) {
  return pageIndex < 2
    ? 20 + pageIndex * 55 + index
    : 230 - (pageIndex - 2) * 35 - index * 2;
}

function gradientHyperstackPlaneValue(pageIndex, index) {
  return 20 + pageIndex * 45 + index;
}

export async function writeFourPageHyperstackTiff(path, description, options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 3;
  const planeValue = options.planeValue ?? gradientHyperstackPlaneValue;
  const pageCount = 4;
  const descriptionBytes = Buffer.from(`${description}\0`, 'utf8');
  const ifdEntryCounts = [11, 10, 10, 10];
  const ifdOffsets = [];
  let cursor = 8;
  for (const entryCount of ifdEntryCounts) {
    ifdOffsets.push(cursor);
    cursor += 2 + entryCount * 12 + 4;
  }
  const descriptionOffset = cursor;
  cursor += descriptionBytes.length;
  const pixelOffsets = [];
  const pixelsByPage = Array.from({ length: pageCount }, (_, pageIndex) => {
    const pixels = Buffer.alloc(width * height);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = planeValue(pageIndex, i);
    pixelOffsets.push(cursor);
    cursor += pixels.length;
    return pixels;
  });
  const buffer = Buffer.alloc(cursor);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffsets[0], 4);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const entries = classicPlaneEntries(width, height, pixelOffsets[pageIndex], width * height);
    if (pageIndex === 0) entries.splice(5, 0, [270, 2, descriptionBytes.length, descriptionOffset]);
    buffer.writeUInt16LE(entries.length, ifdOffsets[pageIndex]);
    const nextIfdCursor = writeIfdEntries(buffer, ifdOffsets[pageIndex] + 2, entries);
    buffer.writeUInt32LE(ifdOffsets[pageIndex + 1] || 0, nextIfdCursor);
    pixelsByPage[pageIndex].copy(buffer, pixelOffsets[pageIndex]);
  }
  descriptionBytes.copy(buffer, descriptionOffset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

export const HYPERSTACK_OME_DESCRIPTION = '<OME><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="4" SizeY="3" SizeZ="2" SizeC="2" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.25" PhysicalSizeZ="1.5" PhysicalSizeXUnit="µm"><Channel ID="Channel:0:0" Name="DAPI" Color="65535" EmissionWavelength="460" EmissionWavelengthUnit="nm"/><Channel ID="Channel:0:1" Name="GFP" Color="16711935" EmissionWavelength="510" EmissionWavelengthUnit="nm"/></Pixels></Image></OME>';

export const HYPERSTACK_IMAGEJ_DESCRIPTION = [
  'ImageJ=1.54',
  'images=4',
  'channels=2',
  'slices=2',
  'frames=1',
  'hyperstack=true',
  'mode=grayscale',
  'unit=um',
  'pixel_width=0.5',
  'pixel_height=0.25',
  'spacing=1.5',
].join('\n');

export async function writeHyperstackOmeTiff(path, options = {}) {
  await writeFourPageHyperstackTiff(path, HYPERSTACK_OME_DESCRIPTION, options);
}

export async function writeHyperstackImageJTiff(path, options = {}) {
  await writeFourPageHyperstackTiff(path, HYPERSTACK_IMAGEJ_DESCRIPTION, options);
}
