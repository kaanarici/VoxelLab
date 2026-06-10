/* global Buffer */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CALIBRATED_OME_TIFF,
  calibratedChannelTimeOmeFileLike,
  calibratedOmeFileLike,
  calibratedTimeSeriesOmeFileLike,
  installMicroscopyCanvasStub,
} from './fixtures/microscopy/calibrated-ome-tiff.mjs';

const {
  buildMicroscopySeriesResults,
  parseImageJDescriptionMetadata,
  parseMicroscopyFiles,
  parseOmeXmlMetadata,
  parseTiffPages,
} = await import('../js/microscopy/microscopy-import.js');
const { rawPlaneFor } = await import('../js/microscopy/microscopy-plane-store.js');
const {
  formatAreaFromMm2,
  formatLengthFromMm,
  preferredLengthUnit,
} = await import('../js/core/physical-units.js');

function writeEntry(buffer, offset, tag, type, count, value) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(type, offset + 2);
  buffer.writeUInt32LE(count, offset + 4);
  if (type === 3 && count === 1) buffer.writeUInt16LE(value, offset + 8);
  else buffer.writeUInt32LE(value, offset + 8);
}

function writeRational(buffer, offset, value) {
  const denominator = 1_000_000;
  buffer.writeUInt32LE(Math.round(Number(value) * denominator), offset);
  buffer.writeUInt32LE(denominator, offset + 4);
}

