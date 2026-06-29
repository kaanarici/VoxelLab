import { isKnownLengthUnit, normalizeLengthUnit } from '../core/physical-units.js';
import { isOmeZarrFile, microscopyFilePath } from './microscopy-file-kinds.js';
import { normalizeOmeZarrMetadata, omeZarrMetadataIssueLabels } from './microscopy-zarr-metadata.js';
import { buildMicroscopySeriesResults } from './microscopy-import.js';

const OME_ZARR_CHUNK_LOAD_CONCURRENCY = 8;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function pathForFile(file = {}) {
  return normalizePath(microscopyFilePath(file));
}

function fileMap(files) {
  if (files instanceof Map) return files;
  const map = new Map();
  for (const file of Array.from(files || [])) {
    const path = pathForFile(file);
    if (path) map.set(path, file);
  }
  return map;
}

function parentPath(path, suffix) {
  return path.endsWith(suffix) ? path.slice(0, -suffix.length).replace(/\/$/, '') : '';
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

async function textForFile(file) {
  if (typeof file.text === 'function') return file.text();
  const buffer = await file.arrayBuffer();
  return new TextDecoder('utf-8').decode(buffer);
}

async function bytesForFile(file) {
  const buffer = await file.arrayBuffer();
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function omeAttributes(input) {
  if (input?.ome && typeof input.ome === 'object') return input.ome;
  if (input?.attributes?.ome && typeof input.attributes.ome === 'object') return input.attributes.ome;
  return input && typeof input === 'object' ? input : {};
}

function isOmeZarrRootMetadata(input) {
  const attrs = omeAttributes(input);
  return Array.isArray(attrs.multiscales);
}

function zarrArrayPath(rootPath, datasetPath, fileName) {
  return joinPath(rootPath, datasetPath, fileName);
}

export { isOmeZarrFile };

function dtypeInfo(dtype) {
  const match = String(dtype || '').match(/^([<>|])([ui])([12])$/i);
  if (!match) return null;
  const bytes = Number(match[3]);
  if (bytes > 1 && match[1] === '|') return null;
  return {
    bytes,
    bits: bytes * 8,
    littleEndian: match[1] !== '>',
    sampleFormat: match[2].toLowerCase() === 'i' ? 2 : 1,
  };
}

function validateLevelZeroArray(arrayMeta = {}) {
  const shape = Array.isArray(arrayMeta.shape) ? arrayMeta.shape.map(Number) : [];
  const chunks = Array.isArray(arrayMeta.chunks) ? arrayMeta.chunks.map(Number) : [];
  if (arrayMeta.zarr_format !== 2) throw new Error('OME-Zarr image loading currently supports zarr_format=2 only.');
  if (!shape.length || shape.length !== chunks.length
    || shape.some(value => !(value > 0)) || chunks.some(value => !(value > 0))) {
    throw new Error('OME-Zarr image loading requires valid shape/chunks metadata.');
  }
  if (arrayMeta.compressor != null) throw new Error('OME-Zarr image loading currently supports uncompressed chunks only.');
  if (Array.isArray(arrayMeta.filters) && arrayMeta.filters.length) throw new Error('OME-Zarr image loading does not support zarr filters yet.');
  if (arrayMeta.filters != null && !Array.isArray(arrayMeta.filters)) throw new Error('OME-Zarr image loading does not support zarr filters yet.');
  if (String(arrayMeta.order || '').toUpperCase() !== 'C') throw new Error('OME-Zarr image loading currently supports explicit C-order chunks only.');
  const dtype = dtypeInfo(arrayMeta.dtype);
  if (!dtype) throw new Error(`OME-Zarr image loading supports uint8/int8/uint16/int16 chunks only; found dtype=${arrayMeta.dtype || 'unknown'}.`);
  return { shape, chunks, dtype };
}

function chunkPathFor(rootPath, datasetPath, arrayMeta, chunkCoords) {
  const separator = arrayMeta.dimension_separator === '/' ? '/' : '.';
  return zarrArrayPath(rootPath, datasetPath, chunkCoords.join(separator));
}

function cOrderStrides(shape) {
  const strides = new Array(shape.length);
  let stride = 1;
  for (let i = shape.length - 1; i >= 0; i -= 1) {
    strides[i] = stride;
    stride *= shape[i];
  }
  return strides;
}

function pixelAt(view, index, dtype) {
  const offset = index * dtype.bytes;
  if (dtype.bits === 8) return dtype.sampleFormat === 2 ? view.getInt8(offset) : view.getUint8(offset);
  return dtype.sampleFormat === 2 ? view.getInt16(offset, dtype.littleEndian) : view.getUint16(offset, dtype.littleEndian);
}

function chunkKey(chunkCoords) {
  return chunkCoords.join(',');
}

function chunkShapeAt(shape, chunks, chunkCoords) {
  return chunks.map((chunkSize, axis) =>
    Math.min(chunkSize, shape[axis] - (chunkCoords[axis] * chunkSize)));
}

async function loadChunkTiles(chunkStore, chunkTiles) {
  if (!chunkTiles.length) return;
  let nextIndex = 0;
  const workerCount = Math.min(OME_ZARR_CHUNK_LOAD_CONCURRENCY, chunkTiles.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < chunkTiles.length) {
      const index = nextIndex;
      nextIndex += 1;
      await chunkStore.load(chunkTiles[index]);
    }
  }));
}

