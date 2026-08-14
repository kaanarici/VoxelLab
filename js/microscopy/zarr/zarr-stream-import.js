// Compose the remote chunk store + codecs + level selection into the SAME microscopy
// series `results` the local OME-Zarr path produces, so a multi-GB public dataset can be
// opened by URL and streamed in the browser with no install. Calibration reflects the
// CHOSEN pyramid level's scale (downsample-aware), and provenance labels the streamed
// level so a downsampled view is never implied to be full resolution.
import { isMetricLengthUnit, isKnownLengthUnit, normalizeLengthUnit } from '../../core/physical-units.js';
import { normalizeOmeZarrMetadata, omeZarrMetadataIssueLabels } from '../microscopy-zarr-metadata.js';
import { buildMicroscopySeriesResults } from '../microscopy-import.js';
import { decodeZarrChunk, describeZarrCodec, ZarrUnsupportedCodecError } from './zarr-codecs.js';
import { createRemoteZarrStore } from './zarr-chunk-store.js';
import { selectPyramidLevel } from './zarr-level-select.js';
import { parseZarrArrayMeta, zarrArrayMetaForDataset, zarrPixelAt, zarrScalarArrayType } from './zarr-array-meta.js';
import {
  DEFAULT_MAX_OME_ZARR_PLANE_PIXELS,
  omeZarrResourceBudget,
} from './zarr-resource-budget.js';

function normalizeRelPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function joinPath(...parts) {
  return normalizeRelPath(parts.filter(Boolean).join('/'));
}

function omeAttributes(input) {
  if (input?.ome && typeof input.ome === 'object') return input.ome;
  if (input?.attributes?.ome && typeof input.attributes.ome === 'object') return input.attributes.ome;
  return input && typeof input === 'object' ? input : {};
}

function axisIndex(axes, name) {
  return axes.findIndex(axis => String(axis.name || '').toLowerCase() === name);
}

function axisScaleVector(level) {
  return Array.isArray(level?.scale) ? level.scale.map(Number) : [];
}

function levelDownsample(level, levelZero, axes) {
  const scale = axisScaleVector(level);
  const base = axisScaleVector(levelZero);
  const ratios = ['x', 'y'].map((name) => {
    const index = axisIndex(axes, name);
    const current = index >= 0 ? scale[index] : 0;
    const root = index >= 0 ? base[index] : 0;
    return current > 0 && root > 0 ? current / root : 0;
  }).filter(value => value > 0);
  return ratios.length ? Math.max(...ratios) : 1;
}

// Per-axis scale for the chosen level straight from its coordinate transform. Streaming
// calibration MUST use the loaded level's scale, not level 0's — see contracts §honesty.
function levelAxisScale(level, axes, name) {
  const index = axisIndex(axes, name);
  if (index < 0) return 0;
  const value = axisScaleVector(level)[index];
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  for (const name of ['x', 'y', 'z']) {
    if (units[name]) return units[name];
  }
  return '';
}

