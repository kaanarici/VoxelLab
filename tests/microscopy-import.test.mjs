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
import {
  createLzwReferenceTiff,
  LZW_REFERENCE_PIXELS,
} from './fixtures/microscopy/lzw-tiff.mjs';
import {
  onePixelPages,
  tiffFileLike as fileLike,
  tinyTiff,
} from './fixtures/microscopy/tiny-tiff.mjs';

const {
  buildMicroscopySeriesResults,
  parseImageJDescriptionMetadata,
  parseMicroscopyFiles,
  parseOmeXmlMetadata,
  parseTiffPages,
} = await import('../js/microscopy/microscopy-import.js');
const { rawPlaneFor } = await import('../js/microscopy/microscopy-plane-store.js');
const { normalizeSeriesEntryForManifest } = await import('../js/series/series-contract.js');
const { seriesPersistenceKey } = await import('../js/series/series-identity.js');
const { canUseMpr3D } = await import('../js/series/series-capabilities.js');
const {
  formatAreaFromMm2,
  formatLengthFromMm,
  preferredLengthUnit,
} = await import('../js/core/physical-units.js');

test('parseTiffPages reads uncompressed 8-bit grayscale TIFF planes', async () => {
  const pages = await parseTiffPages(tinyTiff());

  assert.equal(pages.length, 1);
  assert.equal(pages[0].width, 2);
  assert.equal(pages[0].height, 1);
  assert.equal(pages[0].bitsPerSample, 8);
  assert.equal(pages[0].samplesPerPixel, 1);
  assert.equal(pages[0].sampleFormat, 1);
  assert.deepEqual(Array.from(pages[0].pixels), [0, 255]);
});

test('parseTiffPages decodes standard TIFF LZW across the 9-to-10-bit code transition', async () => {
  const pages = await parseTiffPages(createLzwReferenceTiff());

  assert.deepEqual(Array.from(pages[0].pixels), LZW_REFERENCE_PIXELS);
});

test('parseTiffPages enforces a cumulative retained-page budget before decoding the next IFD', async () => {
  const file = calibratedTimeSeriesOmeFileLike();
  const buffer = await file.arrayBuffer();

  await assert.rejects(
    () => parseTiffPages(buffer, { maxDocumentRetainedBytes: 16 * 16 * 8 }),
    /TIFF resource limit: document pages exceed the 2048 byte retained-pixel and canvas budget/,
  );
});

test('parseTiffPages reads signed integer grayscale TIFF planes', async () => {
  const pages8 = await parseTiffPages(tinyTiff({
    pixels: [-128, 127],
    sampleFormat: 2,
  }));
  const pages16 = await parseTiffPages(tinyTiff({
    pixels: [-1024, 2047],
    bitsPerSample: 16,
    sampleFormat: 2,
  }));

  assert.equal(pages8[0].sampleFormat, 2);
  assert.deepEqual(Array.from(pages8[0].pixels), [-128, 127]);
  assert.deepEqual(Array.from(pages16[0].pixels), [-1024, 2047]);
});

test('parseTiffPages reads bounded 32-bit scalar TIFF samples', async () => {
  const float = await parseTiffPages(tinyTiff({
    pixels: [-1.5, 2.25], bitsPerSample: 32, sampleFormat: 3,
  }));
  const signed = await parseTiffPages(tinyTiff({
    pixels: [-100000, 200000], bitsPerSample: 32, sampleFormat: 2,
  }));
  const unsigned = await parseTiffPages(tinyTiff({
    pixels: [0, 4000000000], bitsPerSample: 32, sampleFormat: 1,
  }));

  assert.deepEqual(Array.from(float[0].pixels), [-1.5, 2.25]);
  assert.deepEqual(Array.from(signed[0].pixels), [-100000, 200000]);
  assert.deepEqual(Array.from(unsigned[0].pixels), [0, 4000000000]);
  assert.ok(signed[0].pixels instanceof Int32Array);
  assert.ok(unsigned[0].pixels instanceof Uint32Array);
});

