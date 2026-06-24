// NIfTI parsing lives beside the DICOM import path but stays isolated because
// its header, affine, and RAS/LPS handling have different correctness rules.

import { PAKO_ESM_URL } from '../core/dependencies.js';
import { DEFAULT_IOP, normalize3 } from '../core/geometry.js';

let pako = null;

async function ensurePako() {
  if (pako) return pako;
  const mod = await import(PAKO_ESM_URL);
  pako = mod;
  return pako;
}

async function inflateGzipBytes(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const pk = await ensurePako();
  return pk.inflate(bytes);
}

const NIFTI_TYPES = Object.freeze({
  2: [1, 'getUint8', Uint8Array],
  4: [2, 'getInt16', Int16Array],
  8: [4, 'getInt32', Int32Array],
  16: [4, 'getFloat32', Float32Array],
  64: [8, 'getFloat64', Float64Array],
  512: [2, 'getUint16', Uint16Array],
});

const NIFTI_SPATIAL_UNITS = Object.freeze({
  1: { name: 'meter', mm: 1000 },
  2: { name: 'mm', mm: 1 },
  3: { name: 'micron', mm: 0.001 },
});

const NATIVE_LITTLE_ENDIAN = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;

function niftiVoxelReader(buffer, view, offset, datatype, littleEndian, length) {
  const [bytes, getter, TypedArray] = NIFTI_TYPES[datatype] || [];
  if (!bytes) return null;
  if (littleEndian && NATIVE_LITTLE_ENDIAN && offset % bytes === 0) {
    const typed = new TypedArray(buffer, offset, length);
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

/** Parse a local NIfTI or NIfTI.gz file into the same viewer-ready series result shape as DICOM. */
export async function parseNIfTI(file, onProgress = () => {}) {
  onProgress('reading', file.name);
  let ab = await file.arrayBuffer();

  if (/\.gz$/i.test(file.name || '')) {
    const decompressed = await inflateGzipBytes(new Uint8Array(ab));
    ab = decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
  }

  // NIfTI-1 header (348 bytes)
  const view = new DataView(ab);
  const sizeof_hdr = view.getInt32(0, true);
  const littleEndian = sizeof_hdr === 348;
  if (!littleEndian && view.getInt32(0, false) !== 348) return null;

  const dims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, littleEndian));
  const dimCount = Math.max(0, dims[0] || 0);
  const extraDims = dims.slice(4, Math.min(8, dimCount + 1)).filter(value => Number(value || 0) > 1);
  if (extraDims.length) {
    throw new Error('4D/time-series or higher-dimensional NIfTI files are not supported yet; split or export a single 3D volume before importing.');
  }
  const nx = dims[1], ny = dims[2], nz = dims[3] || 1;
  const datatype = view.getInt16(70, littleEndian);
  const vox_offset = view.getFloat32(108, littleEndian);
  const pixdim = [];
  for (let i = 0; i < 8; i++) pixdim.push(view.getFloat32(76 + i * 4, littleEndian));
  const spatialUnit = niftiSpatialUnit(view.getUint8(123));
  const qform_code = view.getInt16(252, littleEndian);
  const sform_code = view.getInt16(254, littleEndian);
  const quatern_b = view.getFloat32(256, littleEndian);
  const quatern_c = view.getFloat32(260, littleEndian);
  const quatern_d = view.getFloat32(264, littleEndian);
  const qoffset_x = view.getFloat32(268, littleEndian);
  const qoffset_y = view.getFloat32(272, littleEndian);
  const qoffset_z = view.getFloat32(276, littleEndian);
  const srow_x = Array.from({ length: 4 }, (_, i) => view.getFloat32(280 + i * 4, littleEndian));
  const srow_y = Array.from({ length: 4 }, (_, i) => view.getFloat32(296 + i * 4, littleEndian));
  const srow_z = Array.from({ length: 4 }, (_, i) => view.getFloat32(312 + i * 4, littleEndian));

  // Rescale slope/intercept from header (may be 0/0 meaning identity)
  let scl_slope = view.getFloat32(112, littleEndian);
  let scl_inter = view.getFloat32(116, littleEndian);
  if (scl_slope === 0) { scl_slope = 1; scl_inter = 0; }

  onProgress('converting', `${nx}×${ny}×${nz}`);

  const offset = Math.round(vox_offset);
  const totalVoxels = nx * ny * nz;
  const bytesPerVoxel = NIFTI_TYPES[datatype]?.[0] || 0;
  if (!(totalVoxels > 0) || !(bytesPerVoxel > 0)) return null;
  if (offset < 0 || offset + totalVoxels * bytesPerVoxel > ab.byteLength) return null;
  const voxelAt = niftiVoxelReader(ab, view, offset, datatype, littleEndian, totalVoxels);
  if (!voxelAt) return null;

  // Read payload values once; large .nii.gz imports can otherwise spend most
  // of their time re-decoding the same DataView offsets for display slices.
  const step = Math.max(1, Math.floor(totalVoxels / 50000));
  const samples = [];
  const rawVolume = new Float32Array(totalVoxels);
  let vMin = Infinity, vMax = -Infinity;
  let nextSample = 0;
  for (let i = 0; i < totalVoxels; i++) {
    const v = voxelAt(i) * scl_slope + scl_inter;
    rawVolume[i] = v;
    if (i === nextSample) {
      samples.push(v);
      nextSample += step;
    }
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  samples.sort((a, b) => a - b);
  const mn = samples[Math.floor(samples.length * 0.02)];
  const mx = samples[Math.floor(samples.length * 0.98)];
  const displayInv = 255 / (mx - mn || 1);
  const normInv = 1 / (vMax - vMin || 1);

  const fallbackPixelSpacing = [
    toMillimeters(pixdim[2], spatialUnit),
    toMillimeters(pixdim[1], spatialUnit),
  ];
  const fallbackSliceThickness = toMillimeters(pixdim[3], spatialUnit);
  const fallbackLastIPP = spatialUnit.known ? [0, 0, (nz - 1) * fallbackSliceThickness] : [0, 0, 0];
  const affineFromHeader = (() => {
    if (sform_code > 0) return affineToMillimeters(niftiRasToLps([srow_x, srow_y, srow_z]), spatialUnit);
    if (qform_code <= 0) return null;
    const b = quatern_b;
    const c = quatern_c;
    const d = quatern_d;
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
    const qfac = pixdim[0] < 0 ? -1 : 1;
    const dx = pixdim[1] || 0;
    const dy = pixdim[2] || 0;
    const dz = pixdim[3] || 0;
    const abTerm = a * b, ac = a * c, ad = a * d;
    const bb = b * b, bc = b * c, bd = b * d;
    const cc = c * c, cd = c * d, dd = d * d;
    return affineToMillimeters(niftiRasToLps([
      [(a * a + bb - cc - dd) * dx, 2 * (bc - ad) * dy, qfac * 2 * (bd + ac) * dz, qoffset_x],
      [2 * (bc + ad) * dx, (a * a + cc - bb - dd) * dy, qfac * 2 * (cd - abTerm) * dz, qoffset_y],
      [2 * (bd - ac) * dx, qfac * 2 * (cd + abTerm) * dy, qfac * (a * a + dd - bb - cc) * dz, qoffset_z],
    ]), spatialUnit);
  })();
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

  const sliceCanvases = [];
  for (let z = 0; z < nz; z++) {
    const canvas = document.createElement('canvas');
    canvas.width = nx; canvas.height = ny;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(nx, ny);
    const d = img.data;
    const base = z * nx * ny;
    for (let i = 0; i < nx * ny; i++) {
      const index = base + i;
      const raw = rawVolume[index];
      rawVolume[index] = Math.max(0, Math.min(1, (raw - vMin) * normInv));
      let v = Math.round((raw - mn) * displayInv);
      if (v < 0) v = 0; if (v > 255) v = 255;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    sliceCanvases.push(canvas);
  }

  const slug = `nifti_${Date.now().toString(36)}`;
  const entry = {
    slug,
    name: file.name.replace(/\.nii(\.gz)?$/i, ''),
    description: `${nx}×${ny}×${nz} · NIfTI import`,
    modality: 'OT',
    slices: nz,
    width: nx,
    height: ny,
    pixelSpacing,
    sliceThickness,
    tr: 0, te: 0,
    sequence: '',
    firstIPP,
    lastIPP,
    orientation,
    group: null,
    hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false,
    hasStats: false, hasAnalysis: false, hasMaskRaw: false, hasRaw: true,
    _spacingKnown: spacingKnown,
    _niftiSpatialUnit: spatialUnit.name,
    _niftiSpatialUnitCode: spatialUnit.code,
  };
  const sourceFile = sourceFileName(file);
  if (sourceFile) entry.sourceFiles = [sourceFile];

  return { entry, sliceCanvases, rawVolume };
}