function makeChunkStore({ filesByPath, rootPath, datasetPath, arrayMeta, shape, chunks, dtype }) {
  const cache = new Map();
  return {
    async load(chunkCoords) {
      const key = chunkKey(chunkCoords);
      if (cache.has(key)) return cache.get(key);
      const path = chunkPathFor(rootPath, datasetPath, arrayMeta, chunkCoords);
      const file = filesByPath.get(path);
      if (!file) throw new Error(`OME-Zarr level 0 chunk is missing: ${path}`);
      const bytes = await bytesForFile(file);
      const chunkShape = chunkShapeAt(shape, chunks, chunkCoords);
      const expectedBytes = chunkShape.reduce((product, value) => product * value, 1) * dtype.bytes;
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(`OME-Zarr level 0 chunk byte length does not match the declared chunk shape: ${path}`);
      }
      const entry = {
        shape: chunkShape,
        strides: cOrderStrides(chunkShape),
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
      cache.set(key, entry);
      return entry;
    },
    get(chunkCoords) {
      return cache.get(chunkKey(chunkCoords));
    },
  };
}

function axisIndex(axes, name) {
  return axes.findIndex(axis => String(axis.name || '').toLowerCase() === name);
}

function axisScale(axes, name) {
  const axis = axes[axisIndex(axes, name)];
  return axis?.known && axis.unit ? Number(axis.scale || 0) : 0;
}

function axisSize(axes, name, fallback = 1) {
  const index = axisIndex(axes, name);
  return index >= 0 ? Math.max(1, Number(axes[index]?.size || fallback)) : fallback;
}

function spatialUnit(axes) {
  const units = spatialUnits(axes);
  return units.x || units.y || units.z || '';
}

function spatialUnits(axes) {
  const units = {};
  for (const name of ['x', 'y', 'z']) {
    const unit = axes[axisIndex(axes, name)]?.unit;
    if (unit) units[name] = unit;
  }
  return units;
}

function preferredSpatialUnit(units) {
  for (const name of ['x', 'y', 'z']) {
    if (isKnownLengthUnit(units[name])) return normalizeLengthUnit(units[name]);
  }
  return '';
}

