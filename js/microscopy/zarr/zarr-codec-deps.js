import { FZSTD_ESM_URL, PAKO_ESM_URL } from '../../core/dependencies.js';

const IN_NODE = Boolean(globalThis.process?.versions?.node) && !('window' in globalThis);

export async function zarrInflate(src) {
  const pako = IN_NODE ? await import('pako') : await import(PAKO_ESM_URL);
  const inflate = pako.inflate || pako.default?.inflate;
  if (!(inflate instanceof Function)) throw new Error('zlib/gzip lazy dependency pako.inflate');
  return inflate(src);
}

export async function zarrZstdDecompress(src) {
  const fzstd = IN_NODE ? await import('fzstd') : await import(FZSTD_ESM_URL);
  const decompress = fzstd.decompress || fzstd.default?.decompress;
  if (!(decompress instanceof Function)) throw new Error('zstd lazy dependency fzstd.decompress');
  return decompress(src);
}
