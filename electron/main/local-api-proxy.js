import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LOCAL_API_BASE = 'http://127.0.0.1:8000';
const FORWARDED_HEADERS = new Set(['accept', 'content-type', 'x-voxellab-local-token']);
export const MAX_DESKTOP_LOCAL_API_BODY_BYTES = 256 * 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

async function spoolRequestBody(body, maxBytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-local-api-'));
  const filePath = path.join(directory, 'request-body');
  const handle = await fs.open(filePath, 'wx', 0o600);
  if (!body) {
    await handle.close();
    return { directory, filePath, size: 0 };
  }
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      received += chunk.byteLength;
      if (received > maxBytes) throw new RequestBodyTooLargeError('request body is too large');
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    return { directory, filePath, size: received };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (received > maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function desktopLocalApiTarget(requestUrl, base = process.env.VOXELLAB_LOCAL_API_BASE || DEFAULT_LOCAL_API_BASE) {
  const source = new URL(requestUrl);
  if (!source.pathname.startsWith('/api/') || source.pathname.startsWith('/api/cloud/')) return '';
  return new URL(`${source.pathname}${source.search}`, base).toString();
}

export async function handleDesktopLocalApiRequest(
  request,
  net,
  base,
  { maxBodyBytes = MAX_DESKTOP_LOCAL_API_BODY_BYTES } = {},
) {
  const target = desktopLocalApiTarget(request.url, base);
  if (!target) return null;
  const requestedBodyLimit = Number(maxBodyBytes);
  const bodyLimit = Number.isSafeInteger(requestedBodyLimit) && requestedBodyLimit >= 0
    ? Math.min(requestedBodyLimit, MAX_DESKTOP_LOCAL_API_BODY_BYTES)
    : MAX_DESKTOP_LOCAL_API_BODY_BYTES;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('Origin', new URL(target).origin);
  headers.set('Sec-Fetch-Site', 'same-origin');
  const method = request.method || 'GET';
  const init = { method, headers };
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0) {
        return Response.json({ error: 'invalid request Content-Length' }, { status: 400 });
      }
      if (length > bodyLimit) {
        return Response.json({ error: 'request body is too large' }, { status: 413 });
      }
    }
  }
  let spool = null;
  try {
    if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
      spool = await spoolRequestBody(request.body, bodyLimit);
      init.body = await openAsBlob(spool.filePath, { type: headers.get('content-type') || '' });
    }
    return await net.fetch(target, init);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error?.cause instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'request body is too large' }, { status: 413 });
    }
    return Response.json({ error: 'Local helper API is unavailable. Run npm start.' }, { status: 502 });
  } finally {
    if (spool) await fs.rm(spool.directory, { recursive: true, force: true }).catch(() => {});
  }
}
