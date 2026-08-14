import { FZSTD_ESM_URL, PAKO_ESM_URL } from '../../core/dependencies.js';

// pako/fzstd resolve to CDN (browser) or /node_modules (desktop) URLs, but Node's
// default ESM loader cannot import an https: URL. Zarr decode runs in both the
// browser viewer and Node (verifier/tests), so in Node import the installed
// package by name; in the browser keep the URL the rest of the app uses.
const IN_NODE = typeof globalThis.process !== 'undefined'
  && Boolean(globalThis.process.versions?.node)
  && typeof globalThis.window === 'undefined';

export async function zarrInflate(src) {
  const pako = IN_NODE ? await import('pako') : await import(PAKO_ESM_URL);
  const inflate = pako.inflate || pako.default?.inflate;
  if (typeof inflate !== 'function') throw new Error('zlib/gzip lazy dependency pako.inflate');
  return inflate(src);
}

export async function zarrZstdDecompress(src) {
  const fzstd = IN_NODE ? await import('fzstd') : await import(FZSTD_ESM_URL);
  const decompress = fzstd.decompress || fzstd.default?.decompress;
  if (typeof decompress !== 'function') throw new Error('zstd lazy dependency fzstd.decompress');
  return decompress(src);
}