async function planePixelsFromChunks(chunkStore, shape, chunks, axes, dtype, { c, z, t }) {
  const xIndex = axisIndex(axes, 'x');
  const yIndex = axisIndex(axes, 'y');
  if (xIndex < 0 || yIndex < 0) throw new Error('OME-Zarr image loading requires x and y axes.');
  const width = shape[xIndex];
  const height = shape[yIndex];
  const baseCoords = new Array(shape.length).fill(0);
  const cIndex = axisIndex(axes, 'c');
  const zIndex = axisIndex(axes, 'z');
  const tIndex = axisIndex(axes, 't');
  if (cIndex >= 0) baseCoords[cIndex] = c;
  if (zIndex >= 0) baseCoords[zIndex] = z;
  if (tIndex >= 0) baseCoords[tIndex] = t;

  const baseChunkCoords = baseCoords.map((value, axis) => Math.floor(value / chunks[axis]));
  const chunkTiles = [];
  for (let y = 0; y < height; y += chunks[yIndex]) {
    for (let x = 0; x < width; x += chunks[xIndex]) {
      const chunkCoords = baseChunkCoords.slice();
      chunkCoords[yIndex] = Math.floor(y / chunks[yIndex]);
      chunkCoords[xIndex] = Math.floor(x / chunks[xIndex]);
      chunkTiles.push(chunkCoords);
    }
  }
  await loadChunkTiles(chunkStore, chunkTiles);

  const pixels = new Float32Array(width * height);
  for (const chunkCoords of chunkTiles) {
    const chunk = chunkStore.get(chunkCoords);
    const xStart = chunkCoords[xIndex] * chunks[xIndex];
    const yStart = chunkCoords[yIndex] * chunks[yIndex];
    const xEnd = Math.min(width, xStart + chunk.shape[xIndex]);
    const yEnd = Math.min(height, yStart + chunk.shape[yIndex]);
    let planeOffset = 0;
    for (let axis = 0; axis < shape.length; axis += 1) {
      if (axis !== xIndex && axis !== yIndex) {
        planeOffset += (baseCoords[axis] - chunkCoords[axis] * chunks[axis]) * chunk.strides[axis];
      }
    }
    for (let y = yStart; y < yEnd; y += 1) {
      const rowOffset = planeOffset + (y - yStart) * chunk.strides[yIndex];
      for (let x = xStart; x < xEnd; x += 1) {
        pixels[y * width + x] = pixelAt(chunk.view, rowOffset + (x - xStart) * chunk.strides[xIndex], dtype);
      }
    }
  }
  return { width, height, pixels };
}

export function omeZarrStatusText(result, { loaded = false, reason = '' } = {}) {
  const metadata = result?.metadata || {};
  const axes = (metadata.axes || []).map(axis => `${String(axis.name || '').toUpperCase()} ${axis.size || 1}`).join(' · ');
  const pixel = metadata.pixel?.type && metadata.pixel.type !== 'unknown' ? metadata.pixel.type : 'unknown pixel type';
  const channelCount = metadata.channels?.length || 1;
  const suffix = loaded
    ? 'Loaded local uncompressed level-0 chunk data.'
    : `Image loading is unavailable for this selection. No image series was added.${reason ? ` ${reason}` : ''}`;
  return `OME-Zarr metadata recognized: ${pixel}, ${channelCount} channel${channelCount === 1 ? '' : 's'}${axes ? `, ${axes}` : ''}. ${suffix}`;
}

export async function discoverOmeZarrMetadata(files, { normalize = normalizeOmeZarrMetadata } = {}) {
  const filesByPath = fileMap(files);
  const entries = new Map();
  for (const [path, file] of filesByPath) {
    if (!path.endsWith('.zattrs') && !path.endsWith('.zarray') && !path.endsWith('.zmetadata') && !path.endsWith('zarr.json')) continue;
    try {
      const json = JSON.parse(await textForFile(file));
      if (path.endsWith('.zmetadata')) {
        const rootPath = parentPath(path, '.zmetadata');
        const metadata = json && typeof json.metadata === 'object' && !Array.isArray(json.metadata) ? json.metadata : {};
        for (const [relativePath, metadataJson] of Object.entries(metadata)) {
          const consolidatedPath = joinPath(rootPath, relativePath);
          if (!entries.has(consolidatedPath)) entries.set(consolidatedPath, metadataJson);
        }
      } else {
        entries.set(path, json);
      }
    } catch (error) {
      throw new Error(`Could not parse OME-Zarr metadata ${path || file?.name || ''}: ${error.message}`);
    }
  }

  const root = [...entries.entries()].find(([, json]) => isOmeZarrRootMetadata(json));
  if (!root) return null;

  const [rootMetadataPath, rootJson] = root;
  const rootPath = rootMetadataPath.endsWith('.zattrs')
    ? parentPath(rootMetadataPath, '.zattrs')
    : parentPath(rootMetadataPath, 'zarr.json');
  const multiscales = omeAttributes(rootJson).multiscales || [];
  const datasets = Array.isArray(multiscales[0]?.datasets) ? multiscales[0].datasets : [];
  const arrayMetadataByPath = {};
  const missingArrayMetadata = [];

  for (const dataset of datasets) {
    const datasetPath = normalizePath(dataset?.path || '');
    if (!datasetPath) continue;
    const v2Path = zarrArrayPath(rootPath, datasetPath, '.zarray');
    const v3Path = zarrArrayPath(rootPath, datasetPath, 'zarr.json');
    const arrayMeta = entries.get(v2Path) || entries.get(v3Path);
    if (arrayMeta) arrayMetadataByPath[datasetPath] = arrayMeta;
    else missingArrayMetadata.push(datasetPath);
  }

  const metadata = normalize(rootJson, { arrayMetadataByPath });
  if (missingArrayMetadata.length) {
    metadata.warnings.push(...missingArrayMetadata.map((path) => `array_metadata_missing_${path}`));
  }

  return {
    rootPath,
    rootMetadataPath,
    arrayMetadataByPath,
    missingArrayMetadata,
    metadata,
    filesByPath,
  };
}

