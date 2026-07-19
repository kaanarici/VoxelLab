import { CHARLS_CODEC_URL, OPENJPEG_CODEC_URL } from '../core/dependencies.js';

// DICOM compressed pixel data: lazy Cornerstone WASM from CDN. Each UID maps to a
// `category` on the registry rows below (volumetric-safe vs display-only vs blocked).

const TRANSFER_SYNTAX_REGISTRY = new Map([
  // Uncompressed
  ['1.2.840.10008.1.2',     { name: 'Implicit VR Little Endian',       codec: null,       category: 'uncompressed' }],
  ['1.2.840.10008.1.2.1',   { name: 'Explicit VR Little Endian',       codec: null,       category: 'uncompressed' }],
  ['1.2.840.10008.1.2.1.99',{ name: 'Deflated Explicit VR Little Endian', codec: null,    category: 'uncompressed' }],
  ['1.2.840.10008.1.2.2',   { name: 'Explicit VR Big Endian',          codec: null,       category: 'uncompressed' }],

  // JPEG 2000
  ['1.2.840.10008.1.2.4.90', { name: 'JPEG 2000 Lossless',            codec: 'jpeg2000',  category: 'lossless' }],
  ['1.2.840.10008.1.2.4.91', { name: 'JPEG 2000 Lossy',               codec: 'jpeg2000',  category: 'lossy-quantitative' }],

  // JPEG-LS
  ['1.2.840.10008.1.2.4.80', { name: 'JPEG-LS Lossless',              codec: 'jpegls',    category: 'lossless' }],
  ['1.2.840.10008.1.2.4.81', { name: 'JPEG-LS Near-Lossless',         codec: 'jpegls',    category: 'lossy-quantitative' }],

  // JPEG baseline/lossless
  ['1.2.840.10008.1.2.4.50', { name: 'JPEG Baseline (lossy)',         codec: 'jpeg',      category: 'lossy-display' }],
  ['1.2.840.10008.1.2.4.51', { name: 'JPEG Extended (lossy)',         codec: 'jpeg',      category: 'lossy-display' }],
  ['1.2.840.10008.1.2.4.57', { name: 'JPEG Lossless (process 14)',    codec: 'jpeg',      category: 'lossy-display' }],
  ['1.2.840.10008.1.2.4.70', { name: 'JPEG Lossless SV1',            codec: 'jpeg',      category: 'lossy-display' }],

  // RLE
  ['1.2.840.10008.1.2.5',    { name: 'RLE Lossless',                  codec: 'rle',       category: 'lossless' }],

  // MPEG (not decodable for pixel data extraction)
  ['1.2.840.10008.1.2.4.100', { name: 'MPEG2 Main Profile',           codec: null,        category: 'unsupported' }],
  ['1.2.840.10008.1.2.4.101', { name: 'MPEG2 High Profile',           codec: null,        category: 'unsupported' }],
  ['1.2.840.10008.1.2.4.102', { name: 'MPEG-4 AVC/H.264',            codec: null,        category: 'unsupported' }],
  ['1.2.840.10008.1.2.4.103', { name: 'MPEG-4 AVC/H.264 BD',         codec: null,        category: 'unsupported' }],

  // HTJ2K (future — not yet supported by Cornerstone WASM)
  ['1.2.840.10008.1.2.4.201', { name: 'HTJ2K Lossless',               codec: null,        category: 'unsupported' }],
  ['1.2.840.10008.1.2.4.202', { name: 'HTJ2K Lossy RPCL',            codec: null,        category: 'unsupported' }],
  ['1.2.840.10008.1.2.4.203', { name: 'HTJ2K Lossless RPCL',         codec: null,        category: 'unsupported' }],
]);

export function transferSyntaxInfo(uid) {
  const entry = TRANSFER_SYNTAX_REGISTRY.get(uid || '');
  if (entry) return { uid, ...entry };
  if (!uid || uid === '') return { uid: '', name: 'Unknown (treated as uncompressed)', codec: null, category: 'uncompressed' };
  return { uid, name: `Unknown transfer syntax ${uid}`, codec: null, category: 'unsupported' };
}

