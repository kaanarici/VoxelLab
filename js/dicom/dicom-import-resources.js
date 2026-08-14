// Resource limits for local DICOM ingestion. These cover the browser-owned
// data that remains live while the shared viewer stack is assembled. They are
// deliberately constants rather than caller options: an untrusted import must
// not be able to widen its own acquisition budget.

export const DICOM_IMPORT_LIMITS = Object.freeze({
  maxFiles: 8_192,
  maxFileBytes: 256 * 1024 * 1024,
  maxInputBytes: 512 * 1024 * 1024,
  maxRows: 8_192,
  maxColumns: 8_192,
  maxFramesPerInstance: 4_096,
  maxDatasets: 8_192,
  maxVoxelsPerSlice: 16 * 1024 * 1024,
  maxTotalVoxels: 32 * 1024 * 1024,
  maxWorkingSetBytes: 512 * 1024 * 1024,
});

function resourceError(detail) {
  const error = new Error(`DICOM import resource limit: ${detail}`);
  error.dicomResourceLimit = true;
  return error;
}

function safeAdd(left, right, label) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0) {
    throw resourceError(`${label} is not a safe integer`);
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw resourceError(`${label} overflows safe integer precision`);
  return total;
}

function safeMultiply(left, right, label) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw resourceError(`${label} is not a safe integer`);
  }
  const total = left * right;
  if (!Number.isSafeInteger(total)) throw resourceError(`${label} overflows safe integer precision`);
  return total;
}

function fileLabel(file, index = 0) {
  return String(file?.name || `file ${index + 1}`).replaceAll(/[\r\n]/g, ' ').slice(0, 160);
}

function strictPositiveInteger(meta, key, fallback) {
  const source = meta?.[key];
  const value = source == null ? fallback : (Array.isArray(source) ? source[0] : source);
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw resourceError(`${key} must be a positive safe integer`);
  }
  return number;
}

function viewByteLength(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== 'string') return 0;
  // This is deliberately conservative and does not validate Base64. The
  // actual decoder still validates it before pixels are used.
  return safeMultiply(Math.ceil(value.length / 4), 3, 'inline binary byte count');
}

function pixelDataByteLength(pixelData) {
  if (!pixelData) return 0;
  const values = Array.isArray(pixelData.Value) ? pixelData.Value : [pixelData.Value ?? pixelData.InlineBinary];
  return values.reduce((total, value) => safeAdd(total, viewByteLength(value), 'pixel data byte count'), 0);
}

function itemSourceByteLength(item) {
  const explicit = Number(item?.sourceByteLength);
  if (Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
  const pixelBytes = item?.pixels?.byteLength ?? viewByteLength(item?.encodedValue);
  return Number.isSafeInteger(pixelBytes) && pixelBytes >= 0
    ? pixelBytes
    : pixelDataByteLength(item?.pixelData);
}

export function assertDICOMInputFiles(files) {
  if (!Array.isArray(files)) throw resourceError('selected files are not an array');
  if (files.length > DICOM_IMPORT_LIMITS.maxFiles) {
    throw resourceError(`${files.length} files exceeds the ${DICOM_IMPORT_LIMITS.maxFiles} file limit`);
  }
  let total = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const bytes = Number(file?.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw resourceError(`${fileLabel(file, index)} has an invalid declared file size`);
    }
    if (bytes > DICOM_IMPORT_LIMITS.maxFileBytes) {
      throw resourceError(`${fileLabel(file, index)} exceeds the ${DICOM_IMPORT_LIMITS.maxFileBytes} byte per-file limit`);
    }
    total = safeAdd(total, bytes, 'declared input byte count');
    if (total > DICOM_IMPORT_LIMITS.maxInputBytes) {
      throw resourceError(`selected files exceed the ${DICOM_IMPORT_LIMITS.maxInputBytes} byte input limit`);
    }
  }
  return total;
}

export function assertDICOMActualFileBytes(byteLength, file, index = 0) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw resourceError(`${fileLabel(file, index)} returned an invalid byte length`);
  }
  if (byteLength > DICOM_IMPORT_LIMITS.maxFileBytes) {
    throw resourceError(`${fileLabel(file, index)} exceeds the ${DICOM_IMPORT_LIMITS.maxFileBytes} byte per-file limit`);
  }
  return byteLength;
}

export function addDICOMActualInputBytes(totalBytes, byteLength, file, index = 0) {
  const bytes = assertDICOMActualFileBytes(byteLength, file, index);
  const total = safeAdd(totalBytes, bytes, 'actual input byte count');
  if (total > DICOM_IMPORT_LIMITS.maxInputBytes) {
    throw resourceError(`selected files exceed the ${DICOM_IMPORT_LIMITS.maxInputBytes} byte input limit`);
  }
  return total;
}