export async function buildOmeZarrSeriesResults(discovery, files) {
  const metadata = discovery?.metadata;
  const levelZero = metadata?.levels?.[0];
  if (!metadata || metadata.errors?.length) throw new Error('OME-Zarr metadata is incomplete.');
  const version = String(metadata.multiscales?.version || '');
  if (!version.startsWith('0.4')) {
    throw new Error('OME-Zarr zarr v2 image loading currently supports OME-NGFF 0.4-style metadata only.');
  }
  if (!levelZero?.path) throw new Error('OME-Zarr level 0 path is missing.');

  const arrayMeta = discovery.arrayMetadataByPath?.[levelZero.path];
  const { shape, chunks, dtype } = validateLevelZeroArray(arrayMeta);
  const chunkStore = makeChunkStore({
    filesByPath: discovery.filesByPath || fileMap(files),
    rootPath: discovery.rootPath,
    datasetPath: levelZero.path,
    arrayMeta,
    shape,
    chunks,
    dtype,
  });
  const axes = metadata.axes || [];
  const sizeC = axisSize(axes, 'c');
  const sizeZ = axisSize(axes, 'z');
  const sizeT = axisSize(axes, 't');
  const pages = [];
  const planePositions = [];
  for (let t = 0; t < sizeT; t += 1) {
    for (let c = 0; c < sizeC; c += 1) {
      for (let z = 0; z < sizeZ; z += 1) {
        pages.push({
          ...await planePixelsFromChunks(chunkStore, shape, chunks, axes, dtype, { c, z, t }),
          bitsPerSample: dtype.bits,
          sampleFormat: dtype.sampleFormat,
          samplesPerPixel: 1,
          littleEndian: dtype.littleEndian,
          photometric: 1,
        });
        planePositions.push({ c, z, t });
      }
    }
  }

  const units = spatialUnits(axes);
  const unit = preferredSpatialUnit(units) || spatialUnit(axes);
  const rootName = (discovery.rootPath.split('/').pop() || 'ome-zarr').replace(/\.zarr$/i, '') || 'ome-zarr';
  return buildMicroscopySeriesResults(pages, {
    source: 'OME-Zarr',
    sizeX: axisSize(axes, 'x', pages[0]?.width || 1),
    sizeY: axisSize(axes, 'y', pages[0]?.height || 1),
    sizeZ,
    sizeC,
    sizeT,
    dimensionOrder: 'XYZCT',
    physicalSizeX: axisScale(axes, 'x'),
    physicalSizeY: axisScale(axes, 'y'),
    physicalSizeZ: axisScale(axes, 'z'),
    physicalUnit: unit || 'mm',
    physicalUnits: units,
    channels: metadata.channels || [],
    levels: metadata.levels || [],
    levelAxes: axes,
    levelArrayMetadataByPath: discovery.arrayMetadataByPath || {},
    sourceFiles: [discovery.rootPath],
    warnings: metadata.warnings || [],
  }, rootName, `ome_zarr_${Date.now().toString(36)}`);
}

export async function parseOmeZarrFiles(files, onProgress = () => {}) {
  onProgress('reading', 'OME-Zarr metadata');
  const discovery = await discoverOmeZarrMetadata(files);
  if (!discovery) return null;
  if (discovery.metadata.errors.length) {
    throw new Error(`OME-Zarr metadata is incomplete: ${omeZarrMetadataIssueLabels(discovery.metadata.errors).slice(0, 3).join(', ')}`);
  }
  try {
    onProgress('reading', 'OME-Zarr level 0 chunks');
    const results = await buildOmeZarrSeriesResults(discovery);
    return { ...discovery, results, status: omeZarrStatusText(discovery, { loaded: true }) };
  } catch (error) {
    return { ...discovery, results: [], status: omeZarrStatusText(discovery, { reason: error.message }) };
  }
}
