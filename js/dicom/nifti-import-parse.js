// NIfTI parsing lives beside the DICOM import path but stays isolated because
// its header, affine, and RAS/LPS handling have different correctness rules.

import { PAKO_ESM_URL } from '../core/dependencies.js';
import { DEFAULT_IOP, normalize3 } from '../core/geometry.js';

let pako = null;
let fallbackImportSequence = 0;
const IN_NODE = typeof globalThis.process !== 'undefined'
  && Boolean(globalThis.process.versions?.node)
  && typeof globalThis.window === 'undefined';

async function ensurePako() {
  if (pako) return pako;
  const mod = IN_NODE ? await import('pako') : await import(PAKO_ESM_URL);
  pako = mod;
  return pako;
}

function gzipDecodedSize(bytes) {
  if (bytes.byteLength < 18) throw niftiError('gzip input is truncated.');
  const offset = bytes.byteOffset + bytes.byteLength - 4;
  return new DataView(bytes.buffer, offset, 4).getUint32(0, true);
}

function boundedInflatedOutput(expectedBytes, maxBytes) {
  if (!(expectedBytes > 0) || expectedBytes > maxBytes) {
    const error = niftiError(`decompressed input exceeds the ${maxBytes} byte limit.`);
    error.niftiResourceLimit = true;
    throw error;
  }
  const output = new Uint8Array(expectedBytes);
  let length = 0;
  return {
    append(value) {
      const part = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (part.byteLength > output.byteLength - length) {
        throw niftiError('gzip output exceeds its declared decoded size.');
      }
      output.set(part, length);
      length += part.byteLength;
    },
    finish() {
      if (length !== output.byteLength) throw niftiError('gzip output does not match its declared decoded size.');
      return output;
    },
  };
}

