import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { streamOmeZarrFromUrl, streamProvenanceText } from '../js/microscopy/zarr/zarr-stream-import.js';
import { ZarrUnsupportedCodecError } from '../js/microscopy/zarr/zarr-codecs.js';

const FIXTURE_BYTES = new Uint8Array(readFileSync(
  fileURLToPath(new URL('./fixtures/zarr/idr0062A-6001240-L0-c0z0.blosc', import.meta.url)),
));
const GOLDEN = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/zarr/idr0062A-6001240-L0-c0z0.golden.json', import.meta.url)),
  'utf8',
));
// The fixture chunk is one full CZYX plane: shape [1,1,275,271], chunks [1,1,275,271].
const PLANE_WIDTH = 271;
const PLANE_HEIGHT = 275;

const BASE_URL = 'https://idr.example.test/idr0062A/6001240.zarr';

const BLOSC_COMPRESSOR = { id: 'blosc', cname: 'lz4', shuffle: 1, clevel: 5, blocksize: 0 };

const CZYX_AXES = [
  { name: 'c', type: 'channel' },
  { name: 'z', type: 'space', unit: 'micrometer' },
  { name: 'y', type: 'space', unit: 'micrometer' },
  { name: 'x', type: 'space', unit: 'micrometer' },
];

// Three pyramid levels; the coarsest (level 2) is the committed fixture plane and is the only
// array whose chunk is ever fetched, so the test stays hermetic on one real decoded chunk.
function arrayMeta({ width, height, shape = [1, 1, height, width], compressor = BLOSC_COMPRESSOR, dtype = '<u2' } = {}) {
  return {
    zarr_format: 2,
    shape,
    chunks: [1, 1, height, width],
    dtype,
    compressor,
    filters: null,
    order: 'C',
    dimension_separator: '/',
    fill_value: 0,
  };
}

function rootAttrs(scaleLevel2 = [1, 1, 2, 2], version = '0.4') {
  return {
    ome: {
      version,
      multiscales: [{
        name: '6001240',
        axes: CZYX_AXES,
        datasets: [
          { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 0.5, 0.5] }] },
          { path: '1', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 1] }] },
          { path: '2', coordinateTransformations: [{ type: 'scale', scale: scaleLevel2 }] },
        ],
      }],
      omero: {
        channels: [{
          label: 'DAPI',
          color: '0000FF',
          family: 'linear',
          window: { min: 0, max: 4095, start: 6, end: 132 },
        }],
      },
    },
  };
}

function jsonResponse(body) {
  return {
    status: 200,
    ok: true,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function bytesResponse(bytes) {
  return {
    status: 200,
    ok: true,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function float32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return new Uint8Array(buffer);
}

function scalar32Bytes(dtype, values) {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  const littleEndian = dtype[0] !== '>';
  values.forEach((value, index) => {
    if (dtype[1] === 'i') view.setInt32(index * 4, value, littleEndian);
    else view.setUint32(index * 4, value, littleEndian);
  });
  return new Uint8Array(buffer);
}

function notFound() {
  return { status: 404, ok: false, async json() { return null; }, async text() { return ''; } };
}

function routeFetch(routes) {
  return async (url) => routes.get(url) || notFound();
}

// Mock fetchImpl: serves synthetic multiscale metadata + the one committed fixture chunk.
// Level 0/1 .zarray are large (won't be selected); level 2 is the fixture plane. Only the
// chosen level's chunk (2/0/0/0/0) is ever fetched.
function mockFetch({ scaleLevel2 = [1, 1, 2, 2], coarsestShape, coarsestCompressor = BLOSC_COMPRESSOR, calls = [], version = '0.4' } = {}) {
  const routes = new Map([
    [`${BASE_URL}/.zattrs`, () => jsonResponse(rootAttrs(scaleLevel2, version))],
    [`${BASE_URL}/.zgroup`, () => jsonResponse({ zarr_format: 2 })],
    [`${BASE_URL}/0/.zarray`, () => jsonResponse(arrayMeta({ width: PLANE_WIDTH * 4, height: PLANE_HEIGHT * 4 }))],
    [`${BASE_URL}/1/.zarray`, () => jsonResponse(arrayMeta({ width: PLANE_WIDTH * 2, height: PLANE_HEIGHT * 2 }))],
    [`${BASE_URL}/2/.zarray`, () => jsonResponse(arrayMeta({ width: PLANE_WIDTH, height: PLANE_HEIGHT, shape: coarsestShape, compressor: coarsestCompressor }))],
    [`${BASE_URL}/2/0/0/0/0`, () => bytesResponse(FIXTURE_BYTES)],
  ]);
  return async (url) => {
    calls.push(url);
    const route = routes.get(url);
    return route ? route() : notFound();
  };
}

function installCanvasStub() {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(image) { canvas._imageData = image; },
          };
        },
      };
      return canvas;
    },
  };
  return () => { globalThis.document = previousDocument; };
}

