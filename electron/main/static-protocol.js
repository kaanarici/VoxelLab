import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST } from '../shared/desktop-contracts.js';

const INDEX_PATH = '/index.html';
export const EMPTY_DESKTOP_MANIFEST = Object.freeze({ patient: 'anonymous', studyDate: '', series: [] });
const ROOT_FILES = new Set([
  'config.json',
  'config.local.json',
  'favicon.svg',
  'icons.svg',
  'index.html',
  'sw.js',
  'viewer.js',
]);
const ROOT_DIRS = ['css', 'data', 'js', 'templates'];
const PACKAGE_PATHS = [
  'node_modules/@cornerstonejs/codec-charls/dist/',
  'node_modules/@cornerstonejs/codec-openjpeg/dist/',
  'node_modules/dcmjs/build/dcmjs.es.js',
  'node_modules/dcmjs/build/dcmjs.js',
  'node_modules/fzstd/esm/index.mjs',
  'node_modules/onnxruntime-web/dist/esm/ort.min.js',
  'node_modules/onnxruntime-web/dist/ort-training-wasm-simd.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd.jsep.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm.wasm',
  'node_modules/pako/dist/pako.esm.mjs',
  'node_modules/three/build/three.module.js',
  'node_modules/three/examples/jsm/controls/TrackballControls.js',
];

function allowedRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (ROOT_FILES.has(normalized)) return true;
  return ROOT_DIRS.some(dir => normalized === dir || normalized.startsWith(`${dir}/`))
    || PACKAGE_PATHS.some(target => normalized === target.replace(/\/$/, '') || normalized.startsWith(target));
}

export function resolveStaticAssetPath(requestUrl, rootDir) {
  if (/%2e/i.test(String(requestUrl))) return null;
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.host !== APP_HOST) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? INDEX_PATH : url.pathname);
  } catch {
    return null;
  }
  const absolute = path.resolve(rootDir, `.${pathname}`);
  const relative = path.relative(rootDir, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!allowedRelativePath(relative)) return null;
  return absolute;
}

export function registerStaticProtocol({ protocol, net, scheme, rootDir }) {
  protocol.handle(scheme, async (request) => {
    const assetPath = resolveStaticAssetPath(request.url, rootDir);
    if (!assetPath) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (assetPath.endsWith('node_modules/three/examples/jsm/controls/TrackballControls.js')) {
      const source = await fs.readFile(assetPath, 'utf8');
      return new Response(source.replace("from 'three';", "from '../../../build/three.module.js';"), {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    try {
      await fs.access(assetPath);
    } catch {
      if (assetPath.endsWith('data/manifest.json')) {
        return new Response(JSON.stringify(EMPTY_DESKTOP_MANIFEST), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  });
}