function tinyTiff({
  width = 2,
  height = 1,
  pixels = [0, 255],
  description = '',
  bitsPerSample = 8,
  compression = 1,
  samplesPerPixel = 1,
  sampleFormat = 1,
  xResolution = 0,
  yResolution = 0,
} = {}) {
  const pixelBytes = Buffer.alloc(pixels.length * (bitsPerSample / 8));
  for (let i = 0; i < pixels.length; i += 1) {
    if (bitsPerSample === 8) pixelBytes.writeUInt8(Number(pixels[i]) & 0xff, i);
    else if (sampleFormat === 2) pixelBytes.writeInt16LE(Number(pixels[i]), i * 2);
    else pixelBytes.writeUInt16LE(Number(pixels[i]), i * 2);
  }
  const descriptionBytes = description ? Buffer.from(`${description}\0`, 'utf8') : null;
  const hasResolution = xResolution > 0 || yResolution > 0;
  const entries = 10 + (descriptionBytes ? 1 : 0) + (hasResolution ? 3 : 0);
  const ifdOffset = 8;
  const descriptionOffset = ifdOffset + 2 + entries * 12 + 4;
  const rationalOffset = descriptionOffset + (descriptionBytes?.length || 0);
  const xResolutionOffset = rationalOffset;
  const yResolutionOffset = rationalOffset + 8;
  const pixelOffset = hasResolution ? rationalOffset + 16 : rationalOffset;
  const buffer = Buffer.alloc(pixelOffset + pixelBytes.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  for (const entry of [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, bitsPerSample],
    [259, 3, 1, compression],
    [262, 3, 1, 1],
    ...(descriptionBytes ? [[270, 2, descriptionBytes.length, descriptionOffset]] : []),
    [273, 4, 1, pixelOffset],
    [277, 3, 1, samplesPerPixel],
    [278, 4, 1, height],
    [279, 4, 1, pixelBytes.length],
    ...(hasResolution ? [
      [282, 5, 1, xResolutionOffset],
      [283, 5, 1, yResolutionOffset],
      [296, 3, 1, 1],
    ] : []),
    [339, 3, 1, sampleFormat],
  ]) {
    writeEntry(buffer, cursor, ...entry);
    cursor += 12;
  }
  buffer.writeUInt32LE(0, cursor);
  if (descriptionBytes) descriptionBytes.copy(buffer, descriptionOffset);
  if (hasResolution) {
    writeRational(buffer, xResolutionOffset, xResolution || yResolution);
    writeRational(buffer, yResolutionOffset, yResolution || xResolution);
  }
  pixelBytes.copy(buffer, pixelOffset);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function fileLike(name, buffer) {
  return {
    name,
    async arrayBuffer() {
      return buffer;
    },
  };
}

test('parseTiffPages reads uncompressed 8-bit grayscale TIFF planes', () => {
  const pages = parseTiffPages(tinyTiff());

  assert.equal(pages.length, 1);
  assert.equal(pages[0].width, 2);
  assert.equal(pages[0].height, 1);
  assert.equal(pages[0].bitsPerSample, 8);
  assert.equal(pages[0].samplesPerPixel, 1);
  assert.equal(pages[0].sampleFormat, 1);
  assert.deepEqual(Array.from(pages[0].pixels), [0, 255]);
});

test('parseTiffPages reads signed integer grayscale TIFF planes', () => {
  const pages8 = parseTiffPages(tinyTiff({
    pixels: [-128, 127],
    sampleFormat: 2,
  }));
  const pages16 = parseTiffPages(tinyTiff({
    pixels: [-1024, 2047],
    bitsPerSample: 16,
    sampleFormat: 2,
  }));

  assert.equal(pages8[0].sampleFormat, 2);
  assert.deepEqual(Array.from(pages8[0].pixels), [-128, 127]);
  assert.deepEqual(Array.from(pages16[0].pixels), [-1024, 2047]);
});

test('parseTiffPages rejects unsupported microscopy TIFF storage layouts', () => {
  assert.throws(
    () => parseTiffPages(tinyTiff({ compression: 5 })),
    /TIFF compression 5 is not supported yet/,
  );
  assert.throws(
    () => parseTiffPages(tinyTiff({ samplesPerPixel: 3 })),
    /supports single-channel planes; found SamplesPerPixel=3/,
  );
  assert.throws(
    () => parseTiffPages(tinyTiff({ bitsPerSample: 32 })),
    /supports 8- or 16-bit grayscale planes; found 32-bit/,
  );
  assert.throws(
    () => parseTiffPages(tinyTiff({ sampleFormat: 3 })),
    /supports signed or unsigned integer grayscale planes; found SampleFormat=3/,
  );
});

test('parseTiffPages rejects BigTIFF instead of silently treating it as classic TIFF', () => {
  const buffer = Buffer.alloc(16);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(43, 2);

  assert.throws(
    () => parseTiffPages(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
    /BigTIFF is not supported yet/,
  );
});

test('parseOmeXmlMetadata reads hyperstack axes and micrometer physical sizes', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="2" SizeY="2" SizeZ="3" SizeC="2" SizeT="4"
          PhysicalSizeX="0.25" PhysicalSizeY="0.25" PhysicalSizeZ="1.5" PhysicalSizeXUnit="µm">
          <Channel ID="Channel:0:0" Name="DAPI" Color="-16776961" EmissionWavelength="460" EmissionWavelengthUnit="nm"/>
          <Channel ID="Channel:0:1" Name="GFP" Color="16711935" EmissionWavelength="510" EmissionWavelengthUnit="nm"/>
        </Pixels>
      </Image>
    </OME>
  `, 24);

  assert.equal(meta.sizeZ, 3);
  assert.equal(meta.sizeC, 2);
  assert.equal(meta.sizeT, 4);
  assert.equal(meta.physicalUnit, 'µm');
  assert.deepEqual(meta.physicalUnits, { x: 'µm', y: 'µm', z: 'µm' });
  assert.deepEqual(meta.channelNames, ['DAPI', 'GFP']);
  assert.deepEqual(meta.channels.map(channel => [
    channel.name,
    channel.color,
    channel.emissionWavelength,
    channel.emissionWavelengthUnit,
  ]), [
    ['DAPI', '#FF0000', 460, 'nm'],
    ['GFP', '#00FF00', 510, 'nm'],
  ]);
});

test('OME-TIFF metadata preserves per-axis physical units for calibration', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="1" SizeC="1" SizeT="1"
          PhysicalSizeX="0.5" PhysicalSizeXUnit="millimeter"
          PhysicalSizeY="250" PhysicalSizeYUnit="micrometer"
          PhysicalSizeZ="0.000002" PhysicalSizeZUnit="meter">
          <Channel ID="Channel:0:0" Name="DAPI"/>
        </Pixels>
      </Image>
    </OME>
  `, 1);

  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults([
      { width: 1, height: 1, pixels: new Float32Array([10]), photometric: 1 },
    ], meta, 'mixed-units.ome.tiff', 'ome_mixed_units');

    assert.deepEqual(result.entry.pixelSpacing, [0.25, 0.5]);
    assert.deepEqual(result.entry.microscopyDataset.axes.slice(0, 3).map(axis => [axis.name, axis.unit, axis.scale, axis.known]), [
      ['x', 'mm', 0.5, true],
      ['y', 'µm', 250, true],
      ['z', 'm', 0.000002, true],
    ]);
  } finally {
    restore();
  }
});