async function inflateGzipWithPlatform(bytes, maxBytes, expectedBytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const output = boundedInflatedOutput(expectedBytes, maxBytes);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output.append(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return output.finish();
}

async function inflateGzipWithPako(bytes, maxBytes, expectedBytes) {
  const pk = await ensurePako();
  const Inflate = pk.Inflate || pk.default?.Inflate;
  if (typeof Inflate !== 'function') throw niftiError('gzip decoder pako.Inflate is unavailable.');
  const inflator = new Inflate({ chunkSize: 64 * 1024 });
  const output = boundedInflatedOutput(expectedBytes, maxBytes);
  inflator.onData = part => output.append(part);
  try {
    inflator.push(bytes, true);
  } catch (error) {
    if (error?.niftiResourceLimit) throw error;
    throw niftiError('gzip input could not be decompressed.');
  }
  if (inflator.err || inflator.ended !== true) throw niftiError('gzip input could not be decompressed completely.');
  return output.finish();
}

async function inflateGzipBytes(bytes, maxBytes, expectedBytes) {
  if (typeof DecompressionStream === 'function') {
    try {
      return await inflateGzipWithPlatform(bytes, maxBytes, expectedBytes);
    } catch (error) {
      if (error?.niftiResourceLimit) throw error;
    }
  }
  return inflateGzipWithPako(bytes, maxBytes, expectedBytes);
}

const NIFTI_TYPES = Object.freeze({
  2: [1, 'getUint8', Uint8Array],
  256: [1, 'getInt8', Int8Array],
  4: [2, 'getInt16', Int16Array],
  8: [4, 'getInt32', Int32Array],
  16: [4, 'getFloat32', Float32Array],
  64: [8, 'getFloat64', Float64Array],
  512: [2, 'getUint16', Uint16Array],
  768: [4, 'getUint32', Uint32Array],
});

const NIFTI_SPATIAL_UNITS = Object.freeze({
  1: { name: 'meter', mm: 1000 },
  2: { name: 'mm', mm: 1 },
  3: { name: 'micron', mm: 0.001 },
});

const NIFTI_TEMPORAL_UNITS = Object.freeze({
  8: { name: 'second', seconds: 1, kind: 'duration', known: true },
  16: { name: 'millisecond', seconds: 0.001, kind: 'duration', known: true },
  24: { name: 'microsecond', seconds: 0.000001, kind: 'duration', known: true },
  32: { name: 'hertz', seconds: 0, kind: 'frequency', known: false },
  40: { name: 'parts per million', seconds: 0, kind: 'frequency', known: false },
  48: { name: 'radian per second', seconds: 0, kind: 'frequency', known: false },
});

// These caps cover decoded source data, normalized Float32 volumes, and the
// RGBA canvases created for the shared local-series pipeline. They are checked
// from the header before any of those allocations happen.
export const NIFTI_IMPORT_LIMITS = Object.freeze({
  maxCompressedBytes: 128 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxPayloadBytes: 128 * 1024 * 1024,
  maxVoxelsPerTimepoint: 16 * 1024 * 1024,
  maxTotalVoxels: 32 * 1024 * 1024,
  maxTimepoints: 64,
  maxWorkingSetBytes: 384 * 1024 * 1024,
});

const NATIVE_LITTLE_ENDIAN = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;

function niftiVoxelReader(source, view, offset, datatype, littleEndian, length) {
  const [bytes, getter, TypedArray] = NIFTI_TYPES[datatype] || [];
  if (!bytes) return null;
  const absoluteOffset = source.byteOffset + offset;
  if (littleEndian && NATIVE_LITTLE_ENDIAN && absoluteOffset % bytes === 0) {
    const typed = new TypedArray(source.buffer, absoluteOffset, length);
    return (index) => typed[index];
  }
  return (index) => view[getter](offset + index * bytes, littleEndian);
}

function niftiSpatialUnit(xyztUnits) {
  // NIfTI-1 stores spatial pixdim units in xyzt_units bits 0..2; VoxelLab stores geometry in millimeters.
  const code = xyztUnits & 0x07;
  const unit = NIFTI_SPATIAL_UNITS[code];
  return unit ? { code, ...unit, known: true } : { code, name: 'unknown', mm: 0, known: false };
}

function niftiTemporalUnit(xyztUnits) {
  const code = xyztUnits & 0x38;
  const unit = NIFTI_TEMPORAL_UNITS[code];
  return unit ? { code, ...unit } : { code, name: 'unknown', seconds: 0, kind: 'unknown', known: false };
}

function toMillimeters(value, unit) {
  const numeric = Number(value || 0);
  return unit.known && Number.isFinite(numeric) ? numeric * unit.mm : 0;
}

function affineToMillimeters(matrix, unit) {
  return unit.known ? matrix.map(row => row.map(value => value * unit.mm)) : matrix;
}

function niftiRasToLps(matrix) {
  return matrix.map((row, index) => (index < 2 ? row.map(value => -value) : row));
}

function sourceFileName(file = {}) {
  return String(file.webkitRelativePath || file.name || '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function niftiError(message) {
  return new Error(`Invalid or unsupported NIfTI: ${message}`);
}

function finiteValues(values) {
  return values.every(Number.isFinite);
}

function safeProduct(values, label) {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) throw niftiError(`${label} must be positive safe integers.`);
    product *= value;
    if (!Number.isSafeInteger(product)) throw niftiError(`${label} overflow.`);
  }
  return product;
}

function safeSum(values, label) {
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw niftiError(`${label} must use non-negative safe integers.`);
    sum += value;
    if (!Number.isSafeInteger(sum)) throw niftiError(`${label} overflow.`);
  }
  return sum;
}

function safeScaledCeil(value, numerator, denominator, label) {
  return Math.ceil(safeProduct([value, numerator], label) / denominator);
}

function assertWorkingSet(parts, maxBytes, label) {
  const bytes = safeSum(parts, `${label} byte count`);
  if (bytes > maxBytes) throw niftiError(`${label} (${bytes} bytes) exceeds the ${maxBytes} byte working-set limit.`);
  return bytes;
}

function hasMagic(source, offset, values) {
  return values.every((value, index) => source[offset + index] === value);
}

