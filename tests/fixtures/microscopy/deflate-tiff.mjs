import { deflateSync } from 'node:zlib';

function writeUInt16(buffer, value, offset, littleEndian) {
  if (littleEndian) buffer.writeUInt16LE(value, offset);
  else buffer.writeUInt16BE(value, offset);
}

function writeUInt32(buffer, value, offset, littleEndian) {
  if (littleEndian) buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

function writePixel(buffer, value, offset, bits, littleEndian) {
  if (bits === 8) buffer.writeUInt8(value & 0xff, offset);
  else if (littleEndian) buffer.writeUInt16LE(value & 0xffff, offset);
  else buffer.writeUInt16BE(value & 0xffff, offset);
}

function predictedStrip(raw, width, rows, bits, littleEndian) {
  const bytesPerSample = bits / 8;
  const output = Buffer.from(raw);
  for (let row = 0; row < rows; row++) {
    for (let column = width - 1; column > 0; column--) {
      const offset = (row * width + column) * bytesPerSample;
      const previousOffset = offset - bytesPerSample;
      if (bits === 8) output[offset] = (output[offset] - output[previousOffset]) & 0xff;
      else {
        const value = littleEndian ? output.readUInt16LE(offset) : output.readUInt16BE(offset);
        const previous = littleEndian ? output.readUInt16LE(previousOffset) : output.readUInt16BE(previousOffset);
        writePixel(output, value - previous, offset, bits, littleEndian);
      }
    }
  }
  return output;
}

/** Synthetic classic stripped TIFF bytes, independently compressed with Node zlib. */
export function createDeflateTiff({
  width,
  height = 1,
  pixels = [0],
  bits = 8,
  littleEndian = true,
  compression = 8,
  predictor = 1,
  sampleFormat = 1,
  rowsPerStrip = height,
  description = '',
  xResolution = 0,
  yResolution = 0,
  predictedBytes = null,
} = {}) {
  const byteOrder = littleEndian ? 'II' : 'MM';
  const bytesPerSample = bits / 8;
  const safeWidth = width ?? pixels.length / height;
  const raw = Buffer.alloc(pixels.length * bytesPerSample);
  pixels.forEach((value, index) => writePixel(raw, Number(value), index * bytesPerSample, bits, littleEndian));
  const stripCount = Math.ceil(height / rowsPerStrip);
  const fixedPredictedBytes = predictedBytes == null ? null : Buffer.from(predictedBytes);
  if (fixedPredictedBytes && stripCount !== 1) throw new Error('predictedBytes fixtures require a single strip.');
  const compressedStrips = Array.from({ length: stripCount }, (_, stripIndex) => {
    const rowStart = stripIndex * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - rowStart);
    const strip = raw.subarray(rowStart * safeWidth * bytesPerSample, (rowStart + rows) * safeWidth * bytesPerSample);
    const bytes = fixedPredictedBytes || (predictor === 2 ? predictedStrip(strip, safeWidth, rows, bits, littleEndian) : strip);
    return deflateSync(bytes);
  });
  const descriptionBytes = description ? Buffer.from(`${description}\0`, 'utf8') : null;
  const hasResolution = xResolution > 0 || yResolution > 0;
  const entries = 11 + (descriptionBytes ? 1 : 0) + (hasResolution ? 3 : 0);
  const ifdOffset = 8;
  let cursor = ifdOffset + 2 + entries * 12 + 4;
  const descriptionOffset = descriptionBytes ? cursor : 0;
  cursor += descriptionBytes?.length || 0;
  const stripOffsetsOffset = stripCount > 1 ? cursor : 0;
  cursor += stripCount > 1 ? stripCount * 4 : 0;
  const stripCountsOffset = stripCount > 1 ? cursor : 0;
  cursor += stripCount > 1 ? stripCount * 4 : 0;
  const xResolutionOffset = hasResolution ? cursor : 0;
  cursor += hasResolution ? 8 : 0;
  const yResolutionOffset = hasResolution ? cursor : 0;
  cursor += hasResolution ? 8 : 0;
  const stripOffsets = [];
  for (const strip of compressedStrips) {
    stripOffsets.push(cursor);
    cursor += strip.length;
  }
  const buffer = Buffer.alloc(cursor);
  buffer.write(byteOrder, 0, 'ascii');
  writeUInt16(buffer, 42, 2, littleEndian);
  writeUInt32(buffer, ifdOffset, 4, littleEndian);
  writeUInt16(buffer, entries, ifdOffset, littleEndian);
  let entryCursor = ifdOffset + 2;
  const entry = (tag, type, count, value) => {
    writeUInt16(buffer, tag, entryCursor, littleEndian);
    writeUInt16(buffer, type, entryCursor + 2, littleEndian);
    writeUInt32(buffer, count, entryCursor + 4, littleEndian);
    if (type === 3 && count === 1) writeUInt16(buffer, value, entryCursor + 8, littleEndian);
    else writeUInt32(buffer, value, entryCursor + 8, littleEndian);
    entryCursor += 12;
  };
  entry(256, 4, 1, safeWidth);
  entry(257, 4, 1, height);
  entry(258, 3, 1, bits);
  entry(259, 3, 1, compression);
  entry(262, 3, 1, 1);
  if (descriptionBytes) entry(270, 2, descriptionBytes.length, descriptionOffset);
  entry(273, 4, stripCount, stripCount === 1 ? stripOffsets[0] : stripOffsetsOffset);
  entry(277, 3, 1, 1);
  entry(278, 4, 1, rowsPerStrip);
  entry(279, 4, stripCount, stripCount === 1 ? compressedStrips[0].length : stripCountsOffset);
  entry(317, 3, 1, predictor);
  if (hasResolution) {
    entry(282, 5, 1, xResolutionOffset);
    entry(283, 5, 1, yResolutionOffset);
    entry(296, 3, 1, 1);
  }
  entry(339, 3, 1, sampleFormat);
  writeUInt32(buffer, 0, entryCursor, littleEndian);
  if (descriptionBytes) descriptionBytes.copy(buffer, descriptionOffset);
  stripOffsets.forEach((offset, index) => {
    if (stripCount > 1) writeUInt32(buffer, offset, stripOffsetsOffset + index * 4, littleEndian);
    if (stripCount > 1) writeUInt32(buffer, compressedStrips[index].length, stripCountsOffset + index * 4, littleEndian);
  });
  if (hasResolution) {
    writeUInt32(buffer, Math.round(xResolution * 1_000_000), xResolutionOffset, littleEndian);
    writeUInt32(buffer, 1_000_000, xResolutionOffset + 4, littleEndian);
    writeUInt32(buffer, Math.round(yResolution * 1_000_000), yResolutionOffset, littleEndian);
    writeUInt32(buffer, 1_000_000, yResolutionOffset + 4, littleEndian);
  }
  compressedStrips.forEach((strip, index) => strip.copy(buffer, stripOffsets[index]));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
