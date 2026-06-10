// VoxelLab brand mark generator.
// Concept: an isometric voxel cube (a 3D pixel — the unit of a medical volume)
// rendered in neutral graphite with flat faces and a single red accent voxel.
// Flat fills only (no gradients); macOS squircle background. build-assets.mjs
// renders the masters into icns/ico/png/favicon and the DMG background.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SIZE = 512;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

// Graphite cube faces (flat, lit-from-above shading — top lightest).
const FACE_TOP = '#eef0f3';
const FACE_LEFT = '#aeb4bd';
const FACE_RIGHT = '#7b828c';
const EDGE = '#5b626c';
// Single accent voxel.
const RED_TOP = '#f2575b';
// Backgrounds.
const DARK_BG = '#1c1c1e';   // neutral graphite (Apple dark), not navy
const LIGHT_BG = '#f5f5f7';  // Apple light gray

const round = n => Math.round(n * 100) / 100;
const pt = ([x, y]) => `${round(x)},${round(y)}`;
const poly = (pts, fill, extra = '') => `<polygon points="${pts.map(pt).join(' ')}" fill="${fill}" ${extra}/>`;
const sub = ([x, y], [a, b]) => [x - a, y - b];
const add = ([x, y], [a, b]) => [x + a, y + b];
const scale = ([x, y], f) => [x * f, y * f];

function cube(S, cx, ty) {
  const w = S * COS30, h = S * SIN30;
  return {
    top: [cx, ty], right: [cx + w, ty + h], front: [cx, ty + 2 * h], left: [cx - w, ty + h],
    leftLow: [cx - w, ty + h + S], frontLow: [cx, ty + 2 * h + S], rightLow: [cx + w, ty + h + S],
    w, h, S, cx, ty,
  };
}

// Faint subdivision lines that read the cube as a 3×3×3 voxel grid.
function faceGrid(O, U, V, n, stroke, opacity) {
  const lines = [];
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const a = add(O, scale(U, f)), b = add(a, V);
    const c = add(O, scale(V, f)), d = add(c, U);
    lines.push(`<line x1="${round(a[0])}" y1="${round(a[1])}" x2="${round(b[0])}" y2="${round(b[1])}"/>`);
    lines.push(`<line x1="${round(c[0])}" y1="${round(c[1])}" x2="${round(d[0])}" y2="${round(d[1])}"/>`);
  }
  return `<g stroke="${stroke}" stroke-width="2" stroke-opacity="${opacity}" stroke-linecap="round">${lines.join('')}</g>`;
}

// One voxel sitting on the top face: the (col,row) cell of the 3×3 top grid,
// drawn as a small cube cap so the accent reads as a raised voxel.
function accentVoxel(c) {
  const Utop = sub(c.right, c.top), Vtop = sub(c.left, c.top);
  const col = 0, row = 0; // back corner cell (top apex)
  const u = scale(Utop, 1 / 3), v = scale(Vtop, 1 / 3);
  const o = add(add(c.top, scale(u, col)), scale(v, row));
  const a = o, b = add(o, u), d = add(o, v), e = add(add(o, u), v);
  return poly([a, b, e, d], RED_TOP, 'opacity="0.97"');
}

function gridForCube(c) {
  const Utop = sub(c.right, c.top), Vtop = sub(c.left, c.top);
  const Uleft = sub(c.front, c.left), Vleft = sub(c.leftLow, c.left);
  const Uright = sub(c.right, c.front), Vright = sub(c.frontLow, c.front);
  return [
    faceGrid(c.top, Utop, Vtop, 3, '#9aa1ab', 0.55),
    faceGrid(c.left, Uleft, Vleft, 3, '#6b727c', 0.5),
    faceGrid(c.front, Uright, Vright, 3, '#4f555e', 0.5),
  ].join('');
}

function cubeBody(c) {
  const top = poly([c.top, c.right, c.front, c.left], FACE_TOP);
  const left = poly([c.left, c.front, c.frontLow, c.leftLow], FACE_LEFT);
  const right = poly([c.front, c.right, c.rightLow, c.frontLow], FACE_RIGHT);
  const grid = gridForCube(c);
  const accent = accentVoxel(c);
  const edges = `<g stroke="${EDGE}" stroke-width="2.5" stroke-opacity="0.7" fill="none" stroke-linejoin="round">
    <polygon points="${[c.top, c.right, c.front, c.left].map(pt).join(' ')}"/>
    <polyline points="${[c.left, c.leftLow, c.frontLow, c.rightLow, c.right].map(pt).join(' ')}"/>
    <line x1="${round(c.front[0])}" y1="${round(c.front[1])}" x2="${round(c.frontLow[0])}" y2="${round(c.frontLow[1])}"/>
  </g>`;
  return [top, left, right, grid, accent, edges].join('\n');
}

function shadow(cx, cy) {
  return `<defs><filter id="sh" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="13"/></filter></defs>
  <ellipse cx="${cx}" cy="${cy}" rx="148" ry="24" fill="#000000" opacity="0.22" filter="url(#sh)"/>`;
}

function mark() {
  const c = cube(214, 256, 44);
  return cubeBody(c);
}

function markFile() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">\n${mark()}\n</svg>\n`;
}

function iconFile(bg) {
  const c = cube(214, 256, 44);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="114" fill="${bg}"/>
  ${shadow(256, 484)}
  ${cubeBody(c)}
</svg>
`;
}

writeFileSync(join(HERE, 'voxellab-mark.svg'), markFile());
writeFileSync(join(HERE, 'voxellab-icon-dark.svg'), iconFile(DARK_BG));
writeFileSync(join(HERE, 'voxellab-icon-light.svg'), iconFile(LIGHT_BG));
console.log('wrote masters: voxellab-mark.svg, voxellab-icon-dark.svg, voxellab-icon-light.svg');