test('parseTiffPages preserves 32-bit predictor and Deflate scalar values', async () => {
  const predicted = await parseTiffPages(tinyTiff({
    width: 3,
    pixels: [100000, 200000, 500000],
    bitsPerSample: 32,
    sampleFormat: 1,
    predictor: 2,
  }));
  const compressedFloat = await parseTiffPages(tinyTiff({
    pixels: [-2.5, 7.75], bitsPerSample: 32, sampleFormat: 3, compression: 8,
  }));

  assert.deepEqual(Array.from(predicted[0].pixels), [100000, 200000, 500000]);
  assert.deepEqual(Array.from(compressedFloat[0].pixels), [-2.5, 7.75]);
});

test('parseMicroscopyFiles maps interleaved RGB(A) TIFF samples into explicit channels', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [rgb] = await parseMicroscopyFiles([fileLike('rgb.tiff', tinyTiff({
      width: 2,
      pixels: [10, 20, 30, 40, 50, 60],
      samplesPerPixel: 3,
      photometric: 2,
    }))]);
    const [rgba] = await parseMicroscopyFiles([fileLike('rgba.tiff', tinyTiff({
      width: 1,
      pixels: [10, 20, 30, 40],
      samplesPerPixel: 4,
      photometric: 2,
    }))]);

    assert.equal(rgb.entry.microscopy.sizeC, 3);
    assert.deepEqual(rgb.entry.microscopyDataset.channels.map(channel => [channel.name, channel.color]), [
      ['Red', '#FF0000'], ['Green', '#00FF00'], ['Blue', '#0000FF'],
    ]);
    assert.deepEqual(Object.keys(rgb.rawPlanes).sort(), ['0|0', '1|0', '2|0']);
    assert.deepEqual(Array.from(rgb.rawPlanes['1|0'][0].pixels), [20, 50]);
    assert.equal(rgba.entry.microscopy.sizeC, 4);
    assert.equal(rgba.entry.microscopyDataset.channels[3].name, 'Alpha');
    assert.deepEqual(Array.from(rgba.rawPlanes['3|0'][0].pixels), [40]);
  } finally {
    restore();
  }
});

test('parseTiffPages rejects unsupported microscopy TIFF storage layouts', async () => {
  await assert.rejects(
    () => parseTiffPages(tinyTiff({ compression: 7 })),
    /TIFF compression 7 is not supported yet/,
  );
  await assert.rejects(
    () => parseTiffPages(tinyTiff({ samplesPerPixel: 3 })),
    /only when they are RGB\/RGBA photometric data/,
  );
  await assert.rejects(
    () => parseTiffPages(tinyTiff({ bitsPerSample: 64 })),
    /supports 8-, 16-, or 32-bit scalar samples; found 64-bit/,
  );
  await assert.rejects(
    () => parseTiffPages(tinyTiff({ sampleFormat: 3 })),
    /supports float samples only at 32 bits/,
  );
});

test('parseTiffPages rejects BigTIFF instead of silently treating it as classic TIFF', async () => {
  const buffer = Buffer.alloc(16);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(43, 2);

  await assert.rejects(
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

test('parseOmeXmlMetadata rejects overlapping TiffData IFD mappings', () => {
  assert.throws(
    () => parseOmeXmlMetadata(`
      <OME>
        <Image ID="Image:0">
          <Pixels DimensionOrder="XYZCT" SizeX="2" SizeY="2" SizeZ="1" SizeC="1" SizeT="2">
            <TiffData/>
            <TiffData IFD="1" FirstT="0"/>
          </Pixels>
        </Image>
      </OME>
    `, 2),
    /OME-TIFF metadata maps IFD 1 more than once/,
  );
});

test('parseOmeXmlMetadata keeps valid sparse TiffData mappings', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="4" SizeC="2" SizeT="1">
          <TiffData IFD="2" FirstZ="3" FirstC="1"/>
        </Pixels>
      </Image>
    </OME>
  `, 3);

  assert.deepEqual([...meta.tiffData.entries()], [[2, { z: 3, c: 1, t: 0 }]]);

  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(3), meta, 'sparse.ome.tiff', 'sparse');
    assert.deepEqual(
      result.entry.microscopyDataset.planes.map(plane => [plane.c, plane.z, plane.t, plane.pageIndex]),
      [[1, 3, 0, 2]],
    );
    assert.deepEqual([...result.rawPlanes['1|0'][0].pixels], [2]);
  } finally {
    restore();
  }
});

test('calibrated sparse OME-TIFF Z mappings stay 2D with their actual Z extent', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="3" SizeC="1" SizeT="1"
          PhysicalSizeX="0.5" PhysicalSizeY="0.5" PhysicalSizeZ="2"
          PhysicalSizeXUnit="µm" PhysicalSizeYUnit="µm" PhysicalSizeZUnit="µm">
          <TiffData IFD="0" FirstZ="0"/>
          <TiffData IFD="1" FirstZ="2"/>
        </Pixels>
      </Image>
    </OME>
  `, 2);
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(2), meta, 'sparse-z.ome.tiff', 'sparse_z');

    assert.deepEqual(result.entry.microscopy.zPositionsByStack, { '0|0': [0, 2] });
    assert.equal(result.entry.slices, 2);
    assert.deepEqual(result.entry.firstIPP, [0, 0, 0]);
    assert.deepEqual(result.entry.lastIPP, [0, 0, 0.004]);
    assert.equal(result.entry.sliceSpacingRegular, false);
    assert.equal(result.entry.microscopy.volumeEligible, false);
    assert.equal(result.entry.microscopy.volumeBlockReason, 'incomplete_z_coverage');
    assert.equal(result.rawVolume, undefined);
    assert.equal(canUseMpr3D(result.entry), false);
  } finally {
    restore();
  }
});

