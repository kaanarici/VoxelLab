import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST } from '../shared/desktop-contracts.js';
import { PACKAGE_PATHS, ROOT_DIRS, ROOT_FILES } from './host-policy.js';

const INDEX_PATH = '/index.html';
export const EMPTY_DESKTOP_MANIFEST = Object.freeze({ patient: 'anonymous', studyDate: '', series: [] });

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

export function registerStaticProtocol({ protocol, net, scheme, rootDir, handleApiRequest = null }) {
  protocol.handle(scheme, async (request) => {
    if (handleApiRequest instanceof Function) {
      const apiResponse = await handleApiRequest(request);
      if (apiResponse) return apiResponse;
    }
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