test('buildMicroscopySeriesResults retains raw single-channel planes for analysis', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults([
      { width: 2, height: 1, pixels: new Float32Array([40000, 10000]), photometric: 1 },
      { width: 2, height: 1, pixels: new Float32Array([20000, 30000]), photometric: 1 },
    ], { source: 'OME-TIFF', sizeZ: 2, sizeC: 1, sizeT: 1, dimensionOrder: 'XYZCT', physicalUnit: 'µm' },
    'raw-retain.ome.tiff', 'raw_retain');

    assert.ok(result.rawPlanes, 'raw planes retained within budget');
    assert.deepEqual(Object.keys(result.rawPlanes), ['0|0']);
    const planes = result.rawPlanes['0|0'];
    assert.equal(planes.length, 2);
    // Raw values > 255 prove this is the raw domain, not an 8-bit display reconstruction.
    assert.deepEqual([...planes[0].pixels], [40000, 10000]);
    assert.deepEqual([planes[0].width, planes[0].height], [2, 1]);

    const host = { _localMicroscopyPlanes: { [result.entry.slug]: result.rawPlanes } };
    assert.deepEqual([...rawPlaneFor(host, result.entry, 0, 0, 1).pixels], [20000, 30000]);
    assert.equal(rawPlaneFor(host, result.entry, 0, 0, 5), null, 'out-of-range z fails closed');
    assert.equal(rawPlaneFor({ _localMicroscopyPlanes: {} }, result.entry, 0, 0, 0), null, 'no retained store fails closed');
  } finally {
    restore();
  }
});

test('ImageJ hyperstack metadata uses channel-fast CZT plane ordering', () => {
  const meta = parseImageJDescriptionMetadata([
    'ImageJ=1.54',
    'images=4',
    'channels=2',
    'slices=2',
    'frames=1',
    'hyperstack=true',
    'unit=um',
    'pixel_width=0.5',
    'pixel_height=0.25',
    'spacing=1.5',
  ].join('\n'), 4);

  const restore = installMicroscopyCanvasStub();
  try {
    const results = buildMicroscopySeriesResults([
      { width: 1, height: 1, pixels: new Float32Array([10]), photometric: 1 },
      { width: 1, height: 1, pixels: new Float32Array([20]), photometric: 1 },
      { width: 1, height: 1, pixels: new Float32Array([30]), photometric: 1 },
      { width: 1, height: 1, pixels: new Float32Array([40]), photometric: 1 },
    ], meta, 'cells-imagej.tif', 'imagej_test');

    assert.equal(meta.dimensionOrder, 'XYCZT');
    assert.deepEqual(results[0].entry.microscopyDataset.planes.map(plane => [plane.c, plane.z, plane.t, plane.pageIndex]), [
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [0, 1, 0, 2],
      [1, 1, 0, 3],
    ]);
    assert.deepEqual(Object.keys(results[0].localStacks).sort(), ['0|0', '1|0']);
  } finally {
    restore();
  }
});

