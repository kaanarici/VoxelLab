import { isKnownLengthUnit, lengthUnitToMm, normalizeLengthUnit } from './physical-units.js';

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInteger(value, fallback = 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function zeroBasedInteger(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function finiteRange(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = Number(value[0]);
  const hi = Number(value[1]);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

function axisIndex(axes = [], name) {
  return axes.findIndex(item => item?.name === name);
}

function arrayShapeForAxis(arrayMeta = {}, axes = [], name, fallback) {
  const shape = Array.isArray(arrayMeta.shape) ? arrayMeta.shape.map(Number) : [];
  const index = axisIndex(axes, name);
  return index >= 0 && shape[index] > 0 ? shape[index] : fallback;
}

function chunkShapeForAxes(arrayMeta = {}, axes = [], fallback = {}) {
  const chunks = Array.isArray(arrayMeta.chunks) ? arrayMeta.chunks.map(Number) : [];
  const out = {};
  for (const name of ['t', 'c', 'z', 'y', 'x']) {
    const index = axisIndex(axes, name);
    out[name] = index >= 0 && chunks[index] > 0 ? chunks[index] : positiveInteger(fallback[name]);
  }
  return out;
}

function levelDownsample(level = {}, axes = [], levelZeroScale = []) {
  const scale = Array.isArray(level.scale) ? level.scale.map(Number) : [];
  const ratios = ['x', 'y']
    .map((name) => {
      const index = axisIndex(axes, name);
      const current = index >= 0 ? scale[index] : 0;
      const base = index >= 0 ? Number(levelZeroScale[index]) : 0;
      return current > 0 && base > 0 ? current / base : 0;
    })
    .filter(value => value > 0);
  return ratios.length ? Math.max(...ratios) : 1;
}

function datasetLevels(metadata, fallback) {
  const levels = Array.isArray(metadata.levels) ? metadata.levels : [];
  const axes = Array.isArray(metadata.levelAxes) ? metadata.levelAxes : [];
  const arrays = metadata.levelArrayMetadataByPath && typeof metadata.levelArrayMetadataByPath === 'object'
    ? metadata.levelArrayMetadataByPath
    : {};
  if (!levels.length || !axes.length) {
    return [{
      level: 0,
      width: fallback.x,
      height: fallback.y,
      tileWidth: fallback.x,
      tileHeight: fallback.y,
      chunkShape: { t: 1, c: 1, z: 1, y: fallback.y, x: fallback.x },
      downsample: 1,
    }];
  }
  const levelZeroScale = Array.isArray(levels[0]?.scale) ? levels[0].scale.map(Number) : [];
  return levels.map((level, index) => {
    const path = String(level?.path || index);
    const arrayMeta = arrays[path] || {};
    const chunkShape = chunkShapeForAxes(arrayMeta, axes, {
      t: fallback.t,
      c: fallback.c,
      z: fallback.z,
      y: fallback.y,
      x: fallback.x,
    });
    return {
      level: zeroBasedInteger(level?.level, index),
      path,
      width: positiveInteger(arrayShapeForAxis(arrayMeta, axes, 'x', fallback.x)),
      height: positiveInteger(arrayShapeForAxis(arrayMeta, axes, 'y', fallback.y)),
      tileWidth: positiveInteger(chunkShape.x, fallback.x),
      tileHeight: positiveInteger(chunkShape.y, fallback.y),
      chunkShape,
      downsample: levelDownsample(level, axes, levelZeroScale),
    };
  });
}

function baseName(fileName) {
  return String(fileName || 'microscopy').replace(/\.(ome\.)?tiff?$/i, '') || 'microscopy';
}

function axis(name, type, size, { unit = '', scale = 0, known = false } = {}) {
  return {
    name,
    type,
    size: positiveInteger(size),
    unit,
    scale: positiveNumber(scale),
    known: !!known,
  };
}

function pixelTypeForPage(page = {}) {
  const bits = Number(page.bitsPerSample || 8);
  const sampleFormat = Number(page.sampleFormat || 1);
  if (sampleFormat === 1 && bits === 8) return 'uint8';
  if (sampleFormat === 1 && bits === 16) return 'uint16';
  return `sampleFormat${sampleFormat || 'unknown'}:${bits || 'unknown'}bit`;
}

function pixelStats(pages) {
  let min = Infinity;
  let max = -Infinity;
  for (const page of pages) {
    for (const value of page.pixels || []) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  };
}

function warningsForAxes({ xScale, yScale, zScale, xUnitKnown, yUnitKnown, zUnitKnown }) {
  const warnings = [];
  if (!(xScale > 0 && xUnitKnown) || !(yScale > 0 && yUnitKnown)) warnings.push('missing_xy_physical_size');
  if (!(zScale > 0 && zUnitKnown)) warnings.push('missing_z_physical_size');
  if (xScale > 0 && !xUnitKnown) warnings.push('unsupported_x_physical_unit');
  if (yScale > 0 && !yUnitKnown) warnings.push('unsupported_y_physical_unit');
  if (zScale > 0 && !zUnitKnown) warnings.push('unsupported_z_physical_unit');
  return warnings;
}

function axisUnit(metadata, name, fallback) {
  const units = metadata.physicalUnits && typeof metadata.physicalUnits === 'object' ? metadata.physicalUnits : {};
  const raw = units[name] || metadata.physicalUnit || fallback;
  return {
    unit: normalizeLengthUnit(raw),
    known: isKnownLengthUnit(raw),
  };
}

export function axisByName(dataset, name) {
  return dataset?.axes?.find(item => item?.name === name) || null;
}

export function channelMetadata(dataset, index = 0) {
  const channel = dataset?.channels?.find(item => item?.index === index);
  return channel || {
    index,
    name: `Channel ${index + 1}`,
    color: null,
    lut: 'gray',
    emissionWavelength: null,
    displayRange: null,
  };
}

export function datasetSpacingMm(dataset) {
  const xAxis = axisByName(dataset, 'x');
  const yAxis = axisByName(dataset, 'y');
  const zAxis = axisByName(dataset, 'z');
  const colMm = xAxis?.known ? xAxis.scale * lengthUnitToMm(xAxis.unit) : 0;
  const rowMm = yAxis?.known ? yAxis.scale * lengthUnitToMm(yAxis.unit) : 0;
  const zMm = zAxis?.known ? zAxis.scale * lengthUnitToMm(zAxis.unit) : 0;
  return {
    rowMm,
    colMm,
    zMm,
    zKnown: zMm > 0,
    unit: (xAxis?.known && xAxis.unit)
      || (yAxis?.known && yAxis.unit)
      || (zAxis?.known && zAxis.unit)
      || xAxis?.unit
      || yAxis?.unit
      || zAxis?.unit
      || 'mm',
  };
}

export function buildMicroscopyDataset({
  pages = [],
  metadata = {},
  fileName = 'microscopy',
  slugBase = 'microscopy',
  planePositions = [],
} = {}) {
  if (!pages.length) throw new Error('No microscopy planes found');
  const first = pages[0] || {};
  const fallbackUnit = metadata.physicalUnit || 'µm';
  const xUnit = axisUnit(metadata, 'x', fallbackUnit);
  const yUnit = axisUnit(metadata, 'y', fallbackUnit);
  const zUnit = axisUnit(metadata, 'z', fallbackUnit);
  const sizeX = positiveInteger(metadata.sizeX, first.width || 1);
  const sizeY = positiveInteger(metadata.sizeY, first.height || 1);
  const sizeZ = positiveInteger(metadata.sizeZ, pages.length || 1);
  const sizeC = positiveInteger(metadata.sizeC, 1);
  const sizeT = positiveInteger(metadata.sizeT, 1);
  const xScale = positiveNumber(metadata.physicalSizeX);
  const yScale = positiveNumber(metadata.physicalSizeY);
  const zScale = positiveNumber(metadata.physicalSizeZ);
  const stats = pixelStats(pages);
  const channels = Array.from({ length: sizeC }, (_, index) => {
    const channel = metadata.channels?.[index] || {};
    const metadataDisplayRange = finiteRange(channel.displayRange);
    return {
      index,
      name: channel.name || metadata.channelNames?.[index] || `Channel ${index + 1}`,
      color: channel.color || null,
      lut: channel.lut || 'gray',
      emissionWavelength: channel.emissionWavelength || null,
      emissionWavelengthUnit: channel.emissionWavelengthUnit || null,
      displayRange: metadataDisplayRange || [stats.min, stats.max],
      displayRangeSource: metadataDisplayRange ? 'metadata' : 'pixel-stats',
    };
  });

  return {
    id: String(slugBase || 'microscopy'),
    name: baseName(fileName),
    source: {
      kind: 'local-file',
      path: String(fileName || ''),
      files: Array.isArray(metadata.sourceFiles) ? metadata.sourceFiles.map(String) : [String(fileName || '')],
      originalFormat: metadata.source || 'TIFF',
      converter: null,
      converterVersion: null,
      checksum: '',
      provenance: metadata.sequenceProvenance || null,
      warnings: [
        ...warningsForAxes({
          xScale,
          yScale,
          zScale,
          xUnitKnown: xUnit.known,
          yUnitKnown: yUnit.known,
          zUnitKnown: zUnit.known,
        }),
        ...(Array.isArray(metadata.warnings) ? metadata.warnings.map(String) : []),
      ],
    },
    axes: [
      axis('x', 'space', sizeX, { unit: xUnit.unit, scale: xScale, known: xScale > 0 && xUnit.known }),
      axis('y', 'space', sizeY, { unit: yUnit.unit, scale: yScale, known: yScale > 0 && yUnit.known }),
      axis('z', 'space', sizeZ, { unit: zUnit.unit, scale: zScale, known: zScale > 0 && zUnit.known }),
      axis('c', 'channel', sizeC),
      axis('t', 'time', sizeT, { unit: 'index', scale: 1, known: false }),
    ],
    pixel: {
      type: pixelTypeForPage(first),
      samplesPerPixel: positiveInteger(first.samplesPerPixel, 1),
      endianness: first.littleEndian === false ? 'big' : 'little',
      min: stats.min,
      max: stats.max,
    },
    channels,
    levels: datasetLevels(metadata, {
      t: sizeT,
      c: sizeC,
      z: sizeZ,
      y: sizeY,
      x: sizeX,
    }),
    planes: pages.map((page, index) => {
      const pos = planePositions[index] || {};
      return {
        c: zeroBasedInteger(pos.c),
        z: zeroBasedInteger(pos.z, index),
        t: zeroBasedInteger(pos.t),
        level: 0,
        pageIndex: index,
        width: positiveInteger(page.width, sizeX),
        height: positiveInteger(page.height, sizeY),
        uri: null,
        byteRange: null,
        checksum: '',
      };
    }),
    rois: [],
    measurements: [],
  };
}
