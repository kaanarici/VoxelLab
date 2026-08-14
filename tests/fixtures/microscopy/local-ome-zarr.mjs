import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function omeZarrJsonFile(path, body) {
  return {
    name: path.split('/').pop(),
    webkitRelativePath: path,
    async text() {
      return JSON.stringify(body);
    },
  };
}

export function omeZarrBinaryFile(path, bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name: path.split('/').pop(),
    size: buffer.byteLength,
    webkitRelativePath: path,
    async arrayBuffer() {
      return buffer;
    },
    stream() {
      return new Blob([buffer]).stream();
    },
  };
}

export function trackedOmeZarrBinaryFile(path, bytes, tracker) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    name: path.split('/').pop(),
    size: buffer.byteLength,
    webkitRelativePath: path,
    async arrayBuffer() {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      try {
        await delay(1);
        return buffer;
      } finally {
        tracker.active -= 1;
      }
    },
    stream() {
      let sent = false;
      return new ReadableStream({
        async pull(controller) {
          if (sent) {
            controller.close();
            return;
          }
          sent = true;
          tracker.active += 1;
          tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
          try {
            await delay(1);
            controller.enqueue(new Uint8Array(buffer));
          } finally {
            tracker.active -= 1;
          }
        },
      });
    },
  };
}

export function installOmeZarrCanvasStub() {
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
            putImageData(image) {
              canvas._imageData = image;
            },
          };
        },
      };
      return canvas;
    },
  };
  return () => { globalThis.document = previousDocument; };
}

export function chunkForDtype(dtype, values) {
  const match = String(dtype).match(/^([<>|])([uif])([124])$/);
  assert.ok(
    match && (match[2] !== 'f' || match[3] === '4'),
    `test dtype must be an explicit integer or float32 type: ${dtype}`,
  );
  const bytes = Number(match[3]);
  const signed = match[2] === 'i';
  const littleEndian = match[1] !== '>';
  const buffer = Buffer.alloc(values.length * bytes);
  values.forEach((value, index) => {
    const offset = index * bytes;
    if (bytes === 1) {
      signed ? buffer.writeInt8(value, offset) : buffer.writeUInt8(value, offset);
    } else if (bytes === 2 && signed) {
      littleEndian ? buffer.writeInt16LE(value, offset) : buffer.writeInt16BE(value, offset);
    } else if (bytes === 2) {
      littleEndian ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
    } else if (match[2] === 'f') {
      littleEndian ? buffer.writeFloatLE(value, offset) : buffer.writeFloatBE(value, offset);
    } else if (signed) {
      littleEndian ? buffer.writeInt32LE(value, offset) : buffer.writeInt32BE(value, offset);
    } else {
      littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
    }
  });
  return buffer;
}