test('ImageJ metadata infers one Z slice for channel-only stacks without slices field', () => {
  const meta = parseImageJDescriptionMetadata([
    'ImageJ=1.54',
    'images=5',
    'channels=5',
    'unit=um',
  ].join('\n'), 5);

  assert.equal(meta.sizeZ, 1);
  assert.equal(meta.sizeC, 5);
  assert.equal(meta.sizeT, 1);
});

test('parseMicroscopyFiles reads ImageJ TIFF XY calibration from resolution tags', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const results = await parseMicroscopyFiles([fileLike('cells-imagej.tif', tinyTiff({
      width: 2,
      height: 1,
      pixels: [10, 20],
      xResolution: 2,
      yResolution: 4,
      description: [
        'ImageJ=1.54',
        'images=1',
        'unit=um',
        'spacing=1.5',
      ].join('\n'),
    }))]);
    const series = results[0].entry;

    assert.equal(series.sequence, 'ImageJ-TIFF');
    assert.deepEqual(series.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(series.sliceThickness, 0.0015);
    assert.equal(series.microscopy.physicalSizeX, 0.5);
    assert.equal(series.microscopy.physicalSizeY, 0.25);
    assert.deepEqual(series.microscopyDataset.source.warnings, []);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles does not treat ImageJ resolution tags as microscopy scale without a unit', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const results = await parseMicroscopyFiles([fileLike('cells-imagej.tif', tinyTiff({
      xResolution: 2,
      yResolution: 4,
      description: [
        'ImageJ=1.54',
        'images=1',
      ].join('\n'),
    }))]);
    const series = results[0].entry;

    assert.deepEqual(series.pixelSpacing, [0, 0]);
    assert.deepEqual(series.microscopyDataset.source.warnings, [
      'missing_xy_physical_size',
      'missing_z_physical_size',
    ]);
  } finally {
    restore();
  }
});