function validateSingleFileMagic(source, version) {
  const isNifti2 = version === 2;
  const offset = isNifti2 ? 4 : 344;
  const singleFileMagic = isNifti2
    ? [0x6e, 0x2b, 0x32, 0, 0x0d, 0x0a, 0x1a, 0x0a]
    : [0x6e, 0x2b, 0x31, 0];
  const pairedFileMagic = isNifti2
    ? [0x6e, 0x69, 0x32, 0, 0x0d, 0x0a, 0x1a, 0x0a]
    : [0x6e, 0x69, 0x31, 0];
  const label = isNifti2 ? 'NIfTI-2' : 'NIfTI-1';
  const singleFileLabel = isNifti2 ? 'n+2\\0' : 'n+1\\0';
  const pairedFileLabel = isNifti2 ? 'ni2\\0' : 'ni1\\0';
  if (hasMagic(source, offset, pairedFileMagic)) {
    throw niftiError(`paired-file magic ${pairedFileLabel} is not supported; provide one ${singleFileLabel} .nii file.`);
  }
  if (!hasMagic(source, offset, singleFileMagic)) {
    throw niftiError(`single-file ${label} magic ${singleFileLabel} is required.`);
  }
}

function nifti2SafeInteger(view, offset, littleEndian, label) {
  const value = view.getBigInt64(offset, littleEndian);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < 0n || value > max) throw niftiError(`${label} must be a non-negative safe integer.`);
  return Number(value);
}

function niftiHeader(source) {
  if (source.byteLength < 348) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const littleEndianHeaderSize = view.getInt32(0, true);
  const bigEndianHeaderSize = view.getInt32(0, false);
  const version = littleEndianHeaderSize === 540 || bigEndianHeaderSize === 540
    ? 2
    : (littleEndianHeaderSize === 348 || bigEndianHeaderSize === 348 ? 1 : 0);
  if (!version) return null;
  const headerBytes = version === 2 ? 540 : 348;
  if (source.byteLength < headerBytes) return null;
  const littleEndian = littleEndianHeaderSize === headerBytes;
  validateSingleFileMagic(source, version);

  if (version === 1) {
    const dims = [];
    const pixdim = [];
    for (let index = 0; index < 8; index += 1) {
      dims.push(view.getInt16(40 + index * 2, littleEndian));
      pixdim.push(view.getFloat32(76 + index * 4, littleEndian));
    }
    return {
      version,
      view,
      littleEndian,
      dims,
      datatype: view.getInt16(70, littleEndian),
      bitpix: view.getInt16(72, littleEndian),
      voxOffset: view.getFloat32(108, littleEndian),
      pixdim,
      xyztUnits: view.getUint8(123),
      timeOffset: view.getFloat32(136, littleEndian),
      qformCode: view.getInt16(252, littleEndian),
      sformCode: view.getInt16(254, littleEndian),
      quaternB: view.getFloat32(256, littleEndian),
      quaternC: view.getFloat32(260, littleEndian),
      quaternD: view.getFloat32(264, littleEndian),
      qoffsetX: view.getFloat32(268, littleEndian),
      qoffsetY: view.getFloat32(272, littleEndian),
      qoffsetZ: view.getFloat32(276, littleEndian),
      srowX: Array.from({ length: 4 }, (_, index) => view.getFloat32(280 + index * 4, littleEndian)),
      srowY: Array.from({ length: 4 }, (_, index) => view.getFloat32(296 + index * 4, littleEndian)),
      srowZ: Array.from({ length: 4 }, (_, index) => view.getFloat32(312 + index * 4, littleEndian)),
      sclSlope: view.getFloat32(112, littleEndian),
      sclInter: view.getFloat32(116, littleEndian),
      minimumDataOffset: 352,
    };
  }

  const dims = [];
  const pixdim = [];
  for (let index = 0; index < 8; index += 1) {
    dims.push(nifti2SafeInteger(view, 16 + index * 8, littleEndian, `dim[${index}]`));
    pixdim.push(view.getFloat64(104 + index * 8, littleEndian));
  }
  return {
    version,
    view,
    littleEndian,
    dims,
    datatype: view.getInt16(12, littleEndian),
    bitpix: view.getInt16(14, littleEndian),
    voxOffset: nifti2SafeInteger(view, 168, littleEndian, 'vox_offset'),
    pixdim,
    xyztUnits: view.getInt32(500, littleEndian),
    timeOffset: view.getFloat64(216, littleEndian),
    qformCode: view.getInt32(344, littleEndian),
    sformCode: view.getInt32(348, littleEndian),
    quaternB: view.getFloat64(352, littleEndian),
    quaternC: view.getFloat64(360, littleEndian),
    quaternD: view.getFloat64(368, littleEndian),
    qoffsetX: view.getFloat64(376, littleEndian),
    qoffsetY: view.getFloat64(384, littleEndian),
    qoffsetZ: view.getFloat64(392, littleEndian),
    srowX: Array.from({ length: 4 }, (_, index) => view.getFloat64(400 + index * 8, littleEndian)),
    srowY: Array.from({ length: 4 }, (_, index) => view.getFloat64(432 + index * 8, littleEndian)),
    srowZ: Array.from({ length: 4 }, (_, index) => view.getFloat64(464 + index * 8, littleEndian)),
    sclSlope: view.getFloat64(176, littleEndian),
    sclInter: view.getFloat64(184, littleEndian),
    minimumDataOffset: 544,
  };
}

