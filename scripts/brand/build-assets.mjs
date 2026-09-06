import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ASSETS = join(ROOT, 'electron', 'assets');

const FULLBLEED_SVG = join(HERE, 'voxellab-icon-dark.svg');

const MACOS_SVG = join(HERE, 'voxellab-icon-macos.svg');

const rsvg = (svg, w, h, out) =>
  execFileSync('rsvg-convert', ['-w', String(w), '-h', String(h), svg, '-o', out]);

rsvg(FULLBLEED_SVG, 1024, 1024, join(ASSETS, 'icon.png'));
console.log('wrote electron/assets/icon.png');
rsvg(MACOS_SVG, 1024, 1024, join(ASSETS, 'icon-macos.png'));
console.log('wrote electron/assets/icon-macos.png');

const work = mkdtempSync(join(tmpdir(), 'voxellab-icns-'));
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset, { recursive: true });
const icnsSpec = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of icnsSpec) rsvg(MACOS_SVG, size, size, join(iconset, name));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(ASSETS, 'icon.icns')]);
console.log('wrote electron/assets/icon.icns');

const icoPngs = [16, 24, 32, 48, 64, 128, 256].map(size => {
  const p = join(work, `ico-${size}.png`);
  rsvg(FULLBLEED_SVG, size, size, p);
  return p;
});
execFileSync('magick', [...icoPngs, join(ASSETS, 'icon.ico')]);
console.log('wrote electron/assets/icon.ico');

writeFileSync(join(ROOT, 'favicon.svg'), faviconSvg());
console.log('wrote favicon.svg');

const bg = join(work, 'dmg-background.svg');
writeFileSync(bg, dmgBackgroundSvg());
rsvg(bg, 660, 400, join(ASSETS, 'dmg-background.png'));
rsvg(bg, 1320, 800, join(ASSETS, 'dmg-background@2x.png'));
console.log('wrote electron/assets/dmg-background.png (+@2x)');

rmSync(work, { recursive: true, force: true });

function faviconSvg() {

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34353a"/><stop offset="1" stop-color="#161719"/></linearGradient>
    <linearGradient id="ft" x1="0.18" y1="0" x2="0.82" y2="1"><stop offset="0" stop-color="#fbfcfe"/><stop offset="1" stop-color="#dde1e8"/></linearGradient>
    <linearGradient id="fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bcc2cb"/><stop offset="1" stop-color="#9aa1ab"/></linearGradient>
    <linearGradient id="fr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#878e98"/><stop offset="1" stop-color="#666c76"/></linearGradient>
    <linearGradient id="fa" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#ff6b6f"/><stop offset="1" stop-color="#e23b41"/></linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#fb)"/>
  <polygon points="32,11 51,22 32,33 13,22" fill="url(#ft)"/>
  <polygon points="13,22 32,33 32,55 13,44" fill="url(#fl)"/>
  <polygon points="32,33 51,22 51,44 32,55" fill="url(#fr)"/>
  <polygon points="32,11 41.5,16.5 32,22 22.5,16.5" fill="url(#fa)"/>
</svg>
`;
}

function dmgBackgroundSvg() {

  const font = "'Helvetica Neue', Helvetica, Arial, sans-serif";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 400" width="660" height="400">
  <rect width="660" height="400" fill="#f5f5f7"/>
  <rect x="0" y="0" width="660" height="400" fill="none" stroke="#e2e2e6" stroke-width="2"/>
  <text x="330" y="70" text-anchor="middle" font-family="${font}" font-size="29" font-weight="600" fill="#1d1d1f" letter-spacing="0.2">VoxelLab</text>
  <rect x="306" y="84" width="48" height="3" rx="1.5" fill="#e5484d"/>
  <text x="330" y="116" text-anchor="middle" font-family="${font}" font-size="14.5" font-weight="500" fill="#6e6e73" letter-spacing="0.2">Drag VoxelLab onto the Applications folder</text>
  <g stroke="#c4c4ca" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="266" y1="212" x2="392" y2="212"/>
    <polyline points="380,201 394,212 380,223"/>
  </g>
  <text x="330" y="372" text-anchor="middle" font-family="${font}" font-size="11.5" font-weight="500" fill="#a1a1a6" letter-spacing="0.3">Research use only — not for clinical use</text>
</svg>
`;
}