test('buildMicroscopySeriesResults keeps one dataset series with channel/time local stacks', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const pages = [
      { width: 2, height: 1, pixels: new Float32Array([0, 10]), photometric: 1 },
      { width: 2, height: 1, pixels: new Float32Array([1, 11]), photometric: 1 },
      { width: 2, height: 1, pixels: new Float32Array([2, 12]), photometric: 1 },
      { width: 2, height: 1, pixels: new Float32Array([3, 13]), photometric: 1 },
    ];
    const results = buildMicroscopySeriesResults(pages, {
      source: 'OME-TIFF',
      sizeZ: 2,
      sizeC: 2,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalSizeX: 0.5,
      physicalSizeY: 0.25,
      physicalSizeZ: 2,
      physicalUnit: 'µm',
      channelNames: ['DAPI', 'GFP'],
      channels: [
        { name: 'DAPI', color: '#0000FF', emissionWavelength: 460, emissionWavelengthUnit: 'nm' },
        { name: 'GFP', color: '#00FF00', emissionWavelength: 510, emissionWavelengthUnit: 'nm' },
      ],
    }, 'cells.ome.tiff', 'micro_test');

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.imageDomain, 'microscopy');
    assert.equal(results[0].entry.geometryKind, 'microscopyStack');
    assert.equal(results[0].entry.reconstructionCapability, '2d-only');
    assert.deepEqual(results[0].entry.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(results[0].entry.sliceThickness, 0.002);
    assert.equal(results[0].entry.hasRaw, false);
    assert.equal(results[0].rawVolume, undefined);
    assert.equal(results[0].entry.name, 'cells');
    assert.equal(results[0].entry.microscopy.channelName, 'DAPI');
    assert.equal(results[0].entry.microscopyDataset.channels[0].color, '#0000FF');
    assert.equal(results[0].entry.microscopyDataset.channels[1].emissionWavelength, 510);
    assert.equal(results[0].entry.microscopy.datasetId, 'micro_test');
    assert.equal(results[0].entry.microscopyDataset.id, 'micro_test');
    assert.deepEqual(Object.keys(results[0].localStacks).sort(), ['0|0', '1|0']);
    assert.equal(results[0].sliceCanvases, results[0].localStacks['0|0']);
    assert.deepEqual(results[0].entry.microscopyDataset.axes.map(axis => [axis.name, axis.size]), [
      ['x', 2],
      ['y', 1],
      ['z', 2],
      ['c', 2],
      ['t', 1],
    ]);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles maps OME-TIFF timepoints into local T stacks', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = await parseMicroscopyFiles([calibratedTimeSeriesOmeFileLike()]);
    const series = result.entry;

    assert.equal(series.slices, 1);
    assert.equal(series.microscopy.sizeT, 2);
    assert.equal(series.microscopy.timeIndex, 0);
    assert.equal(series.microscopy.channelIndex, 0);
    assert.deepEqual(Object.keys(result.localStacks).sort(), ['0|0', '0|1']);
    assert.equal(result.sliceCanvases, result.localStacks['0|0']);
    assert.deepEqual(series.microscopyDataset.axes.map(axis => [axis.name, axis.size]), [
      ['x', CALIBRATED_OME_TIFF.width],
      ['y', CALIBRATED_OME_TIFF.height],
      ['z', 1],
      ['c', 1],
      ['t', 2],
    ]);
    assert.deepEqual(series.microscopyDataset.planes.map(plane => [plane.z, plane.c, plane.t, plane.pageIndex]), [
      [0, 0, 0, 0],
      [0, 0, 1, 1],
    ]);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles maps one OME-TIFF series across channel and time stacks', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = await parseMicroscopyFiles([calibratedChannelTimeOmeFileLike()]);
    const series = result.entry;

    assert.equal(series.slices, 1);
    assert.equal(series.microscopy.sizeC, 2);
    assert.equal(series.microscopy.sizeT, 2);
    assert.equal(series.microscopy.channelName, 'DAPI');
    assert.deepEqual(Object.keys(result.localStacks).sort(), ['0|0', '0|1', '1|0', '1|1']);
    assert.deepEqual(series.microscopyDataset.channels.map(channel => [
      channel.name,
      channel.color,
      channel.emissionWavelength,
    ]), [
      ['DAPI', '#0000FF', 460],
      ['GFP', '#00FF00', 510],
    ]);
    assert.deepEqual(series.microscopyDataset.axes.map(axis => [axis.name, axis.size]), [
      ['x', CALIBRATED_OME_TIFF.width],
      ['y', CALIBRATED_OME_TIFF.height],
      ['z', 1],
      ['c', 2],
      ['t', 2],
    ]);
    assert.deepEqual(series.microscopyDataset.planes.map(plane => [plane.z, plane.c, plane.t, plane.pageIndex]), [
      [0, 0, 0, 0],
      [0, 1, 0, 1],
      [0, 0, 1, 2],
      [0, 1, 1, 3],
    ]);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles preserves calibrated spacing from the shared OME-TIFF fixture', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = await parseMicroscopyFiles([calibratedOmeFileLike()]);
    const series = result.entry;

    assert.equal(series.imageDomain, 'microscopy');
    assert.deepEqual(series.pixelSpacing, CALIBRATED_OME_TIFF.pixelSpacingMm);
    assert.equal(series.sliceThickness, CALIBRATED_OME_TIFF.sliceThicknessMm);
    assert.equal(series.sliceSpacing, CALIBRATED_OME_TIFF.sliceThicknessMm);
    assert.equal(series._spacingKnown, true);
    assert.equal(series._sliceSpacingKnown, true);
    assert.equal(series.microscopy.physicalSizeX, CALIBRATED_OME_TIFF.physicalSizeXUm);
    assert.equal(series.microscopy.physicalSizeY, CALIBRATED_OME_TIFF.physicalSizeYUm);
    assert.equal(series.microscopy.physicalSizeZ, CALIBRATED_OME_TIFF.physicalSizeZUm);
    assert.deepEqual(series.microscopyDataset.source.warnings, []);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles stacks a numbered single-page TIFF sequence into one Z series', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const results = await parseMicroscopyFiles([
      fileLike('cells_z003.tif', tinyTiff({ pixels: [30, 31] })),
      fileLike('cells_z001.tif', tinyTiff({
        pixels: [10, 11],
        description: '<OME><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="2" SizeY="1" SizeZ="1" SizeC="1" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.25" PhysicalSizeZ="1.5" PhysicalSizeXUnit="µm"><Channel ID="Channel:0:0" Name="DAPI"/></Pixels></Image></OME>',
      })),
      fileLike('cells_z002.tif', tinyTiff({ pixels: [20, 21] })),
    ]);

    assert.equal(results.length, 1);
    const series = results[0].entry;
    assert.equal(series.name, 'cells_z');
    assert.equal(series.description, '2×1×3 · Z 3 · C 1 · T 1 · TIFF sequence · 0.500 µm/px');
    assert.equal(series.slices, 3);
    assert.equal(series.sequence, 'TIFF sequence');
    assert.deepEqual(series.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(series.sliceThickness, 0.0015);
    assert.deepEqual(series.microscopy.sourceFiles, ['cells_z001.tif', 'cells_z002.tif', 'cells_z003.tif']);
    assert.deepEqual(series.microscopyDataset.source.files, ['cells_z001.tif', 'cells_z002.tif', 'cells_z003.tif']);
    assert.equal(series.microscopy.sequenceProvenance.orderStrategy, 'numeric-suffix');
    assert.deepEqual(series.microscopy.sequenceProvenance.planes.map(plane => [plane.name, plane.sourceIndex, plane.inferredIndex]), [
      ['cells_z001.tif', 1, 1],
      ['cells_z002.tif', 2, 2],
      ['cells_z003.tif', 0, 3],
    ]);
    assert.equal(series.microscopyDataset.source.provenance.groupId, '|cells_z');
    assert.deepEqual(series.microscopyDataset.planes.map(plane => [plane.z, plane.pageIndex]), [[0, 0], [1, 1], [2, 2]]);
    assert.deepEqual(Object.keys(results[0].localStacks), ['0|0']);
  } finally {
    restore();
  }
});

