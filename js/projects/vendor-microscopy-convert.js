import { localApiHeaders } from '../config.js';
import { microscopyConversionErrorText } from './local-intake-text.js';
import { LOCAL_VENDOR_MICROSCOPY_RE } from './local-intake-summary.js';

const MAX_VENDOR_CONVERT_PARTS = 64;
const MAX_VENDOR_CONVERT_PART_BYTES = 512 * 1024 * 1024;
export const MAX_VENDOR_CONVERT_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_VENDOR_MULTIPART_HEADER_BYTES = 16 * 1024;
const MAX_VENDOR_MULTIPART_OVERHEAD_BYTES = MAX_VENDOR_CONVERT_PARTS * (MAX_VENDOR_MULTIPART_HEADER_BYTES + 256);
const VENDOR_MULTIPART_SCAN_WINDOW_BYTES = 1024 * 1024;

function indexOfBytes(bytes, needle, start = 0) {
  let index = bytes.indexOf(needle[0], start);
  outer: while (index >= 0 && index <= bytes.length - needle.length) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        index = bytes.indexOf(needle[0], index + 1);
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

function multipartBoundary(contentType = '') {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = String(match?.[1] || match?.[2] || '');
  if (!boundary || boundary.length > 200 || !/^[A-Za-z0-9._-]+$/.test(boundary)) {
    throw new Error('Converter returned an invalid multipart boundary.');
  }
  return boundary;
}

function multipartHeaders(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const headers = new Map();
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('Converter returned a malformed multipart header.');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name || headers.has(name)) throw new Error('Converter returned duplicate multipart headers.');
    headers.set(name, value);
  }
  return headers;
}

function convertedPartFilename(contentDisposition = '', fallback = 'microscopy.ome.tiff') {
  const match = /filename\s*=\s*"([^"]+)"/i.exec(contentDisposition);
  const name = String(match?.[1] || fallback).split(/[\\/]/).pop() || fallback;
  if (!/\.ome\.tiff?$/i.test(name) || /[\r\n]/.test(name)) {
    throw new Error('Converter returned an invalid OME-TIFF filename.');
  }
  return name;
}

function warningValues(raw = '', { rejectMalformed = false } = {}) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : [];
  } catch {
    if (rejectMalformed) throw new Error('Converter returned malformed warning metadata.');
    return [];
  }
}

function convertedFile(blob, name, warnings = []) {
  const file = new File([blob], name, { type: 'image/tiff' });
  if (warnings.length) {
    Object.defineProperty(file, '_voxellabConvertWarnings', { value: warnings, configurable: true });
  }
  return file;
}

async function blobBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

async function blobHasBytes(blob, offset, expected) {
  if (offset < 0 || offset + expected.length > blob.size) return false;
  const bytes = await blobBytes(blob, offset, offset + expected.length);
  return indexOfBytes(bytes, expected) === 0;
}

async function indexOfBlobBytes(blob, needle, start) {
  const overlap = Math.max(0, needle.length - 1);
  let windowStart = start;
  while (windowStart < blob.size) {
    const windowEnd = Math.min(blob.size, windowStart + VENDOR_MULTIPART_SCAN_WINDOW_BYTES);
    const bytes = await blobBytes(blob, windowStart, windowEnd);
    const index = indexOfBytes(bytes, needle);
    if (index >= 0) return windowStart + index;
    if (windowEnd === blob.size) return -1;
    windowStart = windowEnd - overlap;
  }
  return -1;
}

export async function parseVendorMultipartBlob(blob, contentType, declaredPartCount = 0) {
  const boundary = multipartBoundary(contentType);
  const encoder = new TextEncoder();
  const marker = encoder.encode(`--${boundary}`);
  const nextMarker = encoder.encode(`\r\n--${boundary}`);
  const headerEndMarker = Uint8Array.from([13, 10, 13, 10]);
  const crlf = Uint8Array.from([13, 10]);
  const parts = [];
  const partIds = new Set();
  let totalBytes = 0;
  let cursor = 0;
  let closed = false;
  while (cursor < blob.size) {
    if (!await blobHasBytes(blob, cursor, marker)) {
      throw new Error('Converter multipart payload is missing a boundary.');
    }
    cursor += marker.length;
    const suffix = await blobBytes(blob, cursor, Math.min(blob.size, cursor + 2));
    if (suffix[0] === 45 && suffix[1] === 45) {
      cursor += 2;
      if (await blobHasBytes(blob, cursor, crlf)) cursor += 2;
      if (cursor !== blob.size) throw new Error('Converter multipart payload has trailing bytes.');
      closed = true;
      break;
    }
    if (indexOfBytes(suffix, crlf) !== 0) {
      throw new Error('Converter multipart boundary is malformed.');
    }
    cursor += crlf.length;
    const headerBytes = await blobBytes(
      blob,
      cursor,
      Math.min(blob.size, cursor + MAX_VENDOR_MULTIPART_HEADER_BYTES + headerEndMarker.length),
    );
    const headerEnd = indexOfBytes(headerBytes, headerEndMarker);
    if (headerEnd < 0 || headerEnd > MAX_VENDOR_MULTIPART_HEADER_BYTES) {
      throw new Error('Converter multipart headers exceed the supported limit.');
    }
    const headers = multipartHeaders(headerBytes.subarray(0, headerEnd));
    cursor += headerEnd + headerEndMarker.length;
    const partEnd = await indexOfBlobBytes(blob, nextMarker, cursor);
    if (partEnd < 0) throw new Error('Converter multipart part is not terminated.');
    const partBytes = partEnd - cursor;
    if (partBytes <= 0 || partBytes > MAX_VENDOR_CONVERT_PART_BYTES) {
      throw new Error('Converted microscopy part exceeds the supported size limit.');
    }
    totalBytes += partBytes;
    if (totalBytes > MAX_VENDOR_CONVERT_TOTAL_BYTES) {
      throw new Error('Converted microscopy response exceeds the supported aggregate size limit.');
    }
    if (!/^image\/tiff(?:\s*;|$)/i.test(headers.get('content-type') || '')) {
      throw new Error('Converter multipart part is not an OME-TIFF.');
    }
    const partId = String(headers.get('x-voxellab-convert-part') || '');
    if (!partId || partIds.has(partId)) throw new Error('Converter returned a missing or duplicate part identifier.');
    partIds.add(partId);
    const name = convertedPartFilename(headers.get('content-disposition'));
    const warnings = warningValues(headers.get('x-voxellab-convert-warnings'), { rejectMalformed: true });
    parts.push(convertedFile(blob.slice(cursor, partEnd, 'image/tiff'), name, warnings));
    if (parts.length > MAX_VENDOR_CONVERT_PARTS) {
      throw new Error(`Converter returned more than ${MAX_VENDOR_CONVERT_PARTS} microscopy series.`);
    }
    cursor = partEnd + 2;
  }
  if (!closed || !parts.length || declaredPartCount !== parts.length) {
    throw new Error('Converter multipart part count does not match the response metadata.');
  }
  return parts;
}