test('streams the coarsest fitting level, builds a real plane, and returns a valid series entry', async () => {
  const restore = installCanvasStub();
  const calls = [];
  const stages = [];
  try {
    const { results, selection, levels, codec, provenance } = await streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: mockFetch({ calls }),
      onProgress: (stage, detail) => stages.push(`${stage}:${detail}`),
    });

    // Level selection: coarsest of 3 levels within the 4M pixel budget = level 2 (downsample x4).
    assert.equal(selection.level, 2);
    assert.equal(selection.path, '2');
    assert.equal(selection.width, PLANE_WIDTH);
    assert.equal(selection.height, PLANE_HEIGHT);
    assert.equal(selection.downsample, 4);
    assert.equal(levels.length, 3);

    // Only the chosen level's chunk is fetched; coarse levels open without touching full res.
    assert.ok(calls.includes(`${BASE_URL}/2/0/0/0/0`));
    assert.ok(!calls.some((url) => url.startsWith(`${BASE_URL}/0/0`)));
    assert.ok(!calls.some((url) => url.startsWith(`${BASE_URL}/1/0`)));
    assert.ok(!calls.some((url) => url.endsWith('/zarr.json')));

    assert.equal(results.length, 1);
    const [result] = results;
    const { entry } = result;
    assert.equal(entry.imageDomain, 'microscopy');
    assert.equal(entry.modality, 'MIC');
    assert.equal(entry.width, PLANE_WIDTH);
    assert.equal(entry.height, PLANE_HEIGHT);
    assert.equal(entry.slices, 1);
    assert.equal(entry.microscopy.format, 'OME-Zarr');

    // Plane pixels decode bit-exactly from the real fixture chunk.
    const rawPlane = result.rawPlanes['0|0'][0];
    assert.equal(rawPlane.width, PLANE_WIDTH);
    assert.equal(rawPlane.height, PLANE_HEIGHT);
    assert.equal(rawPlane.pixels.length, PLANE_WIDTH * PLANE_HEIGHT);
    assert.deepEqual(Array.from(rawPlane.pixels.slice(0, 8)), GOLDEN.first8);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const value of rawPlane.pixels) {
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
    assert.equal(min, GOLDEN.min);
    assert.equal(max, GOLDEN.max);
    assert.equal(sum, GOLDEN.sum);

    // Downsample-aware calibration: level 2 scale is 2.0 µm/px, NOT level 0's 0.5 µm/px.
    assert.equal(entry.microscopy.physicalSizeX, 2);
    assert.equal(entry.microscopy.physicalSizeY, 2);
    assert.equal(entry.physicalUnit, 'µm');
    assert.ok(Math.abs(entry.pixelSpacing[0] - 0.002) < 1e-9, `row spacing mm ${entry.pixelSpacing[0]}`);
    assert.ok(Math.abs(entry.pixelSpacing[1] - 0.002) < 1e-9, `col spacing mm ${entry.pixelSpacing[1]}`);

    // Provenance labels the streamed level/downsample and codec.
    assert.match(codec, /blosc\(lz4, byte-shuffle\)/);
    assert.equal(provenance, entry.microscopy.streamProvenance);
    assert.match(provenance, /OME-Zarr v2 streamed · level 3\/3 · ×4 downsample · blosc\(lz4, byte-shuffle\)/);
    assert.equal(entry.microscopy.streaming.downsample, 4);
    assert.deepEqual(entry.microscopyDataset.levels.map(level => level.downsample), [1, 2, 4]);

    assert.ok(stages.some((s) => s.startsWith('metadata:')));
    assert.ok(stages.some((s) => s.startsWith('level:')));
    assert.ok(stages.some((s) => s === 'planes:1/1'));
  } finally {
    restore();
  }
});

