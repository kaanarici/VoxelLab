import { deflateSync } from 'node:zlib';

function writeEntry(buffer, offset, tag, type, count, value) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(type, offset + 2);
  buffer.writeUInt32LE(count, offset + 4);
  if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
  else buffer.writeUInt32LE(value, offset + 8);
}

function writeRational(buffer, offset, value) {
  const denominator = 1_000_000;
  buffer.writeUInt32LE(Math.round(Number(value) * denominator), offset);
  buffer.writeUInt32LE(denominator, offset + 4);
}

export function onePixelPages(count) {
  return Array.from({ length: count }, (_, index) => ({
    width: 1,
    height: 1,
    pixels: new Float32Array([index]),
    photometric: 1,
  }));
}

export function tinyTiff({
  width = 2,
  height = 1,
  pixels = [0, 255],
  description = '',
  bitsPerSample = 8,
  compression = 1,
  samplesPerPixel = 1,
  sampleFormat = 1,
  photometric = 1,
  predictor = 1,
  xResolution = 0,
  yResolution = 0,
} = {}) {
  const pixelBytes = Buffer.alloc(pixels.length * (bitsPerSample / 8));
  for (let i = 0; i < pixels.length; i += 1) {
    const value = Number(pixels[i]);
    if (bitsPerSample === 8) {
      if (sampleFormat === 2) pixelBytes.writeInt8(value, i);
      else pixelBytes.writeUInt8(value & 0xff, i);
    } else if (bitsPerSample === 16) {
      if (sampleFormat === 2) pixelBytes.writeInt16LE(value, i * 2);
      else pixelBytes.writeUInt16LE(value, i * 2);
    } else if (sampleFormat === 3) pixelBytes.writeFloatLE(value, i * 4);
    else if (sampleFormat === 2) pixelBytes.writeInt32LE(value, i * 4);
    else pixelBytes.writeUInt32LE(value, i * 4);
  }
  if (predictor === 2) {
    for (let i = width - 1; i >= 1; i -= 1) {
      const offset = i * (bitsPerSample / 8);
      const previousOffset = offset - (bitsPerSample / 8);
      if (bitsPerSample === 8) pixelBytes[offset] = (pixelBytes[offset] - pixelBytes[previousOffset]) & 0xff;
      else if (bitsPerSample === 16) pixelBytes.writeUInt16LE(
        (pixelBytes.readUInt16LE(offset) - pixelBytes.readUInt16LE(previousOffset)) & 0xffff,
        offset,
      );
      else pixelBytes.writeUInt32LE(
        (pixelBytes.readUInt32LE(offset) - pixelBytes.readUInt32LE(previousOffset)) >>> 0,
        offset,
      );
    }
  }
  const storedPixels = compression === 8 || compression === 32946 ? deflateSync(pixelBytes) : pixelBytes;
  const descriptionBytes = description ? Buffer.from(`${description}\0`, 'utf8') : null;
  const hasResolution = xResolution > 0 || yResolution > 0;
  const entries = 10 + (descriptionBytes ? 1 : 0) + (hasResolution ? 3 : 0) + (predictor !== 1 ? 1 : 0);
  const ifdOffset = 8;
  const descriptionOffset = ifdOffset + 2 + entries * 12 + 4;
  const rationalOffset = descriptionOffset + (descriptionBytes?.length || 0);
  const xResolutionOffset = rationalOffset;
  const yResolutionOffset = rationalOffset + 8;
  const pixelOffset = hasResolution ? rationalOffset + 16 : rationalOffset;
  const buffer = Buffer.alloc(pixelOffset + storedPixels.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  for (const entry of [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, bitsPerSample],
    [259, 3, 1, compression],
    [262, 3, 1, photometric],
    ...(descriptionBytes ? [[270, 2, descriptionBytes.length, descriptionOffset]] : []),
    [273, 4, 1, pixelOffset],
    [277, 3, 1, samplesPerPixel],
    [278, 4, 1, height],
    [279, 4, 1, storedPixels.length],
    ...(hasResolution ? [
      [282, 5, 1, xResolutionOffset],
      [283, 5, 1, yResolutionOffset],
      [296, 3, 1, 1],
    ] : []),
    [339, 3, 1, sampleFormat],
    ...(predictor !== 1 ? [[317, 3, 1, predictor]] : []),
  ]) {
    writeEntry(buffer, cursor, ...entry);
    cursor += 12;
  }
  buffer.writeUInt32LE(0, cursor);
  if (descriptionBytes) descriptionBytes.copy(buffer, descriptionOffset);
  if (hasResolution) {
    writeRational(buffer, xResolutionOffset, xResolution || yResolution);
    writeRational(buffer, yResolutionOffset, yResolution || xResolution);
  }
  storedPixels.copy(buffer, pixelOffset);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export function tiffFileLike(name, buffer) {
  return {
    name,
    async arrayBuffer() {
      return buffer;
    },
  };
}