function niftiImportSeed() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid) return uuid.toLowerCase().replaceAll('-', '');
  } catch {
    // Monotonic process-local fallback below.
  }
  fallbackImportSequence += 1;
  return `${Date.now().toString(36)}_${fallbackImportSequence.toString(36)}`;
}

function niftiDimensions(dims) {
  const dimCount = dims[0];
  if (!Number.isInteger(dimCount) || dimCount < 2 || dimCount > 7) {
    throw niftiError('dim[0] must declare between 2 and 7 dimensions.');
  }
  const spatial = [dims[1], dims[2], dimCount >= 3 ? dims[3] : 1];
  const [nx, ny, nz] = spatial;
  const voxelsPerTimepoint = safeProduct(spatial, 'spatial dimensions');
  const timepoints = dimCount >= 4 ? dims[4] : 1;
  if (!Number.isSafeInteger(timepoints) || timepoints <= 0) throw niftiError('dim[4] must be a positive integer.');
  for (let index = 5; index <= dimCount; index += 1) {
    if (dims[index] !== 1) {
      throw niftiError(`dim[${index}] is ${dims[index]}; only a singleton dim[5+] is supported.`);
    }
  }
  if (timepoints > NIFTI_IMPORT_LIMITS.maxTimepoints) {
    throw niftiError(`timepoints (${timepoints}) exceed the ${NIFTI_IMPORT_LIMITS.maxTimepoints} timepoint limit.`);
  }
  if (voxelsPerTimepoint > NIFTI_IMPORT_LIMITS.maxVoxelsPerTimepoint) {
    throw niftiError(`voxels per timepoint (${voxelsPerTimepoint}) exceed the ${NIFTI_IMPORT_LIMITS.maxVoxelsPerTimepoint} voxel limit.`);
  }
  const totalVoxels = safeProduct([voxelsPerTimepoint, timepoints], 'total voxel count');
  if (totalVoxels > NIFTI_IMPORT_LIMITS.maxTotalVoxels) {
    throw niftiError(`total voxels (${totalVoxels}) exceed the ${NIFTI_IMPORT_LIMITS.maxTotalVoxels} voxel limit.`);
  }
  return { nx, ny, nz, timepoints, voxelsPerTimepoint, totalVoxels };
}

