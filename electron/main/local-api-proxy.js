const DEFAULT_LOCAL_API_BASE = 'http://127.0.0.1:8000';
const FORWARDED_HEADERS = new Set(['accept', 'content-type', 'x-voxellab-local-token']);

export function desktopLocalApiTarget(requestUrl, base = process.env.VOXELLAB_LOCAL_API_BASE || DEFAULT_LOCAL_API_BASE) {
  const source = new URL(requestUrl);
  if (!source.pathname.startsWith('/api/') || source.pathname.startsWith('/api/cloud/')) return '';
  return new URL(`${source.pathname}${source.search}`, base).toString();
}

export async function handleDesktopLocalApiRequest(request, net, base) {
  const target = desktopLocalApiTarget(request.url, base);
  if (!target) return null;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('Sec-Fetch-Site', 'same-origin');
  const method = request.method || 'GET';
  const init = { method, headers };
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
    init.body = Buffer.from(await request.arrayBuffer());
  }
  try {
    return await net.fetch(target, init);
  } catch {
    return Response.json({ error: 'Local helper API is unavailable. Run npm start.' }, { status: 502 });
  }
}