export function isCompressed(transferSyntaxUID) {
  const info = transferSyntaxInfo(transferSyntaxUID);
  return info.category !== 'uncompressed';
}

export function isBigEndianTransferSyntax(transferSyntaxUID) {
  return String(transferSyntaxUID || '') === '1.2.840.10008.1.2.2';
}

export function isDecodable(transferSyntaxUID) {
  const info = transferSyntaxInfo(transferSyntaxUID);
  return info.category === 'uncompressed' || info.category === 'lossless' || info.category === 'lossy-quantitative';
}

export function getCodecType(uid) {
  const info = transferSyntaxInfo(uid);
  return info.codec;
}

// Grayscale-faithful decoders only; lossy-display TS and canvas JPEG paths stay blocked.
export async function decodePixelData(compressedBuffer, transferSyntaxUID, rows, cols, bitsAllocated) {
  const info = transferSyntaxInfo(transferSyntaxUID);

  if (info.category === 'lossy-display') {
    console.warn(`[dicom-codecs] ${info.name} browser decode is disabled for medical fidelity`);
    return null;
  }

  if (info.category === 'unsupported') {
    console.warn(`[dicom-codecs] unsupported transfer syntax: ${info.name} (${transferSyntaxUID})`);
    return null;
  }

  if (info.codec === 'jpeg2000') {
    return decodeWithOpenJPEG(compressedBuffer, rows, cols, bitsAllocated);
  }

  if (info.codec === 'jpegls') {
    return decodeWithCharls(compressedBuffer, rows, cols, bitsAllocated);
  }

  if (info.codec === 'rle') {
    return decodeRLE(compressedBuffer, rows, cols, bitsAllocated);
  }

  // Uncompressed or unknown codec — pass through
  console.warn(`[dicom-codecs] no codec handler for: ${transferSyntaxUID}`);
  return null;
}

// JPEG 2000 decode via @cornerstonejs/codec-openjpeg WASM
let _openjpeg = null;
function copyDecodedPixels(decoded, pixelCount, bitsAllocated) {
  const bytesPerPixel = bitsAllocated === 16 ? 2 : 1;
  const bytes = new Uint8Array(pixelCount * bytesPerPixel);
  bytes.set(new Uint8Array(decoded.buffer, decoded.byteOffset, bytes.length));
  return bitsAllocated === 16 ? new Int16Array(bytes.buffer) : bytes;
}

async function decodeWithOpenJPEG(buffer, rows, cols, bitsAllocated) {
  if (!_openjpeg) {
    try {
      const mod = await import(OPENJPEG_CODEC_URL);
      _openjpeg = await mod.default();
    } catch (e) {
      console.warn('[dicom-codecs] failed to load OpenJPEG WASM:', e.message);
      return null;
    }
  }
  let decoder = null;
  try {
    const encoded = new Uint8Array(buffer);
    decoder = new _openjpeg.J2KDecoder();
    const encodedBuffer = decoder.getEncodedBuffer(encoded.length);
    encodedBuffer.set(encoded);
    decoder.decode();
    const decoded = decoder.getDecodedBuffer();
    return copyDecodedPixels(decoded, rows * cols, bitsAllocated);
  } catch (e) {
    console.warn('[dicom-codecs] OpenJPEG decode failed:', e.message);
    return null;
  } finally {
    decoder?.delete?.();
  }
}

// JPEG-LS decode via @cornerstonejs/codec-charls WASM
let _charls = null;
async function decodeWithCharls(buffer, rows, cols, bitsAllocated) {
  if (!_charls) {
    try {
      const mod = await import(CHARLS_CODEC_URL);
      _charls = await mod.default();
    } catch (e) {
      console.warn('[dicom-codecs] failed to load CHARLS WASM:', e.message);
      return null;
    }
  }
  let decoder = null;
  try {
    const encoded = new Uint8Array(buffer);
    decoder = new _charls.JpegLSDecoder();
    const encodedBuffer = decoder.getEncodedBuffer(encoded.length);
    encodedBuffer.set(encoded);
    decoder.decode();
    const decoded = decoder.getDecodedBuffer();
    return copyDecodedPixels(decoded, rows * cols, bitsAllocated);
  } catch (e) {
    console.warn('[dicom-codecs] CHARLS decode failed:', e.message);
    return null;
  } finally {
    decoder?.delete?.();
  }
}

