import { isKnownLengthUnit, normalizeLengthUnit } from '../core/physical-units.js';
import { isOmeZarrFile, microscopyFilePath } from './microscopy-file-kinds.js';
import { normalizeOmeZarrMetadata, omeZarrMetadataIssueLabels } from './microscopy-zarr-metadata.js';
import { buildMicroscopySeriesResults } from './microscopy-import.js';
import {
  MAX_OME_ZARR_ENCODED_CHUNK_BYTES,
  omeZarrResourceBudget,
  readBoundedOmeZarrByteStream,
} from './zarr/zarr-resource-budget.js';
import { decodeZarrChunk, describeZarrCodec } from './zarr/zarr-codecs.js';
import { parseZarrArrayMeta, zarrArrayMetaForDataset, zarrChunkPath, zarrPixelAt, zarrScalarArrayType } from './zarr/zarr-array-meta.js';
import { selectPyramidLevel } from './zarr/zarr-level-select.js';

// A bounded read briefly retains streamed parts plus a joined encoded buffer.
// Two 32 MiB reads keep that transient peak bounded while preserving overlap.
const OME_ZARR_CHUNK_LOAD_CONCURRENCY = 2;

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
  if (Number(file?.size) > MAX_OME_ZARR_ENCODED_CHUNK_BYTES) {
    throw new Error(`OME-Zarr resource limit: encoded chunk exceeds the ${MAX_OME_ZARR_ENCODED_CHUNK_BYTES} byte budget.`);
  }
  if (typeof file?.stream !== 'function') {
    throw new Error('OME-Zarr resource limit: bounded encoded chunk streaming is unavailable.');
  }
  return readBoundedOmeZarrByteStream(file.stream(), {
    createLimitError: message => new Error(`OME-Zarr resource limit: ${message.replace(/^Encoded Zarr/, 'encoded')}`),
  });
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

function cOrderStrides(shape) {
  const strides = new Array(shape.length);
  let stride = 1;
  for (let i = shape.length - 1; i >= 0; i -= 1) {
    strides[i] = stride;
    stride *= shape[i];
  }
  return strides;
}