test('streams full-shape Zarr v2 edge chunks and clips only their logical overhang', async () => {
  const restore = installCanvasStub();
  const attrs = {
    ome: {
      version: '0.4',
      multiscales: [{
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
      }],
    },
  };
  const meta = {
    zarr_format: 2,
    shape: [1, 3, 4],
    chunks: [1, 2, 3],
    dtype: '|u1',
    compressor: null,
    filters: null,
    order: 'C',
    dimension_separator: '.',
  };
  const routes = new Map([
    [`${BASE_URL}/.zattrs`, jsonResponse(attrs)],
    [`${BASE_URL}/.zgroup`, jsonResponse({ zarr_format: 2 })],
    [`${BASE_URL}/0/.zarray`, jsonResponse(meta)],
    [`${BASE_URL}/0/0.0.0`, bytesResponse(Uint8Array.from([0, 1, 2, 10, 11, 12]))],
    [`${BASE_URL}/0/0.0.1`, bytesResponse(Uint8Array.from([3, 250, 250, 13, 250, 250]))],
    [`${BASE_URL}/0/0.1.0`, bytesResponse(Uint8Array.from([20, 21, 22, 250, 250, 250]))],
    [`${BASE_URL}/0/0.1.1`, bytesResponse(Uint8Array.from([23, 250, 250, 250, 250, 250]))],
  ]);
  try {
    const result = await streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: routeFetch(routes),
      onProgress: () => {},
    });
    const pixels = result.results[0].rawPlanes['0|0'][0].pixels;

    assert.deepEqual(Array.from(pixels), [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
  } finally {
    restore();
  }
});

for (const [dtype, values, ArrayType] of [
  ['<i4', [16_777_216, 16_777_217], Int32Array],
  ['>u4', [4_000_000_000, 4_000_000_001], Uint32Array],
]) {
  test(`streams ${dtype} scalar values without Float32 narrowing`, async () => {
    const restore = installCanvasStub();
    const attrs = {
      ome: {
        version: '0.4',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    };
    const meta = {
      zarr_format: 2,
      shape: [1, 1, 2],
      chunks: [1, 1, 2],
      dtype,
      compressor: null,
      filters: null,
      order: 'C',
      fill_value: 0,
    };
    const routes = new Map([
      [`${BASE_URL}/.zattrs`, jsonResponse(attrs)],
      [`${BASE_URL}/.zgroup`, jsonResponse({ zarr_format: 2 })],
      [`${BASE_URL}/0/.zarray`, jsonResponse(meta)],
      [`${BASE_URL}/0/0.0.0`, bytesResponse(scalar32Bytes(dtype, values))],
    ]);
    try {
      const streamed = await streamOmeZarrFromUrl(BASE_URL, { fetchImpl: routeFetch(routes) });
      const pixels = streamed.results[0].rawPlanes['0|0'][0].pixels;
      assert.equal(pixels instanceof ArrayType, true);
      assert.deepEqual(Array.from(pixels), values);
      assert.equal(streamed.results[0].entry.microscopyDataset.pixel.type, dtype === '<i4' ? 'int32' : 'uint32');
    } finally {
      restore();
    }
  });
}

test('streams a Zarr v3 array with artifact chunk metadata from regular chunk_grid', async () => {
  const restore = installCanvasStub();
  const root = {
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      ome: {
        version: '0.5',
        multiscales: [{
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      },
    },
  };
  const array = {
    zarr_format: 3,
    node_type: 'array',
    shape: [1, 2, 2],
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 1, 1] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
  };
  const routes = new Map([
    [`${BASE_URL}/zarr.json`, jsonResponse(root)],
    [`${BASE_URL}/0/zarr.json`, jsonResponse(array)],
    [`${BASE_URL}/0/c/0/0/0`, bytesResponse(float32Bytes(1.5))],
    [`${BASE_URL}/0/c/0/0/1`, bytesResponse(float32Bytes(2.5))],
    [`${BASE_URL}/0/c/0/1/0`, bytesResponse(float32Bytes(3.5))],
    [`${BASE_URL}/0/c/0/1/1`, bytesResponse(float32Bytes(4.5))],
  ]);
  try {
    const calls = [];
    const streamed = await streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: async (url) => {
        calls.push(url);
        return routeFetch(routes)(url);
      },
    });
    const result = streamed.results[0];
    assert.deepEqual(Array.from(result.rawPlanes['0|0'][0].pixels), [1.5, 2.5, 3.5, 4.5]);
    assert.deepEqual(result.entry.microscopyDataset.levels[0].chunkShape, { t: 1, c: 1, z: 1, y: 1, x: 1 });
    assert.equal(result.entry.microscopyDataset.levels[0].tileWidth, 1);
    assert.equal(result.entry.microscopyDataset.levels[0].tileHeight, 1);
    assert.equal(result.entry.microscopy.streaming.zarrVersion, 3);
    assert.ok(!calls.some((url) => url.endsWith('/.zarray')));
  } finally {
    restore();
  }
});

test('marks NGFF 0.5 metadata on streamed Zarr v2 arrays as nonconforming compatibility input', async () => {
  const restore = installCanvasStub();
  try {
    const { results } = await streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: mockFetch({ version: '0.5' }),
      onProgress: () => {},
    });

    assert.equal(
      results[0].entry.microscopyDataset.source.warnings.includes(
        'Nonconforming OME-Zarr 0.5 metadata on a Zarr v2 array loaded in compatibility mode',
      ),
      true,
    );
  } finally {
    restore();
  }
});