// RLE Lossless: one grayscale byte plane per 8 allocated bits. The fixed 64-byte
// header and exactly-sized planes prevent malformed color or partial data from
// being misrepresented as calibrated grayscale samples.
function decodeRLE(compressedBuffer, rows, cols, bitsAllocated) {
  try {
    if (!(compressedBuffer instanceof ArrayBuffer) || (bitsAllocated !== 8 && bitsAllocated !== 16)) return null;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows <= 0 || cols <= 0) return null;

    const pixelCount = rows * cols;
    if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) return null;

    const bytesPerPixel = bitsAllocated / 8;
    const outputBytes = pixelCount * bytesPerPixel;
    const headerBytes = 64;
    if (!Number.isSafeInteger(outputBytes) || compressedBuffer.byteLength < headerBytes) return null;

    const view = new DataView(compressedBuffer);
    const numSegments = view.getUint32(0, true);
    if (numSegments !== bytesPerPixel) return null;
    for (let index = numSegments; index < 15; index += 1) {
      if (view.getUint32(4 + index * 4, true) !== 0) return null;
    }

    const offsets = Array.from({ length: numSegments }, (_, index) => view.getUint32(4 + index * 4, true));
    if (offsets[0] !== headerBytes) return null;
    if (offsets.some((offset, index) => (
      offset < headerBytes
      || offset >= compressedBuffer.byteLength
      || (index > 0 && offset <= offsets[index - 1])
    ))) return null;

    const output = new Uint8Array(outputBytes);
    for (let plane = 0; plane < numSegments; plane += 1) {
      const start = offsets[plane];
      const end = plane + 1 < numSegments ? offsets[plane + 1] : compressedBuffer.byteLength;
      if (end <= start || (end - start) % 2 !== 0) return null;
      const segment = new Uint8Array(compressedBuffer, start, end - start);
      // RLE byte-plane index: segment 0 = MSB for 16-bit, segment 0 = only byte for 8-bit.
      const planeOffset = bytesPerPixel === 1 ? 0 : (plane === 0 ? 1 : 0);

      let inputIndex = 0;
      for (let row = 0; row < rows; row += 1) {
        let column = 0;
        while (column < cols) {
          if (inputIndex >= segment.length) return null;
          const control = segment[inputIndex];
          inputIndex += 1;
          const signedControl = control > 127 ? control - 256 : control;
          if (signedControl === -128) continue;

          const count = signedControl >= 0 ? signedControl + 1 : 1 - signedControl;
          if (column + count > cols) return null;
          const outputIndex = row * cols + column;
          if (signedControl >= 0) {
            if (inputIndex + count > segment.length) return null;
            for (let index = 0; index < count; index += 1) {
              output[(outputIndex + index) * bytesPerPixel + planeOffset] = segment[inputIndex + index];
            }
            inputIndex += count;
          } else {
            if (inputIndex >= segment.length) return null;
            const value = segment[inputIndex];
            inputIndex += 1;
            for (let index = 0; index < count; index += 1) {
              output[(outputIndex + index) * bytesPerPixel + planeOffset] = value;
            }
          }
          column += count;
        }
      }

      const trailingBytes = segment.length - inputIndex;
      if (trailingBytes > 1 || (trailingBytes === 1 && segment[inputIndex] !== 0)) return null;
    }

    return bitsAllocated === 16 ? new Int16Array(output.buffer) : output;
  } catch (e) {
    console.warn('[dicom-codecs] RLE decode failed:', e.message);
    return null;
  }
}