function chunkKey(chunkCoords) {
  return chunkCoords.join(',');
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

function makeChunkStore({ filesByPath, rootPath, datasetPath, parsed }) {
  const cache = new Map();
  return {
    async load(chunkCoords) {
      const key = chunkKey(chunkCoords);
      if (cache.has(key)) return cache.get(key);
      const path = joinPath(rootPath, zarrChunkPath(datasetPath, parsed, chunkCoords));
      const file = filesByPath.get(path);
      if (!file) {
        if (!parsed.hasFillValue) {
          throw new Error(`OME-Zarr chunk is missing and the array has no concrete fill_value: ${path}`);
        }
        const entry = { shape: parsed.chunks, strides: cOrderStrides(parsed.chunks), view: null, fillValue: parsed.fillValue };
        cache.set(key, entry);
        return entry;
      }
      const encoded = await bytesForFile(file);
      // Zarr v2 stores every chunk at the declared chunk shape. Edge chunks are
      // clipped only while copying into the logical array; their overhang bytes
      // remain part of the encoded/decoded chunk contract.
      const storedChunkShape = parsed.chunks;
      const expectedBytes = storedChunkShape.reduce((product, value) => product * value, 1) * parsed.dtype.bytes;
      const bytes = await decodeZarrChunk(encoded, {
        compressor: parsed.compressor,
        filters: parsed.filters,
        dtype: parsed.dtype,
        expectedBytes,
      });
      const entry = {
        shape: storedChunkShape,
        strides: cOrderStrides(storedChunkShape),
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

function levelAxisScale(level, axes, name) {
  const index = axisIndex(axes, name);
  if (index < 0 || !axes[index]?.known || !axes[index]?.unit) return 0;
  const value = Number(level?.scale?.[index]);
  return Number.isFinite(value) && value > 0 ? value : axisScale(axes, name);
}

function levelShapeSize(shape, axes, name, fallback = 1) {
  const index = axisIndex(axes, name);
  return index >= 0 && shape[index] > 0 ? shape[index] : fallback;
}

function assertSelectedLevelAxes(levelZero, chosen, axes) {
  if (!levelZero?.parsed || !chosen?.parsed) throw new Error('OME-Zarr pyramid level metadata is incomplete.');
  if (levelZero.parsed.shape.length !== axes.length || chosen.parsed.shape.length !== axes.length) {
    throw new Error('OME-Zarr pyramid array rank does not match declared axes.');
  }
  for (let index = 0; index < axes.length; index += 1) {
    const name = String(axes[index]?.name || '').toLowerCase();
    if (['x', 'y', 'z'].includes(name)) continue;
    const base = levelZero.parsed.shape[index];
    const selected = chosen.parsed.shape[index];
    if (selected !== base) {
      throw new Error(`OME-Zarr selected level changes non-spatial axis '${name || index}' from ${base} to ${selected}.`);
    }
  }
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

  const PixelArray = zarrScalarArrayType(dtype);
  const pixels = new PixelArray(width * height);
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
        pixels[y * width + x] = zarrPixelAt(chunk.view, rowOffset + (x - xStart) * chunk.strides[xIndex], dtype, chunk.fillValue);
      }
    }
  }
  return { width, height, pixels };
}

export function omeZarrStatusText(result, { loaded = false, reason = '' } = {}) {
  const metadata = result?.metadata || {};
  const entry = result?.results?.[0]?.entry;
  const loadedSizes = entry ? {
    x: entry.width,
    y: entry.height,
    z: entry.microscopy?.sizeZ,
    c: entry.microscopy?.sizeC,
    t: entry.microscopy?.sizeT,
  } : {};
  const axes = (metadata.axes || []).map((axis) => {
    const name = String(axis.name || '').toLowerCase();
    return `${name.toUpperCase()} ${loadedSizes[name] || axis.size || 1}`;
  }).join(' · ');
  const pixel = metadata.pixel?.type && metadata.pixel.type !== 'unknown' ? metadata.pixel.type : 'unknown pixel type';
  const channelCount = metadata.channels?.length || 1;
  const storageProvenance = result?.results?.[0]?.entry?.microscopy?.storageProvenance || '';
  const suffix = loaded
    ? `Loaded ${storageProvenance || 'local OME-Zarr chunk data'}.`
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
  if (!metadata || metadata.errors?.length) throw new Error('OME-Zarr metadata is incomplete.');
  const version = String(metadata.multiscales?.version || '');
  const isNgff04 = /^0\.4(?:\.|$)/.test(version);
  const isNgff05 = /^0\.5(?:\.|$)/.test(version);
  if (!isNgff04 && !isNgff05) {
    throw new Error('OME-Zarr image loading requires OME-NGFF 0.4 or 0.5 metadata.');
  }
  const axes = metadata.axes || [];
  const levelZero = metadata.levels?.[0];
  const levelInputs = (metadata.levels || []).map((level) => {
    const arrayMeta = discovery.arrayMetadataByPath?.[level.path];
    const parsed = parseZarrArrayMeta(arrayMeta, { context: 'OME-Zarr image loading' });
    return {
      level: level.level,
      path: level.path,
      width: axisIndex(axes, 'x') >= 0 ? parsed.shape[axisIndex(axes, 'x')] : 0,
      height: axisIndex(axes, 'y') >= 0 ? parsed.shape[axisIndex(axes, 'y')] : 0,
      scale: level.scale,
      downsample: Math.max(...['x', 'y'].map((name) => {
        const index = axisIndex(axes, name);
        const base = Number(levelZero?.scale?.[index] || 0);
        const current = Number(level?.scale?.[index] || 0);
        return base > 0 && current > 0 ? current / base : 1;
      })),
      parsed,
      arrayMeta,
    };
  });
  const selection = selectPyramidLevel(levelInputs);
  if (selection.level == null) throw new Error(selection.reason);
  const chosen = levelInputs.find(level => level.path === selection.path);
  if (!chosen) throw new Error('OME-Zarr selected pyramid metadata is missing.');
  assertSelectedLevelAxes(levelInputs[0], chosen, axes);
  const { parsed } = chosen;
  const { shape, chunks, dtype } = parsed;
  const codecLabel = describeZarrCodec(parsed.compressor, parsed.filters);
  const datasetArrayMetadataByPath = Object.fromEntries(levelInputs.map(level => [
    level.path,
    zarrArrayMetaForDataset(level.arrayMeta, level.parsed),
  ]));
  const chunkStore = makeChunkStore({ filesByPath: discovery.filesByPath || fileMap(files), rootPath: discovery.rootPath, datasetPath: chosen.path, parsed });
  const sizeC = levelShapeSize(shape, axes, 'c');
  const sizeZ = levelShapeSize(shape, axes, 'z');
  const sizeT = levelShapeSize(shape, axes, 't');
  const xIndex = axisIndex(axes, 'x');
  const yIndex = axisIndex(axes, 'y');
  const resourceBudget = omeZarrResourceBudget({
    width: xIndex >= 0 ? shape[xIndex] : 0,
    height: yIndex >= 0 ? shape[yIndex] : 0,
    sizeC,
    sizeZ,
    sizeT,
    chunkWidth: xIndex >= 0 ? chunks[xIndex] : 0,
    chunkHeight: yIndex >= 0 ? chunks[yIndex] : 0,
    axes,
    shape,
    chunks,
    bytesPerElement: dtype.bytes,
  });
  if (!resourceBudget.ok) throw new Error(resourceBudget.reason);
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
  const results = buildMicroscopySeriesResults(pages, {
    source: 'OME-Zarr',
    sizeX: levelShapeSize(shape, axes, 'x', pages[0]?.width || 1),
    sizeY: levelShapeSize(shape, axes, 'y', pages[0]?.height || 1),
    sizeZ,
    sizeC,
    sizeT,
    dimensionOrder: 'XYZCT',
    physicalSizeX: levelAxisScale(chosen, axes, 'x'),
    physicalSizeY: levelAxisScale(chosen, axes, 'y'),
    physicalSizeZ: levelAxisScale(chosen, axes, 'z'),
    physicalUnit: unit || 'mm',
    physicalUnits: units,
    channels: metadata.channels || [],
    levels: metadata.levels || [],
    levelAxes: axes,
    levelArrayMetadataByPath: datasetArrayMetadataByPath,
    sourceFiles: [discovery.rootPath],
    sequenceProvenance: {
      kind: 'ome-zarr-local',
      level: Number(selection.level),
      levelCount: levelInputs.length,
      downsample: Number(selection.downsample || 1),
      codec: codecLabel,
    },
    warnings: [
      ...(metadata.warnings || []),
      ...(isNgff05 && parsed.version === 2 ? ['Nonconforming OME-Zarr 0.5 metadata on a Zarr v2 array loaded in compatibility mode'] : []),
    ],
  }, rootName, `ome_zarr_${Date.now().toString(36)}`);
  for (const result of results) {
    if (result.entry?.microscopy) {
      const downsample = Number(selection.downsample || 1);
      const factor = downsample > 1 ? `×${Number.isInteger(downsample) ? downsample : downsample.toFixed(2)} downsample` : 'full resolution';
      result.entry.microscopy.storageProvenance = `Local Zarr v${parsed.version} · level ${Number(selection.level) + 1}/${levelInputs.length} · ${factor} · ${codecLabel}`;
    }
  }
  return results;
}

export async function parseOmeZarrFiles(files, onProgress = () => {}) {
  onProgress('reading', 'OME-Zarr metadata');
  const discovery = await discoverOmeZarrMetadata(files);
  if (!discovery) return null;
  if (discovery.metadata.errors.length) {
    throw new Error(`OME-Zarr metadata is incomplete: ${omeZarrMetadataIssueLabels(discovery.metadata.errors).slice(0, 3).join(', ')}`);
  }
  try {
    onProgress('reading', 'OME-Zarr selected pyramid chunks');
    const results = await buildOmeZarrSeriesResults(discovery);
    const parsed = { ...discovery, results };
    return { ...parsed, status: omeZarrStatusText(parsed, { loaded: true }) };
  } catch (error) {
    return { ...discovery, results: [], status: omeZarrStatusText(discovery, { reason: error.message }) };
  }
}
