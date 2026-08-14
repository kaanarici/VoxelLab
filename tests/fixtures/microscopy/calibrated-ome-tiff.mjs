/* global Buffer */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CALIBRATED_OME_TIFF = {
  width: 16,
  height: 16,
  physicalSizeXUm: 0.5,
  physicalSizeYUm: 0.25,
  physicalSizeZUm: 1.5,
  physicalUnit: 'µm',
  pixelSpacingMm: [0.00025, 0.0005],
  sliceThicknessMm: 0.0015,
  pixelAreaUm2: 0.125,
};

function writeEntry(buffer, offset, tag, type, count, value) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(type, offset + 2);
  buffer.writeUInt32LE(count, offset + 4);
  if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
  else buffer.writeUInt32LE(value, offset + 8);
}

function arrayBufferFor(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function defaultPixels(width, height) {
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = Math.min(255, x * 8 + y * 6);
  }
  return pixels;
}

function pixelBufferFor(pixels) {
  if (Buffer.isBuffer(pixels)) return pixels;
  if (pixels instanceof Uint8Array) return Buffer.from(pixels);
  return Buffer.from(Array.from(pixels, value => Number(value) & 0xff));
}

function channelXml(channels = [{ name: 'DAPI' }]) {
  return channels.map((channel, index) => {
    const attrs = [
      `ID="Channel:0:${index}"`,
      `Name="${channel.name || `Channel ${index + 1}`}"`,
      channel.color == null ? '' : `Color="${channel.color}"`,
      channel.emissionWavelength == null ? '' : `EmissionWavelength="${channel.emissionWavelength}"`,
      channel.emissionWavelengthUnit == null ? '' : `EmissionWavelengthUnit="${channel.emissionWavelengthUnit}"`,
    ].filter(Boolean).join(' ');
    return `<Channel ${attrs}/>`;
  }).join('');
}

function omeDescription({
  width,
  height,
  physicalSizeXUm,
  physicalSizeYUm,
  physicalSizeZUm,
  physicalUnit,
  sizeZ = 1,
  sizeC = 1,
  sizeT = 1,
  dimensionOrder = 'XYZCT',
  tiffData = '',
  channels,
}) {
  return `<OME><Image ID="Image:0"><Pixels DimensionOrder="${dimensionOrder}" SizeX="${width}" SizeY="${height}" SizeZ="${sizeZ}" SizeC="${sizeC}" SizeT="${sizeT}" PhysicalSizeX="${physicalSizeXUm}" PhysicalSizeY="${physicalSizeYUm}" PhysicalSizeZ="${physicalSizeZUm}" PhysicalSizeXUnit="${physicalUnit}" PhysicalSizeYUnit="${physicalUnit}" PhysicalSizeZUnit="${physicalUnit}">${channelXml(channels)}${tiffData}</Pixels></Image></OME>`;
}

function createCalibratedOmeTiffBuffer({
  width = CALIBRATED_OME_TIFF.width,
  height = CALIBRATED_OME_TIFF.height,
  pixels = defaultPixels(width, height),
  sampleFormat = 1,
  physicalSizeXUm = CALIBRATED_OME_TIFF.physicalSizeXUm,
  physicalSizeYUm = CALIBRATED_OME_TIFF.physicalSizeYUm,
  physicalSizeZUm = CALIBRATED_OME_TIFF.physicalSizeZUm,
  physicalUnit = CALIBRATED_OME_TIFF.physicalUnit,
} = {}) {
  const pixelBytes = pixelBufferFor(pixels);
  const descriptionBytes = Buffer.from(`${omeDescription({
    width,
    height,
    physicalSizeXUm,
    physicalSizeYUm,
    physicalSizeZUm,
    physicalUnit,
  })}\0`, 'utf8');
  const entries = 11;
  const ifdOffset = 8;
  const descriptionOffset = ifdOffset + 2 + entries * 12 + 4;
  const pixelOffset = descriptionOffset + descriptionBytes.length;
  const buffer = Buffer.alloc(pixelOffset + pixelBytes.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  for (const entry of [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [270, 2, descriptionBytes.length, descriptionOffset],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixelBytes.length],
    [339, 3, 1, sampleFormat],
  ]) {
    writeEntry(buffer, cursor, ...entry);
    cursor += 12;
  }
  buffer.writeUInt32LE(0, cursor);
  descriptionBytes.copy(buffer, descriptionOffset);
  pixelBytes.copy(buffer, pixelOffset);
  return buffer;
}

