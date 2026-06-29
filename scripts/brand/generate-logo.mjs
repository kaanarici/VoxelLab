// VoxelLab brand mark generator.
// Concept: an isometric voxel cube (a 3D pixel — the unit of a medical volume)
// rendered in neutral graphite with lit faces and a single red accent voxel.
//
// Emits four masters that build-assets.mjs renders into the shipped files:
//   voxellab-icon-macos.svg  — 1024 canvas, transparent margin, 824 squircle body
//                              centered (macOS / Tahoe safe-area). Source of icon.icns.
//   voxellab-icon-dark.svg   — 1024 full-bleed graphite squircle. Source of icon.png + icon.ico.
//   voxellab-icon-light.svg  — 1024 full-bleed light squircle (alt brand surface).
//   voxellab-mark.svg        — 512 standalone cube, no background.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const COS30 = Math.cos(Math.PI / 6); // 0.8660254…
const SIN30 = 0.5;

const round = n => Math.round(n * 100) / 100;
const pt = ([x, y]) => `${round(x)},${round(y)}`;
const sub = ([x, y], [a, b]) => [x - a, y - b];
const add = ([x, y], [a, b]) => [x + a, y + b];
const scale = ([x, y], f) => [x * f, y * f];

// Isometric cube anchored at top apex (cx, ty), edge length S.
function cube(S, cx, ty) {
  const w = S * COS30, h = S * SIN30;
  return {
    top: [cx, ty], right: [cx + w, ty + h], front: [cx, ty + 2 * h], left: [cx - w, ty + h],
    leftLow: [cx - w, ty + h + S], frontLow: [cx, ty + 2 * h + S], rightLow: [cx + w, ty + h + S],
    w, h, S, cx, ty,
  };
}

function faceGrid(O, U, V, n, stroke, opacity, width) {
  const lines = [];
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const a = add(O, scale(U, f)), b = add(a, V);
    const c = add(O, scale(V, f)), d = add(c, U);
    lines.push(`<line x1="${round(a[0])}" y1="${round(a[1])}" x2="${round(b[0])}" y2="${round(b[1])}"/>`);
    lines.push(`<line x1="${round(c[0])}" y1="${round(c[1])}" x2="${round(d[0])}" y2="${round(d[1])}"/>`);
  }
  return `<g stroke="${stroke}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round">${lines.join('')}</g>`;
}

// Back-corner cell of the top face, as a lit accent voxel cap.
function accentVoxel(c, fill) {
  const Utop = sub(c.right, c.top), Vtop = sub(c.left, c.top);
  const u = scale(Utop, 1 / 3), v = scale(Vtop, 1 / 3);
  const o = c.top;
  const a = o, b = add(o, u), d = add(o, v), e = add(add(o, u), v);
  return { poly: [a, b, e, d], topEdge: [d, a, b], fill };
}

// Cube artwork. `style` selects flat fills (favicon/mark) vs lit gradients (app icon).
function cubeBody(c, style) {
  const flat = style === 'flat';
  const topFill = flat ? '#eef0f3' : 'url(#vTop)';
  const leftFill = flat ? '#aeb4bd' : 'url(#vLeft)';
  const rightFill = flat ? '#7b828c' : 'url(#vRight)';
  const accentFill = flat ? '#f2575b' : 'url(#vAccent)';
  const gridWidth = round(c.S / 115);

  const faces = [
    `<polygon points="${[c.top, c.right, c.front, c.left].map(pt).join(' ')}" fill="${topFill}"/>`,
    `<polygon points="${[c.left, c.front, c.frontLow, c.leftLow].map(pt).join(' ')}" fill="${leftFill}"/>`,
    `<polygon points="${[c.front, c.right, c.rightLow, c.frontLow].map(pt).join(' ')}" fill="${rightFill}"/>`,
  ].join('\n    ');

  const Utop = sub(c.right, c.top), Vtop = sub(c.left, c.top);
  const Uleft = sub(c.front, c.left), Vleft = sub(c.leftLow, c.left);
  const Uright = sub(c.right, c.front), Vright = sub(c.frontLow, c.front);
  const grid = [
    faceGrid(c.top, Utop, Vtop, 3, '#8b929d', 0.5, gridWidth),
    faceGrid(c.left, Uleft, Vleft, 3, '#5f656f', 0.5, gridWidth),
    faceGrid(c.front, Uright, Vright, 3, '#454a53', 0.5, gridWidth),
  ].join('\n    ');

  const accent = accentVoxel(c, accentFill);
  const accentPoly = `<polygon points="${accent.poly.map(pt).join(' ')}" fill="${accentFill}"${flat ? ' opacity="0.97"' : ''}/>`;
  const accentLight = flat ? '' :
    `<polyline points="${accent.topEdge.map(pt).join(' ')}" fill="none" stroke="#ffd9da" stroke-width="${round(c.S / 125)}" stroke-opacity="0.65" stroke-linejoin="round"/>`;

  const edgeWidth = round(c.S / 100);
  const edges = `<g stroke="#101113" stroke-width="${edgeWidth}" stroke-opacity="0.32" fill="none" stroke-linejoin="round">
      <polygon points="${[c.top, c.right, c.front, c.left].map(pt).join(' ')}"/>
      <polyline points="${[c.left, c.leftLow, c.frontLow, c.rightLow, c.right].map(pt).join(' ')}"/>
      <line x1="${round(c.front[0])}" y1="${round(c.front[1])}" x2="${round(c.frontLow[0])}" y2="${round(c.frontLow[1])}"/>
    </g>`;
  const rim = flat ? '' :
    `<polyline points="${[c.left, c.top, c.right].map(pt).join(' ')}" fill="none" stroke="#ffffff" stroke-width="${round(c.S / 135)}" stroke-opacity="0.4" stroke-linejoin="round"/>`;

  return `${faces}
    ${grid}
    ${accentPoly}
    ${accentLight}
    ${edges}
    ${rim}`;
}

