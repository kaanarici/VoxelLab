/** Bump when static assets must replace SW caches; no query-string cache busting elsewhere. */
export const SERVICE_WORKER_VERSION = '2026-07-18-3';
export const IMAGE_CACHE_VERSION = '2026-04-11-2';
export const IMAGE_CACHE_NAME = `voxellab-images-${IMAGE_CACHE_VERSION}`;
export const VOLUME_CACHE_VERSION = '2026-04-11-1';
export const VOLUME_CACHE_NAME = `voxellab-volumes-${VOLUME_CACHE_VERSION}`;

// Root-absolute local package assets resolve from every module depth. Both the
// browser server and Electron custom protocol expose only this allowlisted set.
const DEPENDENCY_ASSET_BASE = '/node_modules';

export const THREE_MODULE_URL = `${DEPENDENCY_ASSET_BASE}/three/build/three.module.js`;
export const THREE_ADDONS_URL = `${DEPENDENCY_ASSET_BASE}/three/examples/jsm/`;

export const DCMJS_IMPORT_URL = `${DEPENDENCY_ASSET_BASE}/dcmjs/build/dcmjs.es.js`;
export const PAKO_ESM_URL = `${DEPENDENCY_ASSET_BASE}/pako/dist/pako.esm.mjs`;
export const FZSTD_ESM_URL = `${DEPENDENCY_ASSET_BASE}/fzstd/esm/index.mjs`;

export const ORT_MODULE_URL = `${DEPENDENCY_ASSET_BASE}/onnxruntime-web/dist/esm/ort.min.js`;
export const ORT_WASM_BASE_URL = `${DEPENDENCY_ASSET_BASE}/onnxruntime-web/dist/`;

export const OPENJPEG_CODEC_URL = `${DEPENDENCY_ASSET_BASE}/@cornerstonejs/codec-openjpeg/dist/openjpegwasm.js`;
export const CHARLS_CODEC_URL = `${DEPENDENCY_ASSET_BASE}/@cornerstonejs/codec-charls/dist/charlswasm.js`;

export const LOCAL_DEPENDENCY_URLS = [
  THREE_MODULE_URL,
  `${THREE_ADDONS_URL}controls/TrackballControls.js`,
  DCMJS_IMPORT_URL,
  PAKO_ESM_URL,
  FZSTD_ESM_URL,
  ORT_MODULE_URL,
  OPENJPEG_CODEC_URL,
  CHARLS_CODEC_URL,
];
