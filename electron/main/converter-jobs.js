import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS } from '../shared/desktop-contracts.js';

const DEFAULT_TOOLS = Object.freeze([
  {
    id: 'bioformats2raw',
    label: 'Bio-Formats to OME-Zarr',
    env: 'VOXELLAB_BIOFORMATS2RAW',
    inputExtensions: DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
    outputKinds: ['ome-zarr'],
    licenseNote: 'Optional external Bio-Formats bridge; verify GPL/commercial strategy before distribution.',
    outputName: 'converted.ome.zarr',
    args: (inputPath, outputPath) => [inputPath, outputPath],
  },
  {
    id: 'bfconvert',
    label: 'Bio-Formats to OME-TIFF',
    env: 'VOXELLAB_BFCONVERT',
    inputExtensions: DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
    outputKinds: ['ome-tiff'],
    licenseNote: 'Optional external Bio-Formats bridge; verify GPL/commercial strategy before distribution.',
    outputName: 'converted.ome.tiff',
    args: (inputPath, outputPath) => [inputPath, outputPath],
  },
]);

function tailAppend(current, chunk, limit = 16000) {
  const next = `${current || ''}${chunk || ''}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function safeToolConfig(tool, env = process.env) {
  const command = String(tool.command || env[tool.env] || '').trim();
  let available = false;
  if (command && path.isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      available = true;
    } catch {
      available = false;
    }
  }
  return {
    ...tool,
    command,
    available,
  };
}

function toolSupportsInputPath(tool, filePath) {
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name || name.startsWith('.')) return false;
  return tool.inputExtensions.some(extension => name.endsWith(String(extension || '').toLowerCase()));
}

function snapshot(job) {
  return {
    id: job.id,
    tool: job.tool.id,
    status: job.status,
    inputPaths: job.inputPaths,
    outputKind: job.outputKind,
    outputPath: job.outputPath,
    jobDir: job.jobDir,
    provenancePath: job.provenancePath,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    signal: job.signal || '',
    error: job.error || '',
    stdout: job.stdout || '',
    stderr: job.stderr || '',
  };
}

export class ConverterJobManager extends EventEmitter {
  constructor({ userDataPath, env = process.env, tools = DEFAULT_TOOLS } = {}) {
    super();
    this.userDataPath = userDataPath;
    this.env = env;
    this.tools = tools.map(tool => safeToolConfig(tool, env));
    this.jobs = new Map();
  }

  capabilities() {
    return {
      available: this.tools.some(tool => tool.available),
      tools: this.tools.map(tool => ({
        id: tool.id,
        label: tool.label,
        available: tool.available,
        inputExtensions: tool.inputExtensions,
        outputKinds: tool.outputKinds,
        licenseNote: tool.licenseNote,
      })),
    };
  }

  get(id) {
    const job = this.jobs.get(String(id || ''));
    return job ? snapshot(job) : null;
  }

  async start({ tool: toolId, inputPaths = [], outputKind = 'ome-zarr' } = {}) {
    const tool = this.tools.find(item => item.id === String(toolId || ''));
    if (!tool) throw new Error('Unknown conversion tool');
    if (!tool.available) throw new Error('Conversion tool is not configured');
    if (!tool.outputKinds.includes(outputKind)) throw new Error('Conversion tool does not support the requested output kind');
    if (!Array.isArray(inputPaths) || inputPaths.length !== 1 || !String(inputPaths[0] || '').trim()) {
      throw new Error('Conversion jobs require exactly one selected input file');
    }

    const inputPath = String(inputPaths[0]);
    if (!toolSupportsInputPath(tool, inputPath)) {
      throw new Error('Conversion tool does not support the selected input file');
    }
    let inputStat;
    try {
      inputStat = await fs.stat(inputPath);
    } catch {
      throw new Error('Selected input file is unavailable');
    }
    if (!inputStat.isFile()) throw new Error('Selected input path is not a file');
    const root = typeof this.userDataPath === 'function' ? this.userDataPath() : this.userDataPath;
    if (!root) throw new Error('Conversion job storage is unavailable');
    const jobDir = await fs.mkdtemp(path.join(root, 'conversions-'));
    const outputPath = path.join(jobDir, tool.outputName);
    const provenancePath = path.join(jobDir, 'provenance.json');
    const job = {
      id: randomUUID(),
      tool,
      status: 'running',
      inputPaths: [inputPath],
      outputKind,
      outputPath,
      jobDir,
      provenancePath,
      startedAt: new Date().toISOString(),
      exitCode: null,
      child: null,
    };
    this.jobs.set(job.id, job);
    this.emitChange(job);

    const args = tool.args(inputPath, outputPath);
    job.child = spawn(tool.command, args, { cwd: jobDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    job.child.stdout?.on('data', chunk => {
      job.stdout = tailAppend(job.stdout, chunk.toString());
      this.emitChange(job);
    });
    job.child.stderr?.on('data', chunk => {
      job.stderr = tailAppend(job.stderr, chunk.toString());
      this.emitChange(job);
    });
    job.child.on('error', error => this.finish(job, 'failed', { error: error.message }));
    job.child.on('close', (exitCode, signal) => {
      if (job.status === 'canceled') return;
      const status = exitCode === 0 ? 'completed' : 'failed';
      return this.finish(job, status, { exitCode, signal });
    });
    return snapshot(job);
  }

  async cancel(id) {
    const job = this.jobs.get(String(id || ''));
    if (!job) return null;
    if (job.status !== 'running') return snapshot(job);
    job.status = 'canceled';
    job.finishedAt = new Date().toISOString();
    job.child?.kill();
    await this.writeProvenance(job);
    this.emitChange(job);
    return snapshot(job);
  }

  async finish(job, status, { exitCode = null, signal = '', error = '' } = {}) {
    if (job.status !== 'running') return snapshot(job);
    job.status = status;
    job.exitCode = exitCode;
    job.signal = signal || '';
    job.error = error || '';
    job.finishedAt = new Date().toISOString();
    await this.writeProvenance(job);
    this.emitChange(job);
    return snapshot(job);
  }

  async writeProvenance(job) {
    const payload = snapshot(job);
    await fs.writeFile(job.provenancePath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  emitChange(job) {
    this.emit('changed', snapshot(job));
  }
}