test('parseMicroscopyFiles rejects unsafe TIFF sequence dimension mismatches', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    await assert.rejects(
      () => parseMicroscopyFiles([
        fileLike('bad_z001.tif', tinyTiff({ width: 2, height: 1, pixels: [1, 2] })),
        fileLike('bad_z002.tif', tinyTiff({ width: 3, height: 1, pixels: [1, 2, 3] })),
      ]),
      /TIFF sequence planes must share dimensions/,
    );
  } finally {
    restore();
  }
});

test('physical unit formatting presents microscopy measurements in micrometers', () => {
  const series = { imageDomain: 'microscopy', microscopy: { physicalUnit: 'µm' } };

  assert.equal(preferredLengthUnit(series), 'µm');
  assert.equal(formatLengthFromMm(0.001, series), '1.00 µm');
  assert.equal(formatAreaFromMm2(0.000001, series), '1.00 µm²');
});

test('microscopy stacks with unknown Z spacing do not invent a millimeter slice thickness', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const results = buildMicroscopySeriesResults([
      { width: 1, height: 1, pixels: new Float32Array([7]), photometric: 1 },
    ], {
      source: 'OME-TIFF',
      sizeZ: 1,
      sizeC: 1,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalSizeX: 0.5,
      physicalSizeY: 0.25,
      physicalUnit: 'µm',
    }, 'cells.ome.tiff', 'micro_unknown_z');

    assert.equal(results[0].entry.sliceThickness, 0);
    assert.equal(results[0].entry.sliceSpacing, 0);
    assert.equal(results[0].entry._sliceSpacingKnown, false);
  } finally {
    restore();
  }
});
