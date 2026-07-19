import assert from 'node:assert/strict';
import { test } from 'node:test';

const { SLICE_COMPOSITOR_VERTEX_SHADER, drawCompositeSlice } = await import('../js/slice-compositor.js');

test('shared slice compositor flips Y in the GPU vertex shader to match canvas image origin', () => {
  assert.match(SLICE_COMPOSITOR_VERTEX_SHADER, /1\.0\s*-\s*\(aPosition\.y\s*\*\s*0\.5\s*\+\s*0\.5\)/);
});

function makeLut(value = 0, key = 'lut:0') {
  return {
    r: new Uint8Array(256).fill(value),
    g: new Uint8Array(256).fill(value),
    b: new Uint8Array(256).fill(value),
    key,
  };
}

function createFakeWebGl() {
  const uploads = [];
  let activeUnit = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    CLAMP_TO_EDGE: 0x812F,
    COMPILE_STATUS: 0x8B81,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8B30,
    LINK_STATUS: 0x8B82,
    NEAREST: 0x2600,
    R8: 0x8229,
    RED: 0x1903,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    STATIC_DRAW: 0x88E4,
    TEXTURE0: 0x84C0,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLE_STRIP: 0x0005,
    UNPACK_ALIGNMENT: 0x0CF5,
    UNSIGNED_BYTE: 0x1401,
    activeTexture(unit) { activeUnit = unit - this.TEXTURE0; },
    attachShader() {},
    bindBuffer() {},
    bindTexture() {},
    bufferData() {},
    compileShader() {},
    createBuffer: () => ({}),
    createProgram: () => ({}),
    createShader: () => ({}),
    createTexture: () => ({}),
    deleteProgram() {},
    deleteShader() {},
    drawArrays() {},
    enableVertexAttribArray() {},
    getAttribLocation: () => 0,
    getProgramInfoLog: () => '',
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getShaderParameter: () => true,
    getUniformLocation: () => ({}),
    linkProgram() {},
    pixelStorei() {},
    shaderSource() {},
    texImage2D(_target, _level, _internalFormat, width, height, _border, _format, _type, data) {
      uploads.push({ unit: activeUnit, width, height, data });
    },
    texParameteri() {},
    uniform1f() {},
    uniform1i() {},
    useProgram() {},
    vertexAttribPointer() {},
    viewport() {},
  };
  return { gl, uploads };
}

function drawWithUploads(uploads, options) {
  uploads.length = 0;
  const mode = drawCompositeSlice({ drawImage() {} }, 2, 2, options);
  assert.equal(mode, 'webgl2');
  return uploads.map((entry) => entry.unit);
}

test('shared slice compositor skips unchanged GPU texture uploads and honors forced mutable slots', () => {
  const previousDocument = globalThis.document;
  const previousWebGL2 = globalThis.WebGL2RenderingContext;
  const { gl, uploads } = createFakeWebGl();
  globalThis.WebGL2RenderingContext = class {};
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(kind) {
          assert.equal(kind, 'webgl2');
          return gl;
        },
      };
    },
  };

  try {
    const baseBytes = Uint8Array.from([0, 1, 2, 3]);
    const segBytes = Uint8Array.from([0, 7, 0, 0]);
    const regionColors = { 7: [255, 0, 0] };
    const hotLut = new Uint8Array(256 * 4);
    const wlLut = makeLut(12, 'wl:0');
    const options = {
      baseBytes,
      segBytes,
      symBytes: null,
      regionBytes: null,
      fusionBytes: null,
      wlLut,
      regionColors,
      hotLut,
    };

    assert.deepEqual(drawWithUploads(uploads, options), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(drawWithUploads(uploads, options), []);

    wlLut.r[1] = 99;
    wlLut.g[1] = 88;
    wlLut.b[1] = 77;
    wlLut.key = 'wl:1';
    assert.deepEqual(drawWithUploads(uploads, options), [5]);

    assert.deepEqual(drawWithUploads(uploads, { ...options, segBytes: null }), [1]);
    assert.deepEqual(drawWithUploads(uploads, options), [1]);

    baseBytes[0] = 9;
    assert.deepEqual(drawWithUploads(uploads, { ...options, forceTextureUploads: { base: true } }), [0]);
  } finally {
    globalThis.document = previousDocument;
    globalThis.WebGL2RenderingContext = previousWebGL2;
  }
});