function defaultTimeSeriesPixels(width, height) {
  const first = Buffer.alloc(width * height);
  const second = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.min(255, x * 8 + y * 6);
      const offset = y * width + x;
      first[offset] = value;
      second[offset] = 255 - value;
    }
  }
  return [first, second];
}

function defaultChannelTimePixels(width, height) {
  return Array.from({ length: 4 }, (_, pageIndex) => {
    const channel = pageIndex % 2;
    const time = Math.floor(pageIndex / 2);
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels[y * width + x] = Math.min(255, 34 + channel * 92 + time * 46 + x * 5 + y * 3);
      }
    }
    return pixels;
  });
}

function writeImageFileDirectory(buffer, {
  offset,
  nextOffset,
  width,
  height,
  pixelOffset,
  pixelByteLength,
  descriptionOffset = 0,
  descriptionByteLength = 0,
  sampleFormat = 1,
}) {
  const entries = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    ...(descriptionByteLength ? [[270, 2, descriptionByteLength, descriptionOffset]] : []),
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixelByteLength],
    [339, 3, 1, sampleFormat],
  ];
  buffer.writeUInt16LE(entries.length, offset);
  let cursor = offset + 2;
  for (const entry of entries) {
    writeEntry(buffer, cursor, ...entry);
    cursor += 12;
  }
  buffer.writeUInt32LE(nextOffset, cursor);
}

function createMultiPageOmeTiffBuffer({
  width = CALIBRATED_OME_TIFF.width,
  height = CALIBRATED_OME_TIFF.height,
  pagePixels,
  sampleFormat = 1,
  physicalSizeXUm = CALIBRATED_OME_TIFF.physicalSizeXUm,
  physicalSizeYUm = CALIBRATED_OME_TIFF.physicalSizeYUm,
  physicalSizeZUm = CALIBRATED_OME_TIFF.physicalSizeZUm,
  physicalUnit = CALIBRATED_OME_TIFF.physicalUnit,
  sizeZ = 1,
  sizeC = 1,
  sizeT = Array.isArray(pagePixels) ? pagePixels.length : 1,
  dimensionOrder = 'XYZCT',
  tiffData = '',
  channels,
} = {}) {
  const pixelPages = pagePixels.map(pixelBufferFor);
  assert.ok(pixelPages.length > 1, 'multi-page OME-TIFF fixture needs at least two pages');
  for (const pixels of pixelPages) assert.equal(pixels.byteLength, width * height);
  const descriptionBytes = Buffer.from(`${omeDescription({
    width,
    height,
    physicalSizeXUm,
    physicalSizeYUm,
    physicalSizeZUm,
    physicalUnit,
    sizeZ,
    sizeC,
    sizeT,
    dimensionOrder,
    tiffData,
    channels,
  })}\0`, 'utf8');

  const ifdOffsets = [];
  let cursor = 8;
  for (let index = 0; index < pixelPages.length; index += 1) {
    ifdOffsets.push(cursor);
    const entryCount = index === 0 ? 11 : 10;
    cursor += 2 + entryCount * 12 + 4;
  }
  const descriptionOffset = cursor;
  cursor += descriptionBytes.length;
  const pixelOffsets = [];
  for (const pixels of pixelPages) {
    pixelOffsets.push(cursor);
    cursor += pixels.byteLength;
  }

  const buffer = Buffer.alloc(cursor);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffsets[0], 4);
  for (let index = 0; index < pixelPages.length; index += 1) {
    writeImageFileDirectory(buffer, {
      offset: ifdOffsets[index],
      nextOffset: ifdOffsets[index + 1] || 0,
      width,
      height,
      pixelOffset: pixelOffsets[index],
      pixelByteLength: pixelPages[index].byteLength,
      descriptionOffset: index === 0 ? descriptionOffset : 0,
      descriptionByteLength: index === 0 ? descriptionBytes.length : 0,
      sampleFormat,
    });
  }
  descriptionBytes.copy(buffer, descriptionOffset);
  pixelPages.forEach((pixels, index) => pixels.copy(buffer, pixelOffsets[index]));
  return buffer;
}

