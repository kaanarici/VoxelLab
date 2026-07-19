import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeObj, encodeStlBinary, mergeMeshes } from '../js/mesh/mesh-encoders.js';

// One triangle in the z=0 plane.
const TRI = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  name: 'tri',
};

test('encodeStlBinary: 84 + 50*N bytes, correct triangle count, unit normal', () => {
  const buffer = encodeStlBinary(TRI);
  assert.equal(buffer.byteLength, 84 + 50 * 1);
  const view = new DataView(buffer);
  assert.equal(view.getUint32(80, true), 1);
  const nx = view.getFloat32(84, true);
  const ny = view.getFloat32(88, true);
  const nz = view.getFloat32(92, true);
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-6, 'unit-length normal');
  assert.ok(Math.abs(nz - 1) < 1e-6, 'normal points +Z for CCW triangle');
});

test('encodeObj: correct vertex count and 1-based faces', () => {
  const obj = encodeObj(TRI);
  const vLines = obj.split('\n').filter((l) => l.startsWith('v '));
  const fLines = obj.split('\n').filter((l) => l.startsWith('f '));
  assert.equal(vLines.length, 3);
  assert.deepEqual(fLines, ['f 1 2 3']);
});

test('encodeObj groups: per-part names with running 1-based offset', () => {
  const partA = { name: 'A', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const partB = { name: 'B', positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) };
  const obj = encodeObj({ parts: [partA, partB] });
  const oLines = obj.split('\n').filter((l) => l.startsWith('o '));
  const fLines = obj.split('\n').filter((l) => l.startsWith('f '));
  assert.deepEqual(oLines, ['o A', 'o B']);
  // Second group's faces are offset by the first group's 3 vertices.
  assert.deepEqual(fLines, ['f 1 2 3', 'f 4 5 6']);
});

test('mergeMeshes offsets indices into a shared vertex list', () => {
  const a = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const b = { positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) };
  const merged = mergeMeshes([a, b]);
  assert.equal(merged.positions.length, 18);
  assert.deepEqual([...merged.indices], [0, 1, 2, 3, 4, 5]);
});