test('fails closed with a named reason on an unsupported codec', async () => {
  const restore = installCanvasStub();
  try {
    await assert.rejects(
      streamOmeZarrFromUrl(BASE_URL, {
        fetchImpl: mockFetch({ coarsestCompressor: { id: 'blosc', cname: 'snappy', shuffle: 1 } }),
        onProgress: () => {},
      }),
      (error) => {
        assert.ok(error instanceof ZarrUnsupportedCodecError, `expected ZarrUnsupportedCodecError, got ${error?.name}`);
        assert.match(error.reason, /Blosc cname 'snappy'/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fails closed before chunk fetches when no pyramid level fits the plane budget', async () => {
  const calls = [];
  await assert.rejects(
    streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: mockFetch({ calls }),
      maxPlanePixels: 10,
      onProgress: () => {},
    }),
    (error) => {
      assert.ok(error instanceof ZarrUnsupportedCodecError);
      assert.match(error.reason, /No pyramid level fits 10 pixel budget/);
      return true;
    },
  );
  assert.ok(!calls.some(url => /\/2\/0\/0\/0\/0$/.test(url)), 'resource rejection must not fetch chunks');
});

test('fails closed before chunk fetches when selected planes exceed the aggregate allocation budget', async () => {
  const calls = [];
  await assert.rejects(
    streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: mockFetch({ calls, coarsestShape: [1, 300, PLANE_HEIGHT, PLANE_WIDTH] }),
      onProgress: () => {},
    }),
    (error) => {
      assert.ok(error instanceof ZarrUnsupportedCodecError);
      assert.match(error.reason, /aggregate plane pixels/);
      return true;
    },
  );
  assert.ok(!calls.some(url => /\/2\/0\/0\/0\/0$/.test(url)), 'aggregate rejection must not fetch chunks');
});

test('fails closed before chunk fetches when a selected custom axis is non-singleton', async () => {
  const calls = [];
  const axes = [
    { name: 'phase', type: 'custom' },
    { name: 'y', type: 'space', unit: 'micrometer' },
    { name: 'x', type: 'space', unit: 'micrometer' },
  ];
  const array = {
    zarr_format: 2,
    shape: [100_000_000, 1, 1],
    chunks: [100_000_000, 1, 1],
    dtype: '|u1',
    compressor: null,
    filters: null,
    order: 'C',
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/.zattrs')) {
      return jsonResponse({ ome: {
        version: '0.4',
        multiscales: [{
          axes,
          datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
        }],
      } });
    }
    if (url.endsWith('/.zgroup')) return jsonResponse({ zarr_format: 2 });
    if (url.endsWith('/0/.zarray')) return jsonResponse(array);
    return notFound();
  };

  await assert.rejects(
    streamOmeZarrFromUrl(BASE_URL, { fetchImpl, onProgress: () => {} }),
    (error) => {
      assert.ok(error instanceof ZarrUnsupportedCodecError);
      assert.match(error.reason, /unsupported axis 'phase' has size 100000000/);
      return true;
    },
  );
  assert.ok(!calls.some(url => /\/0\/0\.0\.0$/.test(url)), 'custom-axis rejection must not fetch chunks');
});

test('fails closed with a named reason when the root multiscales metadata is missing', async () => {
  await assert.rejects(
    streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl: async (url) => {
        if (url.endsWith('/.zgroup')) return jsonResponse({ zarr_format: 2 });
        if (url.endsWith('/.zattrs')) return jsonResponse({ ome: { version: '0.4' } });
        return notFound();
      },
      onProgress: () => {},
    }),
    (error) => {
      assert.ok(error instanceof ZarrUnsupportedCodecError);
      assert.match(error.reason, /multiscales/i);
      return true;
    },
  );
});

test('streamOmeZarrFromUrl aborts in-flight streaming when its signal aborts', async () => {
  const restore = installCanvasStub();
  const base = mockFetch();
  const controller = new AbortController();
  // Abort the moment the chosen level's chunk is requested (mid-stream).
  const fetchImpl = async (url, opts) => {
    if (/\/2\/0\/0\/0\/0$/.test(url)) controller.abort();
    return base(url, opts);
  };
  try {
    await assert.rejects(streamOmeZarrFromUrl(BASE_URL, {
      fetchImpl,
      signal: controller.signal,
      onProgress: () => {},
    }));
  } finally {
    restore();
  }
});

test('streamProvenanceText labels a full-resolution level honestly', () => {
  const text = streamProvenanceText({ level: 0, downsample: 1 }, 1, 'raw');
  assert.match(text, /OME-Zarr v2 streamed · level 1\/1 · full resolution · raw/);
});