function createCalibratedTimeSeriesOmeTiffBuffer(options = {}) {
  const width = options.width ?? CALIBRATED_OME_TIFF.width;
  const height = options.height ?? CALIBRATED_OME_TIFF.height;
  const pagePixels = options.pagePixels || defaultTimeSeriesPixels(width, height);
  const tiffData = options.tiffData
    ?? `<TiffData FirstT="0" FirstZ="0" FirstC="0" IFD="0" PlaneCount="${pagePixels.length}"/>`;
  return createMultiPageOmeTiffBuffer({
    ...options,
    width,
    height,
    pagePixels,
    sizeT: pagePixels.length,
    tiffData,
  });
}

function createCalibratedChannelTimeOmeTiffBuffer(options = {}) {
  const width = options.width ?? CALIBRATED_OME_TIFF.width;
  const height = options.height ?? CALIBRATED_OME_TIFF.height;
  const pagePixels = options.pagePixels || defaultChannelTimePixels(width, height);
  const tiffData = [
    '<TiffData IFD="0" FirstZ="0" FirstC="0" FirstT="0"/>',
    '<TiffData IFD="1" FirstZ="0" FirstC="1" FirstT="0"/>',
    '<TiffData IFD="2" FirstZ="0" FirstC="0" FirstT="1"/>',
    '<TiffData IFD="3" FirstZ="0" FirstC="1" FirstT="1"/>',
  ].join('');
  return createMultiPageOmeTiffBuffer({
    ...options,
    width,
    height,
    pagePixels,
    sizeC: 2,
    sizeT: 2,
    tiffData,
    channels: options.channels || [
      { name: 'DAPI', color: '65535', emissionWavelength: 460, emissionWavelengthUnit: 'nm' },
      { name: 'GFP', color: '16711935', emissionWavelength: 510, emissionWavelengthUnit: 'nm' },
    ],
  });
}

export function calibratedOmeFileLike(name = 'cells.ome.tiff', options = {}) {
  const buffer = createCalibratedOmeTiffBuffer(options);
  return {
    name,
    async arrayBuffer() {
      return arrayBufferFor(buffer);
    },
  };
}

export function calibratedTimeSeriesOmeFileLike(name = 'cells-time.ome.tiff', options = {}) {
  const buffer = createCalibratedTimeSeriesOmeTiffBuffer(options);
  return {
    name,
    async arrayBuffer() {
      return arrayBufferFor(buffer);
    },
  };
}

export function calibratedChannelTimeOmeFileLike(name = 'cells-channel-time.ome.tiff', options = {}) {
  const buffer = createCalibratedChannelTimeOmeTiffBuffer(options);
  return {
    name,
    async arrayBuffer() {
      return arrayBufferFor(buffer);
    },
  };
}

export async function writeCalibratedOmeTiff(path, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createCalibratedOmeTiffBuffer(options));
}

export async function writeCalibratedTimeSeriesOmeTiff(path, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createCalibratedTimeSeriesOmeTiffBuffer(options));
}

export async function writeCalibratedChannelTimeOmeTiff(path, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createCalibratedChannelTimeOmeTiffBuffer(options));
}

export function installMicroscopyCanvasStub() {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData() {},
          };
        },
      };
    },
  };
  return () => { globalThis.document = previousDocument; };
}