function niftiAffine({
  sformCode, qformCode, srowX, srowY, srowZ, quaternB, quaternC, quaternD,
  qoffsetX, qoffsetY, qoffsetZ, pixdim, spatialUnit,
}) {
  const validateColumns = (matrix) => {
    const columns = [0, 1, 2].map(column => matrix.map(row => row[column]));
    const lengths = columns.map(column => Math.hypot(...column));
    if (!finiteValues(lengths) || lengths.some(length => length <= 1e-6)) {
      throw niftiError('declared affine contains a degenerate spatial column.');
    }
    for (let left = 0; left < columns.length; left += 1) {
      for (let right = left + 1; right < columns.length; right += 1) {
        const dot = columns[left].reduce((sum, value, index) => sum + value * columns[right][index], 0);
        const cosine = Math.abs(dot / (lengths[left] * lengths[right]));
        if (cosine > 1e-3) throw niftiError('declared affine contains unsupported shear or non-orthogonal axes.');
      }
    }
    return matrix;
  };
  if (sformCode > 0) {
    if (!finiteValues([...srowX, ...srowY, ...srowZ])) throw niftiError('sform affine contains a non-finite value.');
    return validateColumns(affineToMillimeters(niftiRasToLps([srowX, srowY, srowZ]), spatialUnit));
  }
  if (qformCode <= 0) return null;
  if (!finiteValues([quaternB, quaternC, quaternD, qoffsetX, qoffsetY, qoffsetZ])) {
    throw niftiError('qform affine contains a non-finite value.');
  }
  const quaternionNormSquared = quaternB * quaternB + quaternC * quaternC + quaternD * quaternD;
  if (quaternionNormSquared > 1 + 1e-5) throw niftiError('qform quaternion norm exceeds 1.');
  const correction = quaternionNormSquared > 1 ? 1 / Math.sqrt(quaternionNormSquared) : 1;
  const b = quaternB * correction;
  const c = quaternC * correction;
  const d = quaternD * correction;
  const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
  const qfac = pixdim[0] < 0 ? -1 : 1;
  const [dx, dy, dz] = pixdim.slice(1, 4);
  const abTerm = a * b, ac = a * c, ad = a * d;
  const bb = b * b, bc = b * c, bd = b * d;
  const cc = c * c, cd = c * d, dd = d * d;
  return validateColumns(affineToMillimeters(niftiRasToLps([
    [(a * a + bb - cc - dd) * dx, 2 * (bc - ad) * dy, qfac * 2 * (bd + ac) * dz, qoffsetX],
    [2 * (bc + ad) * dx, (a * a + cc - bb - dd) * dy, qfac * 2 * (cd - abTerm) * dz, qoffsetY],
    [2 * (bd - ac) * dx, 2 * (cd + abTerm) * dy, qfac * (a * a + dd - bb - cc) * dz, qoffsetZ],
  ]), spatialUnit));
}

function sliceCanvasesForNifti(rawVolume, voxelAt, volumeOffset, nx, ny, nz, sclSlope, sclInter, valueRange) {
  const sliceCanvases = [];
  const { min, max, windowMin, windowMax } = valueRange;
  const normInv = 1 / (max - min || 1);
  const displayInv = 255 / (windowMax - windowMin || 1);
  for (let z = 0; z < nz; z++) {
    const canvas = document.createElement('canvas');
    canvas.width = nx; canvas.height = ny;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(nx, ny);
    const d = img.data;
    const base = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) {
      const index = base + i;
      const scaled = voxelAt(volumeOffset + index) * sclSlope + sclInter;
      rawVolume[index] = Math.max(0, Math.min(1, (scaled - min) * normInv));
      let value = Math.round((scaled - windowMin) * displayInv);
      if (value < 0) value = 0;
      if (value > 255) value = 255;
      d[i * 4] = value; d[i * 4 + 1] = value; d[i * 4 + 2] = value; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    sliceCanvases.push(canvas);
  }
  return sliceCanvases;
}

