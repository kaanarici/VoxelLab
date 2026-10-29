#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'voxellab-agent');
const STATE_FILE = join(STATE_DIR, 'session.json');
const DEFAULT_CONTROL_PORT = Number(process.env.VOXELLAB_AGENT_PORT) || 7466;

const TOOLS = [
  { name: 'status', description: 'Loaded series, active series/slice/window/mode, and tool state. Call first.', params: {} },
  { name: 'open', description: 'Open local scan files or folders (DICOM, NIfTI, TIFF/OME-TIFF) through the normal local import path. Returns the new status.', params: { paths: { type: 'array', items: { type: 'string' }, description: 'Absolute or relative file/folder paths' } }, required: ['paths'] },
  { name: 'select_series', description: 'Make a series active by index or slug.', params: { series: { type: ['integer', 'string'] } }, required: ['series'] },
  { name: 'set_view', description: 'Change view state. Any subset: slice (0-based), window/level, invert, colormap, zoom_fit, mode (2d|mpr|3d).', params: { slice: { type: 'integer' }, window: { type: 'number' }, level: { type: 'number' }, invert: { type: 'boolean' }, colormap: { type: 'string' }, zoom_fit: { type: 'boolean' }, mode: { type: 'string', enum: ['2d', 'mpr', '3d'] } } },
  { name: 'screenshot', description: 'Rendered viewer image (overlays and measurements included). Returns a PNG.', params: { out: { type: 'string', description: 'CLI only: file path to write' } } },
  { name: 'pixel', description: 'Raw and calibrated value at image pixel (x, y) on the active slice, plus physical position.', params: { x: { type: 'number' }, y: { type: 'number' }, slice: { type: 'integer' } }, required: ['x', 'y'] },
  { name: 'measure', description: 'Add a distance measurement between two image-pixel points on the active (or given) slice. Returns length in mm when calibrated.', params: { from: { type: 'array', items: { type: 'number' } }, to: { type: 'array', items: { type: 'number' } }, slice: { type: 'integer' } }, required: ['from', 'to'] },
  { name: 'angle', description: 'Add an angle measurement from three image-pixel points (vertex is the second). Returns degrees.', params: { points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, slice: { type: 'integer' } }, required: ['points'] },
  { name: 'roi', description: 'Add an ellipse (center+radii) or polygon (points) ROI in image pixels and return its statistics (mean, sd, min, max, area).', params: { "shape": { type: 'string', enum: ['ellipse', 'polygon'] }, center: { type: 'array', items: { type: 'number' } }, radii: { type: 'array', items: { type: 'number' } }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, slice: { type: 'integer' } }, required: ['shape'] },
  { name: 'annotate', description: 'Pin a text note at an image-pixel point.', params: { x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, slice: { type: 'integer' } }, required: ['x', 'y', 'text'] },
  { name: 'list_findings', description: 'All measurements, angles, ROIs and annotations for the active series.', params: {} },
  { name: 'clear', description: 'Remove measurements, ROIs and annotations on the active slice (or every slice with all=true).', params: { all: { type: 'boolean' } } },
  { name: 'export_roi_csv', description: 'ROI results as CSV text (same table as the ROI results export).', params: { out: { type: 'string', description: 'CLI only: file path to write' } } },
];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

class Viewer {
  constructor({ url = '', headed = false } = {}) {
    this.url = url;
    this.headed = headed;
    this.server = null;
    this.browser = null;
    this.page = null;
  }

  async start() {
    if (!this.url) {
      const port = await freePort();
      this.server = spawn(process.execPath, [join(ROOT, 'scripts/run_python.mjs'), join(ROOT, 'python/serve.py'), '--port', String(port)], {
        cwd: ROOT,
        stdio: 'ignore',
      });
      this.url = `http://127.0.0.1:${port}/`;
      await waitFor(this.url, 30_000);
    }
    const { chromium } = await import('@playwright/test');
    this.browser = await chromium.launch({ headless: !this.headed });
    const context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      try { localStorage.setItem('voxellab:interaction-hint-seen', '1'); } catch {}
    });
    this.page = await context.newPage();
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => window.voxellab?.ready === true, null, { timeout: 30_000 });
  }

  async call(method, params = {}) {
    try {
      return await this.dispatch(method, params);
    } catch (e) {
      throw new Error(String(e.message || e).replace(/^page\.\w+: (Error: )?/, '').split('\n')[0]);
    }
  }

  async dispatch(method, params) {
    const page = this.page;
    if (method === 'open') {
      const paths = (params.paths || []).map((p) => resolve(String(p)));
      if (!paths.length) throw new Error('open needs at least one path');
      for (const p of paths) if (!existsSync(p)) throw new Error(`no such file or folder: ${p}`);
      const dirs = paths.filter((p) => statSync(p).isDirectory());
      const files = paths.filter((p) => !dirs.includes(p));
      const inputs = await page.evaluate(() => window.voxellab.call('prepare_import'));
      if (files.length) await page.setInputFiles(inputs.files, files);
      for (const dir of dirs) await page.setInputFiles(inputs.folder, dir);
      return page.evaluate(() => window.voxellab.call('open'));
    }
    if (method === 'screenshot') {
      await page.evaluate(() => window.voxellab.call('settle'));
      const png = await page.locator('#canvas-wrap').screenshot({ type: 'png' });
      return { png: png.toString('base64'), mimeType: 'image/png' };
    }
    return page.evaluate(([m, p]) => window.voxellab.call(m, p), [method, params]);
  }

  async stop() {
    await this.browser?.close().catch(() => {});
    this.server?.kill();
  }
}