// Reuse the local path's chunk-tiling math, but source decoded tiles from the remote store's
// readChunk({shape, strides, view}) instead of an in-memory file map.
async function planePixelsFromStore(store, levelPath, arrayMeta, shape, chunks, axes, dtype, { c, z, t }) {
  const xIndex = axisIndex(axes, 'x');
  const yIndex = axisIndex(axes, 'y');
  if (xIndex < 0 || yIndex < 0) throw new ZarrUnsupportedCodecError('axes (streaming requires x and y axes)');
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
  const chunkCoordsList = [];
  for (let y = 0; y < height; y += chunks[yIndex]) {
    for (let x = 0; x < width; x += chunks[xIndex]) {
      const chunkCoords = baseChunkCoords.slice();
      chunkCoords[yIndex] = Math.floor(y / chunks[yIndex]);
      chunkCoords[xIndex] = Math.floor(x / chunks[xIndex]);
      chunkCoordsList.push(chunkCoords);
    }
  }

  const tiles = await Promise.all(chunkCoordsList.map(async (chunkCoords) => ({
    chunkCoords,
    chunk: await store.readChunk(levelPath, chunkCoords, arrayMeta),
  })));

  const PixelArray = zarrScalarArrayType(dtype);
  const pixels = new PixelArray(width * height);
  for (const { chunkCoords, chunk } of tiles) {
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

function levelShapeSize(shape, axes, name, fallback = 1) {
  const index = axisIndex(axes, name);
  return index >= 0 && shape[index] > 0 ? shape[index] : fallback;
}

function rootName(baseUrl) {
  try {
    const segments = String(baseUrl || '').replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/+$/, '').split('/');
    const last = segments.filter(Boolean).pop() || 'ome-zarr';
    return last.replace(/\.zarr$/i, '') || 'ome-zarr';
  } catch {
    return 'ome-zarr';
  }
}

// "OME-Zarr streamed · level N/M · ×k downsample" — the loaded series must clearly show it is
// a downsampled pyramid level (contracts §honesty), surfaced as its own metadata provenance row.
export function streamProvenanceText(selection, levelCount, codecLabel, zarrVersion = 2) {
  const levelNumber = Number(selection?.level ?? 0) + 1;
  const downsample = Number(selection?.downsample || 1);
  const factor = downsample > 1 ? `×${Number.isInteger(downsample) ? downsample : downsample.toFixed(2)} downsample` : 'full resolution';
  const codec = codecLabel ? ` · ${codecLabel}` : '';
  return `OME-Zarr v${zarrVersion} streamed · level ${levelNumber}/${levelCount} · ${factor}${codec}`;
}

async function readZarrMetadata(store, baseUrl) {
  const rootGroup = await store.readJson('.zgroup');
  const zarrVersion = rootGroup ? 2 : 3;
  const rootV3 = zarrVersion === 3 ? await store.readJson('zarr.json') : null;
  const rootAttrs = zarrVersion === 2 ? await store.readJson('.zattrs') : null;
  if (!rootV3 && !rootGroup) {
    throw new ZarrUnsupportedCodecError(`no .zgroup or zarr.json at ${baseUrl} (expected an OME-Zarr image group root)`);
  }
  const attrs = rootV3 || rootAttrs || {};
  const ome = omeAttributes(attrs);
  if (!Array.isArray(ome.multiscales) || !ome.multiscales.length) {
    throw new ZarrUnsupportedCodecError('multiscales metadata missing (root .zattrs has no OME multiscales entry)');
  }
  const multiscale = ome.multiscales[0] || {};
  const datasets = Array.isArray(multiscale.datasets) ? multiscale.datasets : [];
  if (!datasets.length) throw new ZarrUnsupportedCodecError('multiscales datasets missing');

  const arrayMetadataByPath = {};
  for (const dataset of datasets) {
    const datasetPath = normalizeRelPath(dataset?.path || '');
    if (!datasetPath) continue;
    const metadataName = zarrVersion === 3 ? 'zarr.json' : '.zarray';
    const arrayMeta = await store.readJson(joinPath(datasetPath, metadataName));
    if (arrayMeta) arrayMetadataByPath[datasetPath] = arrayMeta;
  }
  return { attrs, arrayMetadataByPath };
}

export async function streamOmeZarrFromUrl(baseUrl, {
  fetchImpl,
  onProgress = () => {},
  maxPlanePixels = DEFAULT_MAX_OME_ZARR_PLANE_PIXELS,
  decode = decodeZarrChunk,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new ZarrUnsupportedCodecError('fetchImpl (streaming requires an injected fetch)');
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  if (!cleanBase) throw new ZarrUnsupportedCodecError('baseUrl (streaming requires an OME-Zarr URL)');

  const store = createRemoteZarrStore({ baseUrl: cleanBase, fetchImpl, decode });
  // External cancellation (e.g. the upload modal closing) aborts in-flight chunk
  // fetches; the store then rejects pending/new reads, unwinding the loop below.
  const onAbort = () => store.abort();
  if (signal) {
    if (signal.aborted) store.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    onProgress('metadata', 'reading OME-Zarr metadata');
    const { attrs, arrayMetadataByPath } = await readZarrMetadata(store, cleanBase);
    const metadata = normalizeOmeZarrMetadata(attrs, { arrayMetadataByPath });
    if (metadata.errors?.length) {
      throw new ZarrUnsupportedCodecError(`metadata incomplete: ${omeZarrMetadataIssueLabels(metadata.errors).slice(0, 3).join(', ') || metadata.errors.slice(0, 3).join(', ')}`);
    }
    const version = String(metadata.multiscales?.version || '');
    const isNgff05 = /^0\.5(?:\.|$)/.test(version);
    if (version && !/^0\.4(?:\.|$)/.test(version) && !isNgff05) {
      throw new ZarrUnsupportedCodecError(`OME-NGFF version '${version}' (Zarr v2 streaming requires 0.4 metadata or compatible multiscales metadata)`);
    }

    const axes = metadata.axes || [];
    const datasetLevels = metadata.levels || [];
    const levelZero = datasetLevels[0];
    const levelInputs = datasetLevels.map((level) => {
      const arrayMeta = arrayMetadataByPath[level.path];
      let parsedLevel = null;
      try { parsedLevel = parseZarrArrayMeta(arrayMeta, { context: 'OME-Zarr streaming' }); } catch { /* chosen level reports the named validation failure below */ }
      const shape = parsedLevel?.shape || [];
      return {
        level: Number(level.level ?? 0),
        path: level.path,
        width: levelShapeSize(shape, axes, 'x', 0),
        height: levelShapeSize(shape, axes, 'y', 0),
        scale: level.scale,
        downsample: levelDownsample(level, levelZero, axes),
        parsed: parsedLevel,
        arrayMeta,
      };
    });

    const selection = selectPyramidLevel(levelInputs, { maxPlanePixels });
    if (selection.level == null || !selection.path) {
      throw new ZarrUnsupportedCodecError(selection.reason || 'no pyramid levels with a resolvable plane size');
    }
    onProgress('level', `selected level ${Number(selection.level) + 1}/${levelInputs.length} (${selection.width}×${selection.height})`);

    const chosenLevel = datasetLevels.find(level => level.path === selection.path) || levelZero;
    const arrayMeta = arrayMetadataByPath[selection.path];
    const parsed = parseZarrArrayMeta(arrayMeta, { context: `OME-Zarr streaming level '${selection.path}'` });
    const { shape, chunks, dtype } = parsed;
    const codecLabel = describeZarrCodec(parsed.compressor, parsed.filters);
    const datasetArrayMetadataByPath = Object.fromEntries(levelInputs.map(level => [
      level.path,
      zarrArrayMetaForDataset(level.arrayMeta, level.parsed),
    ]));

    const sizeC = levelShapeSize(shape, axes, 'c', 1);
    const sizeZ = levelShapeSize(shape, axes, 'z', 1);
    const sizeT = levelShapeSize(shape, axes, 't', 1);
    const xIndex = axisIndex(axes, 'x');
    const yIndex = axisIndex(axes, 'y');
    const resourceBudget = omeZarrResourceBudget({
      width: levelShapeSize(shape, axes, 'x', 0),
      height: levelShapeSize(shape, axes, 'y', 0),
      sizeC,
      sizeZ,
      sizeT,
      chunkWidth: xIndex >= 0 ? chunks[xIndex] : 0,
      chunkHeight: yIndex >= 0 ? chunks[yIndex] : 0,
      axes,
      shape,
      chunks,
      bytesPerElement: dtype.bytes,
      maxPlanePixels,
    });
    if (!resourceBudget.ok) throw new ZarrUnsupportedCodecError(resourceBudget.reason);
    const planeCount = sizeC * sizeZ * sizeT;

    const pages = [];
    let built = 0;
    for (let t = 0; t < sizeT; t += 1) {
      for (let c = 0; c < sizeC; c += 1) {
        for (let z = 0; z < sizeZ; z += 1) {
          onProgress('planes', `${built}/${planeCount}`);
          const plane = await planePixelsFromStore(store, selection.path, arrayMeta, shape, chunks, axes, dtype, { c, z, t });
          pages.push({
            ...plane,
            bitsPerSample: dtype.bits,
            sampleFormat: dtype.sampleFormat,
            samplesPerPixel: 1,
            littleEndian: dtype.littleEndian,
            photometric: 1,
          });
          built += 1;
        }
      }
    }
    onProgress('planes', `${built}/${planeCount}`);

    const units = spatialUnits(axes);
    const unit = preferredSpatialUnit(units) || 'mm';
    const provenance = streamProvenanceText(selection, levelInputs.length, codecLabel, parsed.version);
    const streamWarning = `stream_level_${Number(selection.level) + 1}_of_${levelInputs.length}_downsample_${Number(selection.downsample || 1)}`;

    const results = buildMicroscopySeriesResults(pages, {
      source: 'OME-Zarr',
      sizeX: levelShapeSize(shape, axes, 'x', pages[0]?.width || 1),
      sizeY: levelShapeSize(shape, axes, 'y', pages[0]?.height || 1),
      sizeZ,
      sizeC,
      sizeT,
      dimensionOrder: 'XYZCT',
      // Chosen level's scale — downsample-aware so calibration is honest for a coarse view.
      physicalSizeX: levelAxisScale(chosenLevel, axes, 'x'),
      physicalSizeY: levelAxisScale(chosenLevel, axes, 'y'),
      physicalSizeZ: levelAxisScale(chosenLevel, axes, 'z'),
      physicalUnit: isMetricLengthUnit(unit) ? unit : (unit || 'mm'),
      physicalUnits: units,
      channels: metadata.channels || [],
      levels: levelInputs,
      levelAxes: axes,
      levelArrayMetadataByPath: datasetArrayMetadataByPath,
      sourceFiles: [cleanBase],
      warnings: [
        ...(metadata.warnings || []),
        ...(isNgff05 && parsed.version === 2 ? ['Nonconforming OME-Zarr 0.5 metadata on a Zarr v2 array loaded in compatibility mode'] : []),
        streamWarning,
      ],
    }, rootName(cleanBase), `ome_zarr_stream_${Date.now().toString(36)}`);

    for (const result of results) {
      if (result.entry?.microscopy) {
        result.entry.microscopy.streaming = {
          source: 'ome-zarr',
          baseUrl: cleanBase,
          level: Number(selection.level),
          levelCount: levelInputs.length,
          downsample: Number(selection.downsample || 1),
          zarrVersion: parsed.version,
          codec: codecLabel,
          provenance,
        };
        result.entry.microscopy.streamProvenance = provenance;
      }
    }

    return {
      results,
      selection,
      levels: levelInputs,
      codec: codecLabel,
      provenance,
      metadata,
    };
  } catch (error) {
    store.abort();
    throw error;
  }
}