/** Parse a local 3D or 4D NIfTI into independently viewable normalized series. */
export async function parseNIfTISeries(
  file,
  onProgress = () => {},
  {
    allowTimeSeries = true,
    maxDecodedBytes = NIFTI_IMPORT_LIMITS.maxDecodedBytes,
    maxWorkingSetBytes = NIFTI_IMPORT_LIMITS.maxWorkingSetBytes,
  } = {},
) {
  const decodedByteLimit = Math.min(
    Number.isSafeInteger(maxDecodedBytes) && maxDecodedBytes > 0
      ? maxDecodedBytes
      : NIFTI_IMPORT_LIMITS.maxDecodedBytes,
    NIFTI_IMPORT_LIMITS.maxDecodedBytes,
  );
  const workingSetLimit = Math.min(
    Number.isSafeInteger(maxWorkingSetBytes) && maxWorkingSetBytes > 0
      ? maxWorkingSetBytes
      : NIFTI_IMPORT_LIMITS.maxWorkingSetBytes,
    NIFTI_IMPORT_LIMITS.maxWorkingSetBytes,
  );
  onProgress('reading', file.name);
  if (Number.isFinite(file?.size) && file.size > NIFTI_IMPORT_LIMITS.maxCompressedBytes) {
    throw niftiError(`input exceeds the ${NIFTI_IMPORT_LIMITS.maxCompressedBytes} byte compressed-input limit.`);
  }
  let source = new Uint8Array(await file.arrayBuffer());
  if (source.byteLength > NIFTI_IMPORT_LIMITS.maxCompressedBytes) {
    throw niftiError(`input exceeds the ${NIFTI_IMPORT_LIMITS.maxCompressedBytes} byte compressed-input limit.`);
  }

  if (/\.gz$/i.test(file.name || '')) {
    const expectedBytes = gzipDecodedSize(source);
    if (expectedBytes > decodedByteLimit) {
      throw niftiError(`decompressed input exceeds the ${decodedByteLimit} byte limit.`);
    }
    // Model a Blob/decoder-owned compressed copy and one decoded-size transient
    // in addition to the retained source and final decoded output.
    assertWorkingSet(
      [source.byteLength, source.byteLength, expectedBytes, expectedBytes],
      workingSetLimit,
      'gzip decompression working set',
    );
    source = await inflateGzipBytes(source, decodedByteLimit, expectedBytes);
  }

  const header = niftiHeader(source);
  if (!header) return null;
  const {
    version, view, littleEndian, dims, datatype, bitpix, voxOffset, pixdim,
    xyztUnits, timeOffset, qformCode, sformCode, quaternB, quaternC, quaternD,
    qoffsetX, qoffsetY, qoffsetZ, srowX, srowY, srowZ, sclSlope, sclInter,
    minimumDataOffset,
  } = header;
  const { nx, ny, nz, timepoints, voxelsPerTimepoint, totalVoxels } = niftiDimensions(dims);
  if (!allowTimeSeries && timepoints > 1) {
    throw new Error('4D NIfTI imports produce multiple series; use parseNIfTISeries.');
  }
  const spatialUnit = niftiSpatialUnit(xyztUnits);
  const temporalUnit = niftiTemporalUnit(xyztUnits);
  const temporalSpacing = pixdim[4];

  // Rescale slope/intercept from header (may be 0/0 meaning identity)
  let scl_slope = sclSlope;
  let scl_inter = sclInter;
  if (scl_slope === 0) { scl_slope = 1; scl_inter = 0; }
  if (!finiteValues([scl_slope, scl_inter, ...pixdim, temporalSpacing, timeOffset])) {
    throw niftiError('scaling, pixdim, or time offset contains a non-finite value.');
  }
  if (!pixdim.slice(1, 4).every(value => Number.isFinite(value) && value > 0)) {
    throw niftiError('pixdim[1..3] must contain positive finite spatial spacing.');
  }
  if (temporalSpacing < 0) throw niftiError('pixdim[4] must not be negative.');
  if (timepoints > 1 && temporalUnit.kind === 'frequency') {
    throw niftiError(`dim[4] frequency unit ${temporalUnit.name} is not a supported time axis.`);
  }

  onProgress('converting', `${nx}×${ny}×${nz}${timepoints > 1 ? ` × ${timepoints} timepoints` : ''}`);

  const offset = voxOffset;
  const bytesPerVoxel = NIFTI_TYPES[datatype]?.[0] || 0;
  if (!bytesPerVoxel || bitpix !== bytesPerVoxel * 8) return null;
  if (!Number.isSafeInteger(offset) || offset < minimumDataOffset) return null;
  const payloadBytes = safeProduct([totalVoxels, bytesPerVoxel], 'payload byte count');
  if (payloadBytes > NIFTI_IMPORT_LIMITS.maxPayloadBytes) {
    throw niftiError(`payload bytes (${payloadBytes}) exceed the ${NIFTI_IMPORT_LIMITS.maxPayloadBytes} byte limit.`);
  }
  if (offset + payloadBytes > source.byteLength) return null;
  const rawFloatBytes = safeProduct([totalVoxels, Float32Array.BYTES_PER_ELEMENT], 'normalized raw byte count');
  const canvasBackingBytes = safeProduct([totalVoxels, 4], 'canvas backing byte count');
  // injectLocalSeries converts every retained canvas to a data-URL-backed Image
  // while the parsed canvas results are still alive. Model both the decoded
  // Image backing and a conservative UTF-16 base64 representation of a
  // worst-case RGBA PNG so this parser cannot hand an unsafe result downstream.
  const retainedDisplayImageBytes = canvasBackingBytes;
  const retainedDataUrlBytes = safeScaledCeil(canvasBackingBytes, 8, 3, 'retained data URL byte count');
  const totalSlices = safeProduct([nz, timepoints], 'display slice count');
  const displayObjectOverheadBytes = safeProduct([totalSlices, 4 * 1024], 'display object overhead byte count');
  const imageDataPlaneBytes = safeProduct([nx, ny, 4], 'largest ImageData plane byte count');
  const conversionPlaneTransientBytes = safeScaledCeil(imageDataPlaneBytes, 8, 3, 'conversion plane transient byte count');
  assertWorkingSet(
    [
      source.byteLength,
      rawFloatBytes,
      canvasBackingBytes,
      retainedDisplayImageBytes,
      retainedDataUrlBytes,
      displayObjectOverheadBytes,
      imageDataPlaneBytes,
      conversionPlaneTransientBytes,
    ],
    workingSetLimit,
    'NIfTI import working set',
  );
  const voxelAt = niftiVoxelReader(source, view, offset, datatype, littleEndian, totalVoxels);
  if (!voxelAt) return null;

  // Keep the scaled range in the Number domain so adjacent Uint32 values do
  // not collapse before normalization. A second source pass fills only the
  // retained Float32 normalized volumes while producing display slices.
  const step = Math.max(1, Math.floor(totalVoxels / 50000));
  const samples = [];
  let vMin = Infinity, vMax = -Infinity;
  let nextSample = 0;
  for (let i = 0; i < totalVoxels; i++) {
    const scaled = voxelAt(i) * scl_slope + scl_inter;
    if (!Number.isFinite(scaled)) throw niftiError('voxel scaling produced a non-finite value.');
    if (i === nextSample) {
      samples.push(scaled);
      nextSample += step;
    }
    if (scaled < vMin) vMin = scaled;
    if (scaled > vMax) vMax = scaled;
  }
  samples.sort((a, b) => a - b);
  const mn = samples[Math.floor(samples.length * 0.02)];
  const mx = samples[Math.floor(samples.length * 0.98)];
  if (!Number.isFinite(vMax - vMin) || !Number.isFinite(mx - mn)) {
    throw niftiError('voxel value range exceeds finite normalization precision.');
  }
  const valueRange = { min: vMin, max: vMax, windowMin: mn, windowMax: mx };

  const fallbackPixelSpacing = [
    toMillimeters(pixdim[2], spatialUnit),
    toMillimeters(pixdim[1], spatialUnit),
  ];
  const fallbackSliceThickness = toMillimeters(pixdim[3], spatialUnit);
  const fallbackLastIPP = spatialUnit.known ? [0, 0, (nz - 1) * fallbackSliceThickness] : [0, 0, 0];
  const affineFromHeader = niftiAffine({
    sformCode, qformCode, srowX, srowY, srowZ,
    quaternB, quaternC, quaternD,
    qoffsetX, qoffsetY, qoffsetZ, pixdim, spatialUnit,
  });
  const affineValueAt = (matrix, i, j, k) => [
    matrix[0][0] * i + matrix[0][1] * j + matrix[0][2] * k + matrix[0][3],
    matrix[1][0] * i + matrix[1][1] * j + matrix[1][2] * k + matrix[1][3],
    matrix[2][0] * i + matrix[2][1] * j + matrix[2][2] * k + matrix[2][3],
  ];
  let pixelSpacing = fallbackPixelSpacing;
  let sliceThickness = fallbackSliceThickness;
  let firstIPP = [0, 0, 0];
  let lastIPP = fallbackLastIPP;
  let orientation = [...DEFAULT_IOP];
  let spacingKnown = spatialUnit.known && fallbackPixelSpacing[0] > 0 && fallbackPixelSpacing[1] > 0;
  if (affineFromHeader) {
    const col0 = [affineFromHeader[0][0], affineFromHeader[1][0], affineFromHeader[2][0]];
    const col1 = [affineFromHeader[0][1], affineFromHeader[1][1], affineFromHeader[2][1]];
    const col2 = [affineFromHeader[0][2], affineFromHeader[1][2], affineFromHeader[2][2]];
    const len0 = Math.hypot(...col0);
    const len1 = Math.hypot(...col1);
    const len2 = Math.hypot(...col2);
    const rowDir = normalize3(col0);
    const colDir = normalize3(col1);
    if (rowDir && colDir) {
      pixelSpacing = spatialUnit.known ? [len1, len0] : [0, 0];
      orientation = [...rowDir, ...colDir];
      spacingKnown = spatialUnit.known && len0 > 1e-6 && len1 > 1e-6;
    }
    sliceThickness = spatialUnit.known && len2 > 1e-6 ? len2 : fallbackSliceThickness;
    firstIPP = spatialUnit.known ? [affineFromHeader[0][3], affineFromHeader[1][3], affineFromHeader[2][3]] : [0, 0, 0];
    lastIPP = spatialUnit.known ? affineValueAt(affineFromHeader, 0, 0, nz - 1) : fallbackLastIPP;
  }

  const seed = niftiImportSeed();
  const baseName = file.name.replace(/\.nii(\.gz)?$/i, '');
  const timeSeriesId = timepoints > 1 ? `nifti_timeseries_${seed}` : '';
  const sourceFile = sourceFileName(file);
  const rawVolumes = Array.from({ length: timepoints }, () => new Float32Array(voxelsPerTimepoint));
  return rawVolumes.map((rawVolume, timeIndex) => {
    const entry = {
      slug: timepoints > 1 ? `nifti_${seed}_t${timeIndex + 1}` : `nifti_${seed}`,
      name: timepoints > 1 ? `${baseName} · time ${timeIndex + 1}/${timepoints}` : baseName,
      description: `${nx}×${ny}×${nz} · NIfTI import${timepoints > 1 ? ` · timepoint ${timeIndex + 1}/${timepoints}` : ''}`,
      modality: 'OT',
      slices: nz,
      width: nx,
      height: ny,
      pixelSpacing: [...pixelSpacing],
      sliceThickness,
      tr: 0, te: 0,
      sequence: '',
      firstIPP: [...firstIPP],
      lastIPP: [...lastIPP],
      orientation: [...orientation],
      group: null,
      hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false,
      hasStats: false, hasAnalysis: false, hasMaskRaw: false, hasRaw: true,
      _spacingKnown: spacingKnown,
      _niftiVersion: version,
      _niftiSpatialUnit: spatialUnit.name,
      _niftiSpatialUnitCode: spatialUnit.code,
      _niftiSpatialAffineLps: affineFromHeader ? affineFromHeader.map(row => [...row]) : null,
      _niftiSpatialAffineUnit: spatialUnit.name,
      _niftiValueRange: { ...valueRange },
    };
    if (timepoints > 1) {
      entry._niftiTimeSeriesId = timeSeriesId;
      entry._niftiTimeIndex = timeIndex;
      entry._niftiTimepoints = timepoints;
      entry._niftiTemporalSpacing = temporalSpacing;
      entry._niftiTemporalUnit = temporalUnit.name;
      entry._niftiTemporalUnitCode = temporalUnit.code;
      entry._niftiTemporalSpacingKnown = temporalUnit.known && temporalSpacing > 0;
      entry._niftiTimeOffset = timeOffset;
    }
    if (sourceFile) entry.sourceFiles = [sourceFile];
    return {
      entry,
      sliceCanvases: sliceCanvasesForNifti(
        rawVolume, voxelAt, timeIndex * voxelsPerTimepoint, nx, ny, nz, scl_slope, scl_inter, valueRange,
      ),
      rawVolume,
    };
  });
}

/** Backwards-compatible 3D NIfTI entrypoint. Use parseNIfTISeries for 4D inputs. */
export async function parseNIfTI(file, onProgress = () => {}) {
  const results = await parseNIfTISeries(file, onProgress, { allowTimeSeries: false });
  return results?.[0] || null;
}
