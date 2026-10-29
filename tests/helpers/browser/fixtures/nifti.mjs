import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NIFTI_HEADER_BYTES = 352;

function niftiHeader(dims, xyztUnits, pixdim, voxelCount) {
  const buffer = Buffer.alloc(NIFTI_HEADER_BYTES + voxelCount);
  buffer.writeInt32LE(348, 0);
  buffer.write('n+1\0', 344, 'ascii');
  buffer.writeInt16LE(dims.length, 40);
  dims.forEach((size, index) => buffer.writeInt16LE(size, 42 + index * 2));
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  pixdim.forEach((spacing, index) => buffer.writeFloatLE(spacing, 80 + index * 4));
  buffer.writeFloatLE(NIFTI_HEADER_BYTES, 108);
  buffer.writeUInt8(xyztUnits, 123);
  return buffer;
}

export function tinyNiftiBuffer({ xyztUnits = 2, pixdim = [1, 1, 1] } = {}) {
  const buffer = niftiHeader([2, 2, 2], xyztUnits, pixdim, 8);
  for (let index = 0; index < 8; index += 1) buffer[NIFTI_HEADER_BYTES + index] = index * 16;
  return buffer;
}

export async function writeTinyNifti(path, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, tinyNiftiBuffer(options));
}

export async function writeTiny4dNifti(path, {
  xyztUnits = 10,
  pixdim = [1, 1, 1, 2],
  timeOriginSeconds = 0.5,
} = {}) {
  const buffer = niftiHeader([2, 2, 2, 2], xyztUnits, pixdim, 16);
  buffer.writeFloatLE(timeOriginSeconds, 136);
  for (let index = 0; index < 16; index += 1) buffer[NIFTI_HEADER_BYTES + index] = index * 8;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}
