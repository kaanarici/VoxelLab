import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const { parseNIfTI, parseNIfTISeries } = await import('../js/dicom/nifti-import-parse.js');
const { calibratedScaleBarModel } = await import('../js/overlay/scale-bar.js');

function createCanvasStub() {
  const context = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
  return { width: 0, height: 0, getContext: () => context };
}

function withDocumentStub(fn) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvasStub();
      throw new Error(`unexpected element: ${tag}`);
    },
  };
  return Promise.resolve(fn()).finally(() => { globalThis.document = previousDocument; });
}

function tinyNiftiFile({
  littleEndian = true,
  datatype = 4,
  values = [0, 256, 512, 1024],
  pixdim = [1, 1, 1],
  xyztUnits = 2,
  name,
} = {}) {
  const bytesPerVoxel = datatype === 2 || datatype === 256 ? 1 : datatype === 64 ? 8 : datatype === 4 || datatype === 512 ? 2 : 4;
  const buffer = new ArrayBuffer(352 + values.length * bytesPerVoxel);
  const view = new DataView(buffer);
  const writeInt16 = (offset, value) => view.setInt16(offset, value, littleEndian);
  const writeFloat32 = (offset, value) => view.setFloat32(offset, value, littleEndian);
  view.setInt32(0, 348, littleEndian);
  new Uint8Array(buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  writeInt16(40, 3);
  writeInt16(42, 2);
  writeInt16(44, 2);
  writeInt16(46, 1);
  writeInt16(70, datatype);
  writeInt16(72, bytesPerVoxel * 8);
  writeFloat32(80, pixdim[0]);
  writeFloat32(84, pixdim[1]);
  writeFloat32(88, pixdim[2]);
  writeFloat32(108, 352);
  view.setUint8(123, xyztUnits);
  values.forEach((value, index) => {
    const offset = 352 + index * bytesPerVoxel;
    if (datatype === 2) view.setUint8(offset, value);
    else if (datatype === 256) view.setInt8(offset, value);
    else if (datatype === 4) view.setInt16(offset, value, littleEndian);
    else if (datatype === 512) view.setUint16(offset, value, littleEndian);
    else if (datatype === 8) view.setInt32(offset, value, littleEndian);
    else if (datatype === 16) view.setFloat32(offset, value, littleEndian);
    else if (datatype === 64) view.setFloat64(offset, value, littleEndian);
    else if (datatype === 768) view.setUint32(offset, value, littleEndian);
  });
  return { name: name || (littleEndian ? 'tiny-le.nii' : 'tiny-be.nii'), async arrayBuffer() { return buffer; } };
}

function tinyNifti2File({
  littleEndian = true,
  datatype = 4,
  values = [10, 20, 30, 50],
  pixdim = [2, 3, 4],
  xyztUnits = 2,
  timepoints = 1,
  timeSpacing = 0,
  timeOffset = 0,
  sclSlope = 2,
  sclInter = -10,
  name = 'tiny-nifti2.nii',
} = {}) {
  const bytesPerVoxel = datatype === 2 || datatype === 256 ? 1 : datatype === 64 ? 8 : datatype === 4 || datatype === 512 ? 2 : 4;
  const dataOffset = 544;
  const buffer = new ArrayBuffer(dataOffset + values.length * bytesPerVoxel);
  const view = new DataView(buffer);
  const writeInt64 = (offset, value) => view.setBigInt64(offset, BigInt(value), littleEndian);
  const writeFloat64 = (offset, value) => view.setFloat64(offset, value, littleEndian);
  view.setInt32(0, 540, littleEndian);
  new Uint8Array(buffer).set([0x6e, 0x2b, 0x32, 0, 0x0d, 0x0a, 0x1a, 0x0a], 4);
  view.setInt16(12, datatype, littleEndian);
  view.setInt16(14, bytesPerVoxel * 8, littleEndian);
  writeInt64(16, timepoints > 1 ? 4 : 3);
  writeInt64(24, 2);
  writeInt64(32, 2);
  writeInt64(40, 1);
  writeInt64(48, timepoints);
  writeFloat64(112, pixdim[0]);
  writeFloat64(120, pixdim[1]);
  writeFloat64(128, pixdim[2]);
  writeFloat64(136, timeSpacing);
  writeInt64(168, dataOffset);
  writeFloat64(176, sclSlope);
  writeFloat64(184, sclInter);
  writeFloat64(216, timeOffset);
  view.setInt32(348, 1, littleEndian);
  writeFloat64(400, pixdim[0]);
  writeFloat64(440, pixdim[1]);
  writeFloat64(480, pixdim[2]);
  writeFloat64(424, 10);
  writeFloat64(456, 20);
  writeFloat64(488, 30);
  view.setInt32(500, xyztUnits, littleEndian);
  values.forEach((value, index) => {
    const offset = dataOffset + index * bytesPerVoxel;
    if (datatype === 2) view.setUint8(offset, value);
    else if (datatype === 256) view.setInt8(offset, value);
    else if (datatype === 4) view.setInt16(offset, value, littleEndian);
    else if (datatype === 512) view.setUint16(offset, value, littleEndian);
    else if (datatype === 8) view.setInt32(offset, value, littleEndian);
    else if (datatype === 16) view.setFloat32(offset, value, littleEndian);
    else if (datatype === 64) view.setFloat64(offset, value, littleEndian);
    else if (datatype === 768) view.setUint32(offset, value, littleEndian);
  });
  return { name, async arrayBuffer() { return buffer; } };
}

function tiny4dNiftiFile({
  values = [0, 10, 20, 30, 100, 110, 120, 130],
  timeSpacing = 2,
  timeOffset = 0.5,
  name = 'fmri-timeseries.nii',
} = {}) {
  const buffer = new ArrayBuffer(352 + values.length * 2);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  new Uint8Array(buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  view.setInt16(40, 4, true);
  view.setInt16(42, 2, true);
  view.setInt16(44, 2, true);
  view.setInt16(46, 1, true);
  view.setInt16(48, 2, true);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  view.setFloat32(80, 2, true);
  view.setFloat32(84, 3, true);
  view.setFloat32(88, 4, true);
  view.setFloat32(92, timeSpacing, true);
  view.setFloat32(108, 352, true);
  view.setUint8(123, 10); // millimeters + seconds
  view.setFloat32(136, timeOffset, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, 2, true);
  view.setFloat32(292, 10, true);
  view.setFloat32(300, 3, true);
  view.setFloat32(308, 20, true);
  view.setFloat32(320, 4, true);
  view.setFloat32(324, 30, true);
  values.forEach((value, index) => view.setInt16(352 + index * 2, value, true));
  return { name, async arrayBuffer() { return buffer; } };
}

function gzipFile(source, name = 'tiny.nii.gz') {
  return source.arrayBuffer().then((buffer) => {
    const gzipped = gzipSync(new Uint8Array(buffer));
    return {
      name,
      size: gzipped.byteLength,
      async arrayBuffer() {
        return gzipped.buffer.slice(gzipped.byteOffset, gzipped.byteOffset + gzipped.byteLength);
      },
    };
  });
}

test('parseNIfTI decodes supported scalar datatypes and header byte orders', async () => {
  const cases = [
    { datatype: 2, values: [0, 1, 2, 4] },
    { datatype: 256, values: [-4, -2, 0, 4] },
    { datatype: 4, values: [-2, 0, 2, 6] },
    { datatype: 8, values: [-10, 0, 10, 30] },
    { datatype: 16, values: [0, 0.5, 1, 2] },
    { datatype: 64, values: [1, 2, 3, 5] },
    { datatype: 512, values: [0, 256, 512, 1024] },
    { datatype: 768, values: [0, 1_000, 2_000, 4_000] },
  ];
  await withDocumentStub(async () => {
    const bigEndian = await parseNIfTI(tinyNiftiFile({ littleEndian: false }));
    assert.equal(bigEndian.entry.name, 'tiny-be');
    assert.deepEqual(Array.from(bigEndian.rawVolume), [0, 0.25, 0.5, 1]);
    for (const item of cases) {
      const result = await parseNIfTI(tinyNiftiFile({ ...item, name: `datatype-${item.datatype}.nii` }));
      assert.deepEqual(Array.from(result.rawVolume, value => Number(value.toFixed(6))), [0, 0.25, 0.5, 1]);
    }
  });
});

test('parseNIfTI preserves adjacent high Uint32 values through Number-domain normalization', async () => {
  await withDocumentStub(async () => {
    const low = 4_294_967_294;
    const high = 4_294_967_295;
    for (const littleEndian of [true, false]) {
      const result = await parseNIfTI(tinyNiftiFile({
        littleEndian,
        datatype: 768,
        values: [low, high, low, high],
        name: `high-uint32-${littleEndian ? 'le' : 'be'}.nii`,
      }));
      assert.deepEqual(result.entry._niftiValueRange, {
        min: low, max: high, windowMin: low, windowMax: high,
      });
      assert.deepEqual(Array.from(result.rawVolume), [0, 1, 0, 1]);
    }
  });
});

test('parseNIfTI rejects finite Float64 values whose normalization span overflows', async () => {
  await assert.rejects(
    () => parseNIfTI(tinyNiftiFile({
      datatype: 64,
      values: [-1e308, 1e308, -1e308, 1e308],
      name: 'overflowing-range.nii',
    })),
    /voxel value range exceeds finite normalization precision/,
  );
});

test('parseNIfTI requires single-file magic and explicitly rejects paired-file magic', async () => {
  const missing = tinyNiftiFile({ name: 'missing-magic.nii' });
  new Uint8Array(await missing.arrayBuffer()).fill(0, 344, 348);
  await assert.rejects(() => parseNIfTI(missing), /single-file NIfTI-1 magic n\+1\\0 is required/);

  const paired = tinyNiftiFile({ name: 'paired-header.hdr' });
  new Uint8Array(await paired.arrayBuffer()).set([0x6e, 0x69, 0x31, 0], 344);
  await assert.rejects(() => parseNIfTI(paired), /paired-file magic ni1\\0 is not supported/);
});

test('parseNIfTI imports single-file NIfTI-2 with calibrated sform, scaling, and byte order', async () => {
  await withDocumentStub(async () => {
    for (const littleEndian of [true, false]) {
      const result = await parseNIfTI(tinyNifti2File({ littleEndian, name: `nifti2-${littleEndian ? 'le' : 'be'}.nii` }));
      assert.equal(result.entry._niftiVersion, 2);
      assert.deepEqual(result.entry.pixelSpacing, [3, 2]);
      assert.equal(result.entry.sliceThickness, 4);
      assert.deepEqual(result.entry.firstIPP, [-10, -20, 30]);
      assert.deepEqual(
        result.entry._niftiSpatialAffineLps.map(row => row.map(value => (Object.is(value, -0) ? 0 : value))),
        [[-2, 0, 0, -10], [0, -3, 0, -20], [0, 0, 4, 30]],
      );
      assert.deepEqual(Array.from(result.rawVolume), [0, 0.25, 0.5, 1]);
    }
    const gzipped = await gzipFile(tinyNifti2File(), 'tiny-nifti2.nii.gz');
    assert.equal((await parseNIfTI(gzipped)).entry._niftiVersion, 2);
  });
});

test('parseNIfTISeries gives NIfTI-2 dim-4 inputs the bounded shared timepoint path', async () => {
  await withDocumentStub(async () => {
    const results = await parseNIfTISeries(tinyNifti2File({
      values: [0, 10, 20, 30, 40, 50, 60, 70],
      xyztUnits: 10,
      timepoints: 2,
      timeSpacing: 1.5,
      timeOffset: 0.25,
      name: 'nifti2-timeseries.nii',
    }));
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(result => result.entry._niftiTimeIndex), [0, 1]);
    assert.deepEqual(results.map(result => result.entry._niftiTemporalSpacing), [1.5, 1.5]);
    assert.deepEqual(results.map(result => result.entry._niftiTemporalUnit), ['second', 'second']);
    assert.deepEqual(results.map(result => result.entry._niftiTimeOffset), [0.25, 0.25]);

    const low = 4_294_967_294;
    const high = 4_294_967_295;
    const uint32Results = await parseNIfTISeries(tinyNifti2File({
      datatype: 768,
      values: [low, high, low, high, high, low, high, low],
      timepoints: 2,
      name: 'nifti2-uint32-timeseries.nii',
    }));
    assert.deepEqual(uint32Results[0].entry._niftiValueRange, {
      min: low * 2 - 10,
      max: high * 2 - 10,
      windowMin: low * 2 - 10,
      windowMax: high * 2 - 10,
    });
    assert.deepEqual(uint32Results.map(result => Array.from(result.rawVolume)), [
      [0, 1, 0, 1],
      [1, 0, 1, 0],
    ]);

    const frequencyAxis = tinyNifti2File({ values: new Array(8).fill(1), timepoints: 2, xyztUnits: 34 });
    await assert.rejects(() => parseNIfTISeries(frequencyAxis), /frequency unit hertz is not a supported time axis/);

    const nonSingletonDim5 = tinyNifti2File();
    const dim5View = new DataView(await nonSingletonDim5.arrayBuffer());
    dim5View.setBigInt64(16, 5n, true);
    dim5View.setBigInt64(56, 2n, true);
    await assert.rejects(() => parseNIfTISeries(nonSingletonDim5), /only a singleton dim\[5\+\] is supported/);
  });
});

test('parseNIfTI keeps paired and oversized NIfTI-2 headers fail closed', async () => {
  const paired = tinyNifti2File();
  new Uint8Array(await paired.arrayBuffer()).set([0x6e, 0x69, 0x32, 0, 0x0d, 0x0a, 0x1a, 0x0a], 4);
  await assert.rejects(() => parseNIfTI(paired), /paired-file magic ni2\\0 is not supported/);

  const unsafe = tinyNifti2File();
  new DataView(await unsafe.arrayBuffer()).setBigInt64(24, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
  await assert.rejects(() => parseNIfTI(unsafe), /dim\[1\] must be a non-negative safe integer/);
});

test('parseNIfTI keeps NIfTI-2 unknown units and shear on existing fail-closed paths', async () => {
  await withDocumentStub(async () => {
    const unknownUnits = await parseNIfTI(tinyNifti2File({ xyztUnits: 0, name: 'nifti2-unknown-units.nii' }));
    assert.deepEqual(unknownUnits.entry.pixelSpacing, [0, 0]);
    assert.equal(unknownUnits.entry._spacingKnown, false);

    const sheared = tinyNifti2File({ name: 'nifti2-sheared.nii' });
    new DataView(await sheared.arrayBuffer()).setFloat64(408, 0.1, true);
    await assert.rejects(() => parseNIfTI(sheared), /declared affine contains unsupported shear or non-orthogonal axes/);
  });
});

test('parseNIfTISeries imports 4D timepoints with exact shared geometry and one global value range', async () => {
  await withDocumentStub(async () => {
    const results = await parseNIfTISeries(tiny4dNiftiFile());
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(result => result.entry.name), [
      'fmri-timeseries · time 1/2',
      'fmri-timeseries · time 2/2',
    ]);
    assert.deepEqual(results.map(result => result.entry._niftiTimeIndex), [0, 1]);
    assert.deepEqual(results.map(result => result.entry._niftiTemporalSpacing), [2, 2]);
    assert.deepEqual(results.map(result => result.entry._niftiTemporalUnit), ['second', 'second']);
    assert.deepEqual(results.map(result => result.entry._niftiTimeOffset), [0.5, 0.5]);
    assert.deepEqual(results[0].entry.pixelSpacing, [3, 2]);
    assert.equal(results[0].entry.sliceThickness, 4);
    assert.deepEqual(
      results[0].entry._niftiSpatialAffineLps.map(row => row.map(value => (Object.is(value, -0) ? 0 : value))),
      [[-2, 0, 0, -10], [0, -3, 0, -20], [0, 0, 4, 30]],
    );
    assert.deepEqual(results[1].entry._niftiSpatialAffineLps, results[0].entry._niftiSpatialAffineLps);
    assert.deepEqual(results[0].entry._niftiValueRange, { min: 0, max: 130, windowMin: 0, windowMax: 130 });
    assert.deepEqual(results[1].entry._niftiValueRange, results[0].entry._niftiValueRange);
    assert.deepEqual(Array.from(results[0].rawVolume, value => Number(value.toFixed(6))), [0, 0.076923, 0.153846, 0.230769]);
    assert.deepEqual(Array.from(results[1].rawVolume, value => Number(value.toFixed(6))), [0.769231, 0.846154, 0.923077, 1]);
  });
});

test('parseNIfTI keeps its single-result API fail closed for 4D callers', async () => {
  await assert.rejects(() => parseNIfTI(tiny4dNiftiFile()), /4D NIfTI imports produce multiple series; use parseNIfTISeries/);
});

test('parseNIfTISeries rejects frequency axes and leaves unknown temporal spacing untrusted', async () => {
  for (const [code, label] of [[34, 'hertz'], [42, 'parts per million']]) {
    const file = tiny4dNiftiFile({ name: `${label}.nii` });
    new DataView(await file.arrayBuffer()).setUint8(123, code);
    await assert.rejects(() => parseNIfTISeries(file), new RegExp(`frequency unit ${label}`));
  }
  await withDocumentStub(async () => {
    const file = tiny4dNiftiFile({ name: 'unknown-time-unit.nii' });
    new DataView(await file.arrayBuffer()).setUint8(123, 2);
    const [result] = await parseNIfTISeries(file);
    assert.equal(result.entry._niftiTemporalUnit, 'unknown');
    assert.equal(result.entry._niftiTemporalUnitCode, 0);
    assert.equal(result.entry._niftiTemporalSpacingKnown, false);
  });
});

test('parseNIfTISeries rejects dim5+ and oversized dimensions before payload allocation', async () => {
  const dim5 = tiny4dNiftiFile();
  const dim5View = new DataView(await dim5.arrayBuffer());
  dim5View.setInt16(40, 5, true);
  dim5View.setInt16(50, 2, true);
  await assert.rejects(() => parseNIfTISeries(dim5), /only a singleton dim\[5\+\] is supported/);

  const oversized = tiny4dNiftiFile();
  const oversizedView = new DataView(await oversized.arrayBuffer());
  oversizedView.setInt16(42, 4096, true);
  oversizedView.setInt16(44, 4096, true);
  oversizedView.setInt16(48, 3, true);
  await assert.rejects(() => parseNIfTISeries(oversized), /total voxels .* exceed/);
});

test('parseNIfTI rejects invalid qform spacing, quaternion norms, degenerate columns, and shear', async () => {
  const invalidSpacing = tinyNiftiFile({ name: 'zero-spacing.nii' });
  new DataView(await invalidSpacing.arrayBuffer()).setFloat32(80, 0, true);
  await assert.rejects(() => parseNIfTI(invalidSpacing), /pixdim\[1\.\.3\] must contain positive finite spatial spacing/);

  const invalidQuaternion = tinyNiftiFile({ name: 'invalid-quaternion.nii' });
  const quaternionView = new DataView(await invalidQuaternion.arrayBuffer());
  quaternionView.setInt16(252, 1, true);
  quaternionView.setFloat32(256, 0.8, true);
  quaternionView.setFloat32(260, 0.8, true);
  await assert.rejects(() => parseNIfTI(invalidQuaternion), /qform quaternion norm exceeds 1/);

  const degenerate = tinyNiftiFile({ name: 'degenerate-sform.nii' });
  const degenerateView = new DataView(await degenerate.arrayBuffer());
  degenerateView.setInt16(254, 1, true);
  degenerateView.setFloat32(280, 1, true);
  degenerateView.setFloat32(300, 1, true);
  await assert.rejects(() => parseNIfTI(degenerate), /declared affine contains a degenerate spatial column/);

  const sheared = tinyNiftiFile({ name: 'sheared-sform.nii' });
  const shearView = new DataView(await sheared.arrayBuffer());
  shearView.setInt16(254, 1, true);
  shearView.setFloat32(280, 1, true);
  shearView.setFloat32(284, 0.1, true);
  shearView.setFloat32(300, 1, true);
  shearView.setFloat32(320, 1, true);
  await assert.rejects(() => parseNIfTI(sheared), /declared affine contains unsupported shear or non-orthogonal axes/);
});

test('parseNIfTI tolerates only small qform quaternion rounding error', async () => {
  await withDocumentStub(async () => {
    const file = tinyNiftiFile({ name: 'rounded-quaternion.nii' });
    const view = new DataView(await file.arrayBuffer());
    view.setInt16(252, 1, true);
    view.setFloat32(256, 1.000001, true);
    const result = await parseNIfTI(file);
    assert.ok(result);
    assert.equal(result.entry._spacingKnown, true);
  });
});

test('parseNIfTI applies negative qfac only to the qform slice axis', async () => {
  await withDocumentStub(async () => {
    const file = tinyNiftiFile({
      name: 'negative-qfac.nii',
      pixdim: [2, 3, 4],
      values: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    const view = new DataView(await file.arrayBuffer());
    view.setInt16(46, 2, true);
    view.setFloat32(76, -1, true);
    view.setInt16(252, 1, true);
    view.setFloat32(256, Math.SQRT1_2, true);
    const result = await parseNIfTI(file);

    assert.deepEqual(result.entry.pixelSpacing.map(value => Number(value.toFixed(6))), [3, 2]);
    assert.equal(Number(result.entry.sliceThickness.toFixed(6)), 4);
    assert.deepEqual(
      result.entry.orientation.map(value => Number(value.toFixed(6)) || 0),
      [-1, 0, 0, 0, 0, 1],
    );
    assert.deepEqual(result.entry.lastIPP.map(value => Number(value.toFixed(6)) || 0), [0, -4, 0]);
  });
});

test('parseNIfTISeries enforces decoded and modeled working-set caps before large allocations', async () => {
  await assert.rejects(
    () => parseNIfTISeries(tiny4dNiftiFile(), () => {}, { maxWorkingSetBytes: 8_000 }),
    /NIfTI import working set .* exceeds the 8000 byte working-set limit/,
  );
  const compressed = await gzipFile(tinyNiftiFile(), 'bounded.nii.gz');
  await assert.rejects(
    () => parseNIfTISeries(compressed, () => {}, { maxDecodedBytes: 128 }),
    /decompressed input exceeds the 128 byte limit/,
  );
});

test('parseNIfTISeries rejects a near-limit stack before allocating display canvases', async () => {
  const nx = 4096;
  const ny = 4096;
  const nz = 1;
  const timepoints = 2;
  const buffer = new ArrayBuffer(352 + nx * ny * nz * timepoints);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  new Uint8Array(buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  view.setInt16(40, 4, true);
  view.setInt16(42, nx, true);
  view.setInt16(44, ny, true);
  view.setInt16(46, nz, true);
  view.setInt16(48, timepoints, true);
  view.setInt16(70, 2, true);
  view.setInt16(72, 8, true);
  view.setFloat32(80, 1, true);
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setFloat32(108, 352, true);
  view.setUint8(123, 2);
  let canvasAllocations = 0;
  const previousDocument = globalThis.document;
  globalThis.document = { createElement() { canvasAllocations += 1; return createCanvasStub(); } };
  try {
    await assert.rejects(
      () => parseNIfTISeries({ name: 'near-limit.nii', size: buffer.byteLength, async arrayBuffer() { return buffer; } }),
      /NIfTI import working set .* exceeds the 402653184 byte working-set limit/,
    );
    assert.equal(canvasAllocations, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('parseNIfTI generates distinct slugs for same-tick imports', async () => {
  await withDocumentStub(async () => {
    const originalNow = Date.now;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Date.now = () => 1_700_000_000_000;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    try {
      const first = await parseNIfTI(tinyNiftiFile({ name: 'first.nii' }));
      const second = await parseNIfTI(tinyNiftiFile({ name: 'second.nii' }));
      assert.notEqual(first.entry.slug, second.entry.slug);
    } finally {
      Date.now = originalNow;
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      else delete globalThis.crypto;
    }
  });
});

test('parseNIfTI uses native gzip streams and the bounded Pako fallback', async () => {
  await withDocumentStub(async () => {
    const nativeDecompressionStream = globalThis.DecompressionStream;
    assert.equal(typeof nativeDecompressionStream, 'function');
    const formats = [];
    globalThis.DecompressionStream = class CountingDecompressionStream {
      constructor(format) {
        formats.push(format);
        return new nativeDecompressionStream(format);
      }
    };
    try {
      const nativeResult = await parseNIfTI(await gzipFile(tinyNiftiFile(), 'native.nii.gz'));
      assert.deepEqual(Array.from(nativeResult.rawVolume), [0, 0.25, 0.5, 1]);
      assert.deepEqual(formats, ['gzip']);
      globalThis.DecompressionStream = undefined;
      const pakoResult = await parseNIfTI(await gzipFile(tinyNiftiFile(), 'pako.nii.gz'));
      assert.deepEqual(Array.from(pakoResult.rawVolume), [0, 0.25, 0.5, 1]);
    } finally {
      globalThis.DecompressionStream = nativeDecompressionStream;
    }
  });
});

test('parseNIfTI fails closed on corrupt gzip input', async () => {
  const compressed = await gzipFile(tinyNiftiFile(), 'corrupt.nii.gz');
  const corrupt = new Uint8Array(await compressed.arrayBuffer());
  corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
  await assert.rejects(
    () => parseNIfTI({ name: compressed.name, size: corrupt.byteLength, async arrayBuffer() { return corrupt.buffer; } }),
    /gzip input could not be decompressed|gzip output does not match|incorrect data check/i,
  );
});

test('parseNIfTI preserves spatial unit calibration and exact sform RAS-to-LPS geometry', async () => {
  await withDocumentStub(async () => {
    const meters = await parseNIfTI(tinyNiftiFile({ name: 'meter-units.nii', xyztUnits: 1, pixdim: [0.002, 0.003, 0.004] }));
    assert.deepEqual(meters.entry.pixelSpacing.map(value => Number(value.toFixed(6))), [3, 2]);
    assert.equal(Number(meters.entry.sliceThickness.toFixed(6)), 4);

    const file = tinyNiftiFile({ name: 'ras-sform.nii', xyztUnits: 3 });
    const view = new DataView(await file.arrayBuffer());
    view.setInt16(254, 1, true);
    view.setFloat32(280, 2000, true);
    view.setFloat32(292, 10000, true);
    view.setFloat32(300, 3000, true);
    view.setFloat32(308, 20000, true);
    view.setFloat32(320, 4000, true);
    view.setFloat32(324, 30000, true);
    const result = await parseNIfTI(file);
    assert.deepEqual(result.entry.pixelSpacing, [3, 2]);
    assert.deepEqual(result.entry.orientation.map(value => (Object.is(value, -0) ? 0 : value)), [-1, 0, 0, 0, -1, 0]);
    assert.deepEqual(result.entry.firstIPP, [-10, -20, 30]);
  });
});

test('parseNIfTI leaves unknown spatial units uncalibrated', async () => {
  await withDocumentStub(async () => {
    const result = await parseNIfTI(tinyNiftiFile({ name: 'unknown-units.nii', xyztUnits: 0, pixdim: [2, 3, 4] }));
    assert.deepEqual(result.entry.pixelSpacing, [0, 0]);
    assert.equal(result.entry.sliceThickness, 0);
    assert.equal(result.entry._spacingKnown, false);
    assert.equal(calibratedScaleBarModel(result.entry, {
      canvasCssWidth: result.entry.width,
      imageWidth: result.entry.width,
      zoom: 1,
    }), null);
  });
});