export function dicomShape(meta) {
  const rows = strictPositiveInteger(meta, 'Rows');
  const columns = strictPositiveInteger(meta, 'Columns');
  const frames = strictPositiveInteger(meta, 'NumberOfFrames', 1);
  if (rows > DICOM_IMPORT_LIMITS.maxRows || columns > DICOM_IMPORT_LIMITS.maxColumns) {
    throw resourceError(`image dimensions ${columns}×${rows} exceed the ${DICOM_IMPORT_LIMITS.maxColumns}×${DICOM_IMPORT_LIMITS.maxRows} geometry limit`);
  }
  if (frames > DICOM_IMPORT_LIMITS.maxFramesPerInstance) {
    throw resourceError(`NumberOfFrames ${frames} exceeds the ${DICOM_IMPORT_LIMITS.maxFramesPerInstance} frame limit`);
  }
  const voxelsPerSlice = safeMultiply(rows, columns, 'slice voxel count');
  if (voxelsPerSlice > DICOM_IMPORT_LIMITS.maxVoxelsPerSlice) {
    throw resourceError(`slice voxel count ${voxelsPerSlice} exceeds the ${DICOM_IMPORT_LIMITS.maxVoxelsPerSlice} voxel limit`);
  }
  return { rows, columns, frames, voxelsPerSlice };
}

export function assertDICOMDatasetMetadata(datasets) {
  if (!Array.isArray(datasets) || !datasets.length) throw resourceError('series contains no image datasets');
  if (datasets.length > DICOM_IMPORT_LIMITS.maxDatasets) {
    throw resourceError(`${datasets.length} image datasets exceeds the ${DICOM_IMPORT_LIMITS.maxDatasets} dataset limit`);
  }
  for (const item of datasets) {
    const shape = dicomShape(item?.meta || item);
    const instanceVoxels = safeMultiply(shape.voxelsPerSlice, shape.frames, 'instance voxel count');
    if (instanceVoxels > DICOM_IMPORT_LIMITS.maxTotalVoxels) {
      throw resourceError(`instance voxel count ${instanceVoxels} exceeds the ${DICOM_IMPORT_LIMITS.maxTotalVoxels} voxel limit`);
    }
  }
}

export function assertDICOMSeriesWorkingSet(datasets) {
  if (!Array.isArray(datasets) || !datasets.length) throw resourceError('series contains no image datasets');
  if (datasets.length > DICOM_IMPORT_LIMITS.maxDatasets) {
    throw resourceError(`${datasets.length} image datasets exceeds the ${DICOM_IMPORT_LIMITS.maxDatasets} dataset limit`);
  }
  const shape = dicomShape(datasets[0]?.meta || datasets[0]);
  const totalVoxels = safeMultiply(shape.voxelsPerSlice, datasets.length, 'series voxel count');
  if (totalVoxels > DICOM_IMPORT_LIMITS.maxTotalVoxels) {
    throw resourceError(`series voxel count ${totalVoxels} exceeds the ${DICOM_IMPORT_LIMITS.maxTotalVoxels} voxel limit`);
  }

  let retainedInputBytes = 0;
  const sourceIds = new Set();
  for (let index = 0; index < datasets.length; index += 1) {
    const item = datasets[index];
    dicomShape(item?.meta || item);
    const sourceId = item?.sourceId ?? item?.file ?? `dataset:${index}`;
    if (sourceIds.has(sourceId)) continue;
    sourceIds.add(sourceId);
    retainedInputBytes = safeAdd(retainedInputBytes, itemSourceByteLength(item), 'retained source byte count');
  }

  // Peak construction memory includes the full provisional Float32 volume,
  // its possible trim copy after bad slices, retained RGBA canvas backing,
  // one ImageData plane, a decoded native plane, and conservative DOM object
  // overhead. This is assessed before either the Float32Array or canvases.
  const rawVolumeBytes = safeMultiply(totalVoxels, Float32Array.BYTES_PER_ELEMENT, 'normalized raw byte count');
  const canvasBytes = safeMultiply(totalVoxels, 4, 'canvas backing byte count');
  const imageDataBytes = safeMultiply(shape.voxelsPerSlice, 4, 'ImageData byte count');
  const decodedPlaneBytes = safeMultiply(shape.voxelsPerSlice, 2, 'decoded plane byte count');
  const canvasOverhead = safeMultiply(datasets.length, 4 * 1024, 'canvas object overhead');
  const parts = [retainedInputBytes, rawVolumeBytes, rawVolumeBytes, canvasBytes, imageDataBytes, decodedPlaneBytes, canvasOverhead];
  let workingSetBytes = 0;
  for (const part of parts) workingSetBytes = safeAdd(workingSetBytes, part, 'DICOM working-set byte count');
  if (workingSetBytes > DICOM_IMPORT_LIMITS.maxWorkingSetBytes) {
    throw resourceError(`modeled working set ${workingSetBytes} bytes exceeds the ${DICOM_IMPORT_LIMITS.maxWorkingSetBytes} byte limit`);
  }
  return { ...shape, totalVoxels, retainedInputBytes, workingSetBytes };
}

export function isDICOMResourceLimit(error) {
  return Boolean(error?.dicomResourceLimit);
}
