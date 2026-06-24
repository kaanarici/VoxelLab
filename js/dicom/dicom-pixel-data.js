function getInt(meta, key, fallback = 0) {
  const v = meta?.[key];
  if (v == null) return fallback;
  const parsed = Array.isArray(v) ? parseInt(v[0], 10) : parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getStr(meta, key, fallback = '') {
  const v = meta?.[key];
  if (v == null) return fallback;
  if (Array.isArray(v)) return String(v[0] || fallback);
  return String(v || fallback);
}

function decodeBase64Bytes(value) {
  const text = String(value || '');
  if (!text) return new Uint8Array(0);
  const binary = globalThis.atob ? globalThis.atob(text) : '';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const MONOCHROME_PHOTOMETRICS = new Set(['MONOCHROME1', 'MONOCHROME2']);

export function bytesFromValue(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return decodeBase64Bytes(value);
  return null;
}

export function arrayBufferForBytes(bytes) {
  if (!bytes) return null;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function typedPixelsFromBytes(bytes, bitsAllocated, pixelRepresentation, pixelCount, opts = {}) {
  if (!bytes || bytes.byteLength < pixelCount) return null;
  if (bitsAllocated === 8) return new Uint8Array(arrayBufferForBytes(bytes), 0, pixelCount);
  const neededBytes = pixelCount * 2;
  if (bytes.byteLength < neededBytes) return null;
  if (opts.littleEndian === false) {
    // Byte-swap into native order; signed reinterprets the same bits.
    const out = new Uint16Array(pixelCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, neededBytes);
    for (let i = 0; i < pixelCount; i += 1) out[i] = view.getUint16(i * 2, false);
    return pixelRepresentation === 1 ? new Int16Array(out.buffer) : out;
  }
  const aligned = arrayBufferForBytes(bytes);
  if (pixelRepresentation === 1) return new Int16Array(aligned, 0, pixelCount);
  return new Uint16Array(aligned, 0, pixelCount);
}

export function pixelDataRestrictionReason(meta = {}) {
  const samplesPerPixel = getInt(meta, 'SamplesPerPixel', 1);
  const photometric = getStr(meta, 'PhotometricInterpretation', 'MONOCHROME2').trim().toUpperCase();
  const bitsAllocated = getInt(meta, 'BitsAllocated', 16);
  const bitsStored = getInt(meta, 'BitsStored', bitsAllocated);
  if (samplesPerPixel !== 1) {
    return `unsupported DICOM import requires single-sample pixels (SamplesPerPixel=${samplesPerPixel})`;
  }
  if (!MONOCHROME_PHOTOMETRICS.has(photometric)) {
    return `unsupported DICOM import requires MONOCHROME1/2 pixels (PhotometricInterpretation=${photometric || 'missing'})`;
  }
  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    return `unsupported DICOM import requires 8- or 16-bit allocated pixels (BitsAllocated=${bitsAllocated})`;
  }
  if (bitsStored <= 0 || bitsStored > bitsAllocated) {
    return `unsupported DICOM import requires 1 <= BitsStored <= BitsAllocated (BitsStored=${bitsStored}, BitsAllocated=${bitsAllocated})`;
  }
  return '';
}