function writeCliResult(method, params, result) {
  if (method === 'screenshot') {
    const out = resolve(params.out || join(tmpdir(), `voxellab-${Date.now()}.png`));
    writeFileSync(out, Buffer.from(result.png, 'base64'));
    return { path: out };
  }
  if (method === 'export_roi_csv' && params.out) {
    const out = resolve(params.out);
    writeFileSync(out, result.csv || '');
    return { path: out, rows: result.rows };
  }
  return result;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function rpc(port, body) {
  return new Promise((resolveRpc, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(text);
          if (parsed.error) reject(new Error(parsed.error)); else resolveRpc(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function daemonAlive(state) {
  if (!state) return false;
  try { await rpc(state.port, { method: 'ping' }); return true; } catch { return false; }
}

async function runDaemon(opts) {
  const viewer = new Viewer(opts);
  await viewer.start();
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      queue = queue.then(async () => {
        let reply;
        try {
          const { method, params } = JSON.parse(text || '{}');
          if (method === 'ping') reply = { result: 'pong' };
          else if (method === 'stop') { reply = { result: 'stopping' }; setTimeout(async () => { await viewer.stop(); rmSync(STATE_FILE, { force: true }); process.exit(0); }, 10); }
          else reply = { result: await viewer.call(method, params || {}) };
        } catch (e) {
          reply = { error: e.message || String(e) };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
  });
  server.listen(opts.port, '127.0.0.1', () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ port: opts.port, pid: process.pid, url: viewer.url }));
    process.send?.('ready');
  });
  const shutdown = async () => { await viewer.stop(); rmSync(STATE_FILE, { force: true }); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function ensureDaemon(opts) {
  const state = readState();
  if (await daemonAlive(state)) return state;
  const args = [fileURLToPath(import.meta.url), '__daemon', '--port', String(opts.port)];
  if (opts.url) args.push('--url', opts.url);
  if (opts.headed) args.push('--headed');
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('viewer did not start within 60s')), 60_000);
    child.once('message', () => { clearTimeout(timer); resolveReady(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`viewer exited with code ${code}`)); });
  });
  child.disconnect();
  child.unref();
  return readState();
}

function toolSchema(tool) {
  return { type: 'object', properties: tool.params, required: tool.required || [], additionalProperties: false };
}

async function runMcp(opts) {
  let viewer = null;
  const getViewer = async () => {
    if (!viewer) { viewer = new Viewer(opts); await viewer.start(); }
    return viewer;
  };
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const { id, method, params } = msg;
      if (id === undefined) return;
      try {
        if (method === 'initialize') {
          send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'voxellab', version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version }, instructions: 'Drive the VoxelLab research imaging viewer. Coordinates are image pixels of the active slice (origin top-left). Call status first, open files, then screenshot/measure/roi. Research use only, not for diagnosis.' } });
        } else if (method === 'tools/list') {
          send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolSchema(t) })) } });
        } else if (method === 'tools/call') {
          const name = params?.name;
          if (!TOOLS.some((t) => t.name === name)) throw new Error(`unknown tool ${name}`);
          const args = { ...(params?.arguments || {}) };
          const v = await getViewer();
          const result = await v.call(name, args);
          const content = name === 'screenshot'
            ? [{ type: 'image', data: result.png, mimeType: result.mimeType }]
            : [{ type: 'text', text: JSON.stringify(result) }];
          send({ jsonrpc: '2.0', id, result: { content } });
        } else if (method === 'ping') {
          send({ jsonrpc: '2.0', id, result: {} });
        } else {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        }
      } catch (e) {
        if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message || String(e) }] } });
        else send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message || String(e) } });
      }
    });
  });
  rl.on('close', async () => { await queue; await viewer?.stop(); process.exit(0); });
}

