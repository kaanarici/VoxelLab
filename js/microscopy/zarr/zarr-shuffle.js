function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('Shuffle input must be byte-addressable.');
}

export function byteUnshuffle(buf, typesize) {
  const src = asUint8Array(buf);
  const size = Number(typesize);
  if (!Number.isInteger(size) || size <= 0) throw new Error('Invalid byte-shuffle typesize.');
  if (size === 1 || src.byteLength === 0) return new Uint8Array(src);
  if (src.byteLength % size !== 0) throw new Error('Invalid byte-shuffle buffer length.');

  const count = src.byteLength / size;
  const dest = new Uint8Array(src.byteLength);
  for (let byte = 0; byte < size; byte += 1) {
    const laneOffset = byte * count;
    for (let i = 0; i < count; i += 1) {
      dest[(i * size) + byte] = src[laneOffset + i];
    }
  }
  return dest;
}

export function bitUnshuffle(_buf, _typesize) {
  const error = new Error('Blosc bitshuffle is unsupported.');
  error.unsupportedReason = 'Blosc shuffle=2';
  throw error;
}