test('one incomplete alternate OME-TIFF C/T stack blocks volume use for the dataset', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="2" SizeC="2" SizeT="1"
          PhysicalSizeX="0.5" PhysicalSizeY="0.5" PhysicalSizeZ="2"
          PhysicalSizeXUnit="µm" PhysicalSizeYUnit="µm" PhysicalSizeZUnit="µm">
          <TiffData IFD="0" FirstZ="0" FirstC="0"/>
          <TiffData IFD="1" FirstZ="1" FirstC="0"/>
          <TiffData IFD="2" FirstZ="0" FirstC="1"/>
        </Pixels>
      </Image>
    </OME>
  `, 3);
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(3), meta, 'partial-channel.ome.tiff', 'partial_channel');

    assert.deepEqual(result.entry.microscopy.zPositionsByStack, { '0|0': [0, 1], '1|0': [0] });
    assert.deepEqual(Object.fromEntries(Object.entries(result.localStacks).map(([key, stack]) => [key, stack.length])), {
      '0|0': 2,
      '1|0': 1,
    });
    assert.equal(result.entry.sliceSpacingRegular, true, 'the active C/T stack itself remains contiguous');
    assert.equal(result.entry.microscopy.volumeEligible, false);
    assert.equal(result.entry.microscopy.volumeBlockReason, 'incomplete_z_coverage');
    assert.equal(result.rawVolume, undefined);
    assert.equal(canUseMpr3D(result.entry), false);
  } finally {
    restore();
  }
});

test('parseOmeXmlMetadata fails closed for invalid TiffData references and positions', () => {
  const ome = (tiffData) => `
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="2" SizeC="2" SizeT="2">
          ${tiffData}
        </Pixels>
      </Image>
    </OME>
  `;

  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData IFD="2"/>'), 2),
    /TiffData IFD 2 is outside the 2 decoded IFDs/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData IFD="1" PlaneCount="2"/>'), 2),
    /TiffData IFD 2 is outside the 2 decoded IFDs/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData FirstZ="2"/>'), 1),
    /TiffData Z coordinate 2 is outside declared SizeZ=2/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData FirstC="2"/>'), 1),
    /TiffData C coordinate 2 is outside declared SizeC=2/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData FirstT="2"/>'), 1),
    /TiffData T coordinate 2 is outside declared SizeT=2/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData IFD="-1"/>'), 1),
    /TiffData IFD must be a finite non-negative integer/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData PlaneCount="1.5"/>'), 1),
    /TiffData PlaneCount must be a finite non-negative integer/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData FirstC=""/>'), 1),
    /TiffData FirstC must be a finite non-negative integer/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData FirstT="1e0"/>'), 1),
    /TiffData FirstT must be a finite non-negative integer/,
  );
  assert.throws(
    () => parseOmeXmlMetadata(ome('<TiffData IFD="0" FirstZ="0"/><TiffData IFD="1" FirstZ="0"/>'), 2),
    /maps C\/Z\/T position 0\|0\|0 more than once/,
  );
});

test('OME-TIFF ignores decoded IFDs beyond the declared pixel cube', () => {
  const meta = parseOmeXmlMetadata(`
    <OME>
      <Image ID="Image:0">
        <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="2" SizeC="1" SizeT="1">
          <TiffData/>
        </Pixels>
      </Image>
    </OME>
  `, 4);

  assert.deepEqual([...meta.tiffData.entries()], [
    [0, { z: 0, c: 0, t: 0 }],
    [1, { z: 1, c: 0, t: 0 }],
  ]);

  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(4), meta, 'extras.ome.tiff', 'extras');
    assert.deepEqual(
      result.entry.microscopyDataset.planes.map(plane => [plane.z, plane.pageIndex]),
      [[0, 0], [1, 1]],
    );
  } finally {
    restore();
  }
});

test('OME-TIFF rejects explicit TiffData runs that wrap the declared pixel cube', () => {
  assert.throws(
    () => parseOmeXmlMetadata(`
      <OME>
        <Image ID="Image:0">
          <Pixels DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="2" SizeC="1" SizeT="1">
            <TiffData PlaneCount="3"/>
          </Pixels>
        </Image>
      </OME>
    `, 3),
    /TiffData mapping exceeds the declared Z\/C\/T pixel cube/,
  );
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

test('OME-TIFF implicit metadata maps planes in linear ZCT order', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(6), {
      source: 'OME-TIFF',
      sizeZ: 3,
      sizeC: 2,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalUnit: 'um',
    }, 'implicit-order.ome.tiff', 'implicit_order');

    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.z, plane.c, plane.t, plane.pageIndex]), [
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [2, 0, 0, 2],
      [0, 1, 0, 3],
      [1, 1, 0, 4],
      [2, 1, 0, 5],
    ]);
  } finally {
    restore();
  }
});

test('OME-TIFF partial explicit plane mappings leave unassigned IFDs extraneous', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(4), {
      source: 'OME-TIFF',
      sizeZ: 3,
      sizeC: 2,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalUnit: 'um',
      tiffData: new Map([[1, { z: 2, c: 1, t: 0 }]]),
    }, 'partial-explicit.ome.tiff', 'partial_explicit');

    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.z, plane.c, plane.t, plane.pageIndex]), [
      [2, 1, 0, 1],
    ]);
    assert.deepEqual([...result.rawPlanes['1|0'][0].pixels], [1]);
  } finally {
    restore();
  }
});

test('implicit OME-TIFF assignments stop before positions wrap', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(4), {
      source: 'OME-TIFF',
      sizeZ: 2,
      sizeC: 1,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalUnit: 'um',
    }, 'implicit-extras.ome.tiff', 'implicit_extras');

    assert.deepEqual(result.entry.microscopyDataset.planes.map(plane => [plane.z, plane.pageIndex]), [
      [0, 0],
      [1, 1],
    ]);
  } finally {
    restore();
  }
});

test('OME-TIFF implicit metadata materializes large plane lists without replay helpers', () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const [result] = buildMicroscopySeriesResults(onePixelPages(2000), {
      source: 'OME-TIFF',
      sizeZ: 2000,
      sizeC: 1,
      sizeT: 1,
      dimensionOrder: 'XYZCT',
      physicalUnit: 'um',
    }, 'large-stack.ome.tiff', 'large_stack');
    const planes = result.entry.microscopyDataset.planes;

    assert.equal(planes.length, 2000);
    assert.deepEqual([planes[0].z, planes[0].c, planes[0].t, planes[0].pageIndex], [0, 0, 0, 0]);
    assert.deepEqual([planes[1999].z, planes[1999].c, planes[1999].t, planes[1999].pageIndex], [1999, 0, 0, 1999]);
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

test('ImageJ resolution fallback only trusts metric physical units', () => {
  const tags = new Map([[282, 2], [283, 4]]);
  const metric = parseImageJDescriptionMetadata([
    'ImageJ=1.54',
    'images=1',
    'unit=um',
  ].join('\n'), 1, { tags });
  const inch = parseImageJDescriptionMetadata([
    'ImageJ=1.54',
    'images=1',
    'unit=inch',
  ].join('\n'), 1, { tags });

  assert.equal(metric.physicalSizeX, 0.5);
  assert.equal(metric.physicalSizeY, 0.25);
  assert.deepEqual(metric.warnings, []);
  assert.equal(inch.physicalUnit, 'inch');
  assert.equal(inch.physicalSizeX, 0);
  assert.equal(inch.physicalSizeY, 0);
  assert.deepEqual(inch.warnings, ['imagej_non_metric_resolution']);
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

test('parseMicroscopyFiles treats ImageJ inch resolution tags as uncalibrated', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const results = await parseMicroscopyFiles([fileLike('cells-imagej.tif', tinyTiff({
      width: 2,
      height: 1,
      pixels: [10, 20],
      xResolution: 72,
      yResolution: 72,
      description: [
        'ImageJ=1.54',
        'images=1',
        'unit=inch',
      ].join('\n'),
    }))]);
    const series = results[0].entry;
    const axes = Object.fromEntries(series.microscopyDataset.axes.map(axis => [axis.name, axis]));

    assert.deepEqual(series.pixelSpacing, [0, 0]);
    assert.equal(series.microscopy.physicalSizeX, 0);
    assert.equal(series.microscopy.physicalSizeY, 0);
    assert.equal(axes.x.known, false);
    assert.equal(axes.y.known, false);
    assert.deepEqual(series.microscopyDataset.source.warnings, [
      'missing_xy_physical_size',
      'imagej_non_metric_resolution',
    ]);
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
    assert.equal(results[0].entry.geometryKind, 'volumeStack');
    assert.equal(results[0].entry.reconstructionCapability, 'display-volume');
    assert.equal(canUseMpr3D(results[0].entry), true);
    assert.deepEqual(results[0].entry.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(results[0].entry.sliceThickness, 0.002);
    assert.equal(results[0].entry.hasRaw, false);
    assert.ok(results[0].rawVolume instanceof Float32Array);
    assert.deepEqual(Array.from(results[0].rawVolume, value => Number(value.toFixed(6))), [0, 0.909091, 0.090909, 1]);
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

test('local microscopy persistence survives session-random slugs and separates changed source bytes', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const manifest = { patient: 'anonymous', studyDate: '2026-07-18', series: [] };
    const [first] = await parseMicroscopyFiles([calibratedOmeFileLike('cells.ome.tiff')]);
    const [changed] = await parseMicroscopyFiles([calibratedOmeFileLike('cells.ome.tiff', {
      pixels: [255, ...new Array(CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height - 1).fill(0)],
    })]);
    const normalized = normalizeSeriesEntryForManifest(manifest, first.entry);
    const sameSourceNewSession = normalizeSeriesEntryForManifest(manifest, {
      ...first.entry,
      slug: 'micro_different_session_1',
    });
    const changedSource = normalizeSeriesEntryForManifest(manifest, changed.entry);

    assert.equal(
      seriesPersistenceKey(normalized, manifest),
      seriesPersistenceKey(sameSourceNewSession, manifest),
    );
    assert.notEqual(
      seriesPersistenceKey(normalized, manifest),
      seriesPersistenceKey(changedSource, manifest),
    );
    assert.match(first.entry.microscopyDataset.source.signatures[0].sampleFingerprint, /^sample-v1:\d+:[0-9a-f]{16}$/);
  } finally {
    restore();
  }
});

test('local microscopy sequence persistence is stable across file selection order', async () => {
  const restore = installMicroscopyCanvasStub();
  try {
    const manifest = { patient: 'anonymous', studyDate: '2026-07-18', series: [] };
    const changedPixels = [
      255,
      ...new Array(CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height - 1).fill(0),
    ];
    const firstSelection = await parseMicroscopyFiles([
      calibratedOmeFileLike('cells_001.tif'),
      calibratedOmeFileLike('cells_002.tif', { pixels: changedPixels }),
    ]);
    const reversedSelection = await parseMicroscopyFiles([
      calibratedOmeFileLike('cells_002.tif', { pixels: changedPixels }),
      calibratedOmeFileLike('cells_001.tif'),
    ]);
    const firstEntry = normalizeSeriesEntryForManifest(manifest, firstSelection[0].entry);
    const reversedEntry = normalizeSeriesEntryForManifest(manifest, reversedSelection[0].entry);

    assert.equal(
      seriesPersistenceKey(firstEntry, manifest),
      seriesPersistenceKey(reversedEntry, manifest),
    );
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