// Shared gradient + filter defs for the lit app-icon variants.
function litDefs() {
  return `
    <linearGradient id="vTop" x1="0.18" y1="0" x2="0.82" y2="1">
      <stop offset="0" stop-color="#fbfcfe"/><stop offset="1" stop-color="#dde1e8"/>
    </linearGradient>
    <linearGradient id="vLeft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bcc2cb"/><stop offset="1" stop-color="#9aa1ab"/>
    </linearGradient>
    <linearGradient id="vRight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#878e98"/><stop offset="1" stop-color="#666c76"/>
    </linearGradient>
    <linearGradient id="vAccent" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#ff6b6f"/><stop offset="1" stop-color="#e23b41"/>
    </linearGradient>
    <linearGradient id="vSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="0.34" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="0.62" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="vContact" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>`;
}

function bodyGradient(id, top, mid, bottom) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="0.5" stop-color="${mid}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient>`;
}

// macOS safe-area master: 1024 canvas, 824 squircle body at (100,100) r=184,
// ~100px transparent margin so VoxelLab matches other Dock/Finder icons.
function macosIconFile() {
  const X = 100, BODY = 824, R = 184, CX = 512;
  const c = cube(320, CX, 206); // centered with breathing room above/below
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    ${bodyGradient('mBody', '#34353a', '#222327', '#161719')}
    ${litDefs()}
    <clipPath id="mClip"><rect x="${X}" y="${X}" width="${BODY}" height="${BODY}" rx="${R}"/></clipPath>
  </defs>
  <rect x="${X}" y="${X}" width="${BODY}" height="${BODY}" rx="${R}" fill="url(#mBody)"/>
  <g clip-path="url(#mClip)">
    <ellipse cx="${CX}" cy="${round(c.frontLow[1] - 14)}" rx="232" ry="40" fill="#000000" opacity="0.34" filter="url(#vContact)"/>
    ${cubeBody(c, 'lit')}
    <rect x="${X}" y="${X}" width="${BODY}" height="${BODY}" fill="url(#vSheen)"/>
  </g>
  <rect x="${X + 1.5}" y="${X + 1.5}" width="${BODY - 3}" height="${BODY - 3}" rx="${R - 1.5}" fill="none" stroke="#ffffff" stroke-width="3" stroke-opacity="0.08"/>
</svg>
`;
}

// Full-bleed squircle master (favicon/Windows source). 1024 canvas, squircle
// fills the canvas. `variant` is 'dark' (lit graphite) or 'light'.
function fullBleedIconFile(variant) {
  const R = 228; // 0.2237 * 1024
  const c = cube(330, 512, 150);
  const dark = variant === 'dark';
  const body = dark
    ? bodyGradient('mBody', '#34353a', '#222327', '#161719')
    : bodyGradient('mBody', '#fcfcfe', '#f3f3f6', '#e7e8ec');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    ${body}
    ${litDefs()}
    <clipPath id="fClip"><rect width="1024" height="1024" rx="${R}"/></clipPath>
  </defs>
  <rect width="1024" height="1024" rx="${R}" fill="url(#mBody)"/>
  <g clip-path="url(#fClip)">
    <ellipse cx="512" cy="${round(c.frontLow[1] - 8)}" rx="248" ry="44" fill="#000000" opacity="${dark ? 0.32 : 0.18}" filter="url(#vContact)"/>
    ${cubeBody(c, 'lit')}
    <rect width="1024" height="1024" fill="url(#vSheen)"/>
  </g>
</svg>
`;
}

// Standalone mark (no background) — flat fills for embedding on any surface.
function markFile() {
  const c = cube(214, 256, 44);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${cubeBody(c, 'flat')}
</svg>
`;
}

writeFileSync(join(HERE, 'voxellab-icon-macos.svg'), macosIconFile());
writeFileSync(join(HERE, 'voxellab-icon-dark.svg'), fullBleedIconFile('dark'));
writeFileSync(join(HERE, 'voxellab-icon-light.svg'), fullBleedIconFile('light'));
writeFileSync(join(HERE, 'voxellab-mark.svg'), markFile());
console.log('wrote masters: voxellab-icon-macos.svg, voxellab-icon-dark.svg, voxellab-icon-light.svg, voxellab-mark.svg');