export async function readBoundedVendorResponseBlob(res, maxBytes, limitError) {
  const declaredLength = String(res.headers.get('Content-Length') || '').trim();
  if (declaredLength) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      throw new Error(limitError);
    }
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new Error('Converter returned an unreadable response body.');
  }
  let totalBytes = 0;
  let exceededLimit = false;
  const boundedStream = res.body.pipeThrough(new TransformStream({
    transform(value, controller) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength > maxBytes - totalBytes) {
        exceededLimit = true;
        throw new Error(limitError);
      }
      totalBytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
  }));
  try {
    return await new Response(boundedStream).blob();
  } catch (error) {
    if (exceededLimit) throw new Error(limitError);
    throw error;
  }
}

export async function convertVendorMicroscopyFile(file) {
  const splitNative = /\.(czi|nd2|lif)$/i.test(file?.name || '');
  const mode = splitNative ? '&mode=split' : '';
  let res;
  try {
    res = await fetch(`/api/microscopy/convert?name=${encodeURIComponent(file.name)}${mode}`, {
      method: 'POST',
      headers: localApiHeaders(),
      body: file,
    });
  } catch (error) {
    throw new Error(`Could not convert ${file.name}: ${error?.message || 'converter request failed'}`);
  }
  if (!res.ok) {
    let reason = '';
    try {
      const err = await res.json();
      reason = String(err?.reason || '');
    } catch {
      // The stable reason field is available only on JSON error responses.
    }
    if (splitNative && reason === 'optional_python_reader_missing') {
      throw new Error(`Could not convert ${file.name}: install the optional microscopy readers; native split-mode does not fall back to an external converter.`);
    }
    throw new Error(microscopyConversionErrorText(file.name, reason));
  }
  const baseName = (file.name || 'image').replace(LOCAL_VENDOR_MICROSCOPY_RE, '');
  const contentType = String(res.headers.get('Content-Type') || '');
  if (/^multipart\/mixed(?:\s*;|$)/i.test(contentType)) {
    const declaredPartCount = Number(res.headers.get('X-VoxelLab-Convert-Parts') || 0);
    if (!Number.isSafeInteger(declaredPartCount) || declaredPartCount < 2 || declaredPartCount > MAX_VENDOR_CONVERT_PARTS) {
      throw new Error('Converter returned an invalid multipart part count.');
    }
    const limit = MAX_VENDOR_CONVERT_TOTAL_BYTES + MAX_VENDOR_MULTIPART_OVERHEAD_BYTES;
    const blob = await readBoundedVendorResponseBlob(res, limit, 'Converted microscopy response exceeds the supported aggregate size limit.');
    return parseVendorMultipartBlob(blob, contentType, declaredPartCount);
  }
  if (!/^image\/tiff(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`Could not convert ${file.name}: the local converter returned an unsupported response type.`);
  }
  const blob = await readBoundedVendorResponseBlob(res, MAX_VENDOR_CONVERT_PART_BYTES, `Could not convert ${file.name}: converted microscopy data exceeds the supported size limit.`);
  if (blob.size <= 0 || blob.size > MAX_VENDOR_CONVERT_PART_BYTES) {
    throw new Error(`Could not convert ${file.name}: converted microscopy data exceeds the supported size limit.`);
  }
  const warnings = warningValues(res.headers.get('X-VoxelLab-Convert-Warnings'));
  const fallbackName = `${baseName}.ome.tiff`;
  const name = splitNative
    ? convertedPartFilename(res.headers.get('Content-Disposition'), fallbackName)
    : fallbackName;
  return [convertedFile(blob, name, warnings)];
}