export function omeZarrFixtureBytes(name) {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../zarr/${name}`, import.meta.url))));
}

export function tinyOmeZarrFiles({
  withChunk = true,
  dtype = '<u2',
  arrayOverrides = {},
  chunkBytes = null,
  chunkRelativePath = null,
  axes = [
    { name: 'c', type: 'channel' },
    { name: 'y', type: 'space', unit: 'micrometer' },
    { name: 'x', type: 'space', unit: 'micrometer' },
  ],
  scale = [1, 0.25, 0.5],
  versionAtRoot = true,
} = {}) {
  const shape = arrayOverrides.shape || [2, 2, 2];
  const values = Array.from({ length: shape.reduce((product, value) => product * value, 1) }, (_, index) => index * 10);
  const chunk = chunkBytes || (/^(?:[<>|][ui][124]|[<>|]f4)$/.test(dtype)
    ? chunkForDtype(dtype, values)
    : chunkForDtype('<u2', values));
  const arrayMeta = {
    zarr_format: 2,
    shape,
    chunks: arrayOverrides.chunks || shape,
    dtype,
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
    ...arrayOverrides,
  };
  const chunkPath = chunkRelativePath || `cells.zarr/0/${Array.from({ length: shape.length }, () => '0').join(arrayMeta.dimension_separator === '/' ? '/' : '.')}`;
  return [
    omeZarrJsonFile('cells.zarr/.zattrs', {
      ome: {
        ...(versionAtRoot ? { version: '0.4' } : {}),
        multiscales: [{
          ...(!versionAtRoot ? { version: '0.4' } : {}),
          name: 'cells',
          axes,
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale }],
          }],
        }],
        omero: {
          channels: [{
            label: 'DAPI',
            color: '0000FF',
            family: 'linear',
            window: { min: 0, max: 4095, start: 10, end: 2000 },
          }, {
            label: 'GFP',
            color: '00FF00',
            family: 'linear',
            window: { min: 0, max: 4095, start: 25, end: 1800 },
          }],
        },
      },
    }),
    omeZarrJsonFile('cells.zarr/0/.zarray', arrayMeta),
    ...(withChunk ? [omeZarrBinaryFile(chunkPath, chunk)] : []),
  ];
}

export async function tinyConsolidatedOmeZarrFiles(options = {}) {
  const files = tinyOmeZarrFiles(options);
  const metadata = {};
  const chunkFiles = [];
  for (const file of files) {
    if (file.webkitRelativePath === 'cells.zarr/.zattrs') {
      metadata['.zattrs'] = JSON.parse(await file.text());
    } else if (file.webkitRelativePath === 'cells.zarr/0/.zarray') {
      metadata['0/.zarray'] = JSON.parse(await file.text());
    } else {
      chunkFiles.push(file);
    }
  }
  return [
    omeZarrJsonFile('cells.zarr/.zmetadata', {
      zarr_consolidated_format: 1,
      metadata,
    }),
    ...chunkFiles,
  ];
}

export function chunkedPlaneOmeZarrFiles({ omitPath = '', chunkOverrides = {}, arrayOverrides = {} } = {}) {
  const files = [
    omeZarrJsonFile('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          name: 'cells',
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
          }],
        }],
        omero: {
          channels: [{
            label: 'DAPI',
            color: '0000FF',
            family: 'linear',
            window: { min: 0, max: 4095, start: 0, end: 4095 },
          }],
        },
      },
    }),
    omeZarrJsonFile('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, 3, 4],
      chunks: [1, 2, 3],
      dtype: '<u2',
      compressor: null,
      order: 'C',
      filters: null,
      fill_value: 0,
      ...arrayOverrides,
    }),
  ];
  const chunks = [
    ['cells.zarr/0/0.0.0', [0, 1, 2, 10, 11, 12]],
    ['cells.zarr/0/0.0.1', [3, 999, 999, 13, 999, 999]],
    ['cells.zarr/0/0.1.0', [20, 21, 22, 999, 999, 999]],
    ['cells.zarr/0/0.1.1', [23, 999, 999, 999, 999, 999]],
  ];
  for (const [path, values] of chunks) {
    if (path !== omitPath) files.push(omeZarrBinaryFile(path, chunkOverrides[path] || chunkForDtype('<u2', values)));
  }
  return files;
}

export function manyChunkOmeZarrFiles({ tracker }) {
  const width = 16;
  const height = 4;
  const files = [
    omeZarrJsonFile('cells.zarr/.zattrs', {
      ome: {
        version: '0.4',
        multiscales: [{
          name: 'cells',
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space', unit: 'micrometer' },
            { name: 'x', type: 'space', unit: 'micrometer' },
          ],
          datasets: [{
            path: '0',
            coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
          }],
        }],
      },
    }),
    omeZarrJsonFile('cells.zarr/0/.zarray', {
      zarr_format: 2,
      shape: [1, height, width],
      chunks: [1, 1, 1],
      dtype: '|u1',
      compressor: null,
      order: 'C',
      filters: null,
      fill_value: 0,
    }),
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      files.push(trackedOmeZarrBinaryFile(`cells.zarr/0/0.${y}.${x}`, Buffer.from([y * width + x]), tracker));
    }
  }
  return files;
}