function parseArgs(argv) {
  const opts = { port: DEFAULT_CONTROL_PORT, url: process.env.VOXELLAB_URL || '', headed: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--headed') opts.headed = true;
    else rest.push(a);
  }
  return { opts, rest };
}

function paramsFromCli(method, args) {
  if (args.length === 1 && args[0].startsWith('{')) return JSON.parse(args[0]);
  const num = (v) => Number(v);
  const kv = {};
  const positional = [];
  for (const a of args) {
    const m = /^--?([\w-]+)=(.*)$/.exec(a);
    if (m) kv[m[1].replace(/-/g, '_')] = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2] === 'true' ? true : m[2] === 'false' ? false : m[2];
    else positional.push(a);
  }
  switch (method) {
    case 'open': return { paths: positional, ...kv };
    case 'select_series': return { series: /^\d+$/.test(positional[0]) ? num(positional[0]) : positional[0], ...kv };
    case 'pixel': return { x: num(positional[0]), y: num(positional[1]), ...kv };
    case 'measure': return { from: [num(positional[0]), num(positional[1])], to: [num(positional[2]), num(positional[3])], ...kv };
    case 'angle': return { points: [[num(positional[0]), num(positional[1])], [num(positional[2]), num(positional[3])], [num(positional[4]), num(positional[5])]], ...kv };
    case 'annotate': return { x: num(positional[0]), y: num(positional[1]), text: positional.slice(2).join(' '), ...kv };
    case 'screenshot':
    case 'export_roi_csv': {
      const params = { ...kv };
      if (positional[0]) params.out = positional[0];
      return params;
    }
    case 'roi': {
      const [roiKind, ...nums] = positional;
      if (roiKind === 'ellipse') return { "shape": roiKind, center: [num(nums[0]), num(nums[1])], radii: [num(nums[2]), num(nums[3] ?? nums[2])], ...kv };
      const points = [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([num(nums[i]), num(nums[i + 1])]);
      return { "shape": roiKind, points, ...kv };
    }
    default: return kv;
  }
}

const HELP = `voxellab-agent: drive the VoxelLab viewer from scripts and AI agents.

  voxellab-agent start [--headed] [--url URL]   start a warm headless viewer (auto-started by any command)
  voxellab-agent stop
  voxellab-agent mcp [--headed]                  MCP server on stdio (claude mcp add voxellab -- npx voxellab-agent mcp)
  voxellab-agent tools                           list tools with JSON schemas

  voxellab-agent status
  voxellab-agent open <file-or-folder>...
  voxellab-agent select_series <index|slug>
  voxellab-agent set_view --slice=40 --window=400 --level=40 --mode=mpr
  voxellab-agent screenshot [out.png]
  voxellab-agent pixel <x> <y>
  voxellab-agent measure <x1> <y1> <x2> <y2>
  voxellab-agent angle <x1> <y1> <vx> <vy> <x2> <y2>
  voxellab-agent roi ellipse <cx> <cy> <rx> [ry]  |  roi polygon <x1> <y1> <x2> <y2> <x3> <y3>...
  voxellab-agent annotate <x> <y> <text...>
  voxellab-agent list_findings | clear [--all=true] | export_roi_csv [out.csv]

Any tool also accepts one JSON object argument. Output is JSON. Coordinates are image pixels.`;

const { opts, rest } = parseArgs(process.argv.slice(2));
const [command = 'help', ...args] = rest;

try {
  if (command === '__daemon') {
    await runDaemon(opts);
  } else if (command === 'mcp') {
    await runMcp(opts);
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
  } else if (command === 'tools') {
    console.log(JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolSchema(t) })), null, 2));
  } else if (command === 'start') {
    const state = await ensureDaemon(opts);
    console.log(JSON.stringify({ running: true, ...state }));
  } else if (command === 'stop') {
    const state = readState();
    if (await daemonAlive(state)) {
      await rpc(state.port, { method: 'stop' });
      for (let i = 0; i < 50 && await daemonAlive(state); i++) await new Promise((r) => setTimeout(r, 100));
    }
    console.log(JSON.stringify({ running: false }));
  } else if (TOOLS.some((t) => t.name === command)) {
    const params = paramsFromCli(command, args);
    const callerCwd = process.env.INIT_CWD || process.cwd();
    if (params.paths) params.paths = params.paths.map((p) => resolve(callerCwd, p));
    if (params.out) params.out = resolve(callerCwd, params.out);
    const state = await ensureDaemon(opts);
    const result = await rpc(state.port, { method: command, params });
    console.log(JSON.stringify(writeCliResult(command, params, result), null, 2));
  } else {
    console.error(`unknown command: ${command}\n\n${HELP}`);
    process.exit(2);
  }
} catch (e) {
  console.error(JSON.stringify({ error: e.message || String(e) }));
  process.exit(1);
}
