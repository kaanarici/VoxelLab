import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync, writeFileSync } from 'node:fs';
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
    knownLosses: {
      'ome-zarr': [
        'Proprietary vendor metadata not represented in OME-NGFF may be dropped by the external converter.',
        'Pyramid, chunk, and compression layout are converter-defined, not VoxelLab-authored.',
      ],
    },
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
    knownLosses: {
      'ome-tiff': [
        'Proprietary vendor metadata not represented in OME-XML may be dropped by the external converter.',
        'Display settings and acquisition annotations may not round-trip unless the converter preserves them.',
      ],
    },
    outputName: 'converted.ome.tiff',
    args: (inputPath, outputPath) => [inputPath, outputPath],
  },
]);

const DEFAULT_KNOWN_LOSSES = Object.freeze({
  'ome-zarr': [
    'Proprietary vendor metadata not represented in OME-NGFF may be dropped by the external converter.',
  ],
  'ome-tiff': [
    'Proprietary vendor metadata not represented in OME-XML may be dropped by the external converter.',
  ],
});

const DEFAULT_CANCEL_GRACE_MS = 3000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TERMINAL_CONVERSION_JOBS = 24;
export const CONVERTER_JOB_OWNER_FILE = '.voxellab-converter-owner.json';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const MAX_OWNER_MARKER_BYTES = 4096;
const MAX_TIFF_IFD_ENTRIES = 4096;
const MAX_OME_DESCRIPTION_BYTES = 4 * 1024 * 1024;
const TIFF_TYPE_BYTES = new Map([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [6, 1],
  [7, 1], [8, 2], [9, 4], [10, 8], [11, 4], [12, 8],
  [16, 8], [17, 8], [18, 8],
]);

function tailAppend(current, chunk, limit = 16000) {
  const next = `${current || ''}${chunk || ''}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function safeToolConfig(tool, env = process.env, platform = process.platform) {
  const command = String(tool.command || env[tool.env] || '').trim();
  let reason = 'converter_not_configured';
  if (command && !path.isAbsolute(command)) reason = 'converter_path_not_absolute';
  if (command && path.isAbsolute(command)) {
    try {
      accessSync(command, constants.F_OK);
    } catch {
      reason = 'converter_path_missing';
    }
    if (reason !== 'converter_path_missing') {
      try {
        if (!statSync(command).isFile()) reason = 'converter_path_not_executable';
        else if (platform === 'win32' && !['.exe', '.com'].includes(path.extname(command).toLowerCase())) {
          reason = 'converter_path_not_executable';
        }
        else {
          if (platform !== 'win32') accessSync(command, constants.X_OK);
          reason = '';
        }
      } catch {
        reason = 'converter_path_not_executable';
      }
    }
  }
  return {
    ...tool,
    command,
    available: !reason,
    reason,
  };
}

function toolSupportsInputPath(tool, filePath) {
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name || name.startsWith('.')) return false;
  return tool.inputExtensions.some(extension => name.endsWith(String(extension || '').toLowerCase()));
}

function fileRecord(filePath, stat) {
  const name = path.basename(String(filePath || ''));
  return {
    path: filePath,
    name,
    extension: path.extname(name).toLowerCase(),
    bytes: stat?.isFile?.() ? stat.size : null,
    kind: stat?.isDirectory?.() ? 'directory' : 'file',
    modifiedAt: stat?.mtime instanceof Date ? stat.mtime.toISOString() : '',
  };
}

function knownLossesFor(tool, outputKind) {
  const explicit = tool.knownLosses?.[outputKind] || tool.knownLosses;
  const losses = Array.isArray(explicit) ? explicit : DEFAULT_KNOWN_LOSSES[outputKind] || [];
  return losses.map(item => String(item || '').trim()).filter(Boolean);
}

async function outputArtifactRecord(outputPath) {
  try {
    const stat = await fs.stat(outputPath);
    const record = fileRecord(outputPath, stat);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(outputPath).catch(() => []);
      record.entryCount = entries.length;
      record.entries = entries.slice(0, 20);
    }
    return record;
  } catch {
    return {
      path: outputPath,
      name: path.basename(String(outputPath || '')),
      extension: path.extname(String(outputPath || '')).toLowerCase(),
      kind: 'missing',
      bytes: null,
      modifiedAt: '',
    };
  }
}

function hasOmeZarrMultiscales(metadata) {
  const attributes = metadata?.attributes || metadata;
  const multiscales = attributes?.ome?.multiscales || attributes?.multiscales;
  return Array.isArray(multiscales) && multiscales.length > 0;
}

function validateFileRange(fileSize, position, length) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > fileSize) {
    throw new Error('Converter output has a truncated TIFF structure');
  }
}

async function readFileRange(handle, fileSize, position, length) {
  validateFileRange(fileSize, position, length);
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  if (bytesRead !== length) throw new Error('Converter output has a truncated TIFF structure');
  return bytes;
}

async function validateOmeTiff(handle, fileSize) {
  const header = await readFileRange(handle, fileSize, 0, Math.min(fileSize, 16));
  if (header.length < 8) throw new Error('Converter output has a truncated TIFF structure');
  const byteOrder = header.toString('ascii', 0, 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') throw new Error('Converter output does not have a TIFF signature');
  const uint16 = (buffer, offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const uint32 = (buffer, offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const uint64 = (buffer, offset) => {
    const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converter output TIFF offset exceeds the supported range');
    return Number(value);
  };
  const magic = uint16(header, 2);
  const bigTiff = magic === 43;
  if (magic !== 42 && !bigTiff) throw new Error('Converter output is not a supported TIFF');
  if (bigTiff && (header.length < 16 || uint16(header, 4) !== 8 || uint16(header, 6) !== 0)) {
    throw new Error('Converter output has an invalid BigTIFF header');
  }
  const offsetBytes = bigTiff ? 8 : 4;
  const entrySize = bigTiff ? 20 : 12;
  const countSize = bigTiff ? 8 : 2;
  const valueOffset = bigTiff ? 12 : 8;
  const ifdOffset = bigTiff ? uint64(header, 8) : uint32(header, 4);
  const countBytes = await readFileRange(handle, fileSize, ifdOffset, countSize);
  const entryCount = bigTiff ? uint64(countBytes, 0) : uint16(countBytes, 0);
  if (!entryCount || entryCount > MAX_TIFF_IFD_ENTRIES) throw new Error('Converter output has an invalid first TIFF IFD');
  const table = await readFileRange(handle, fileSize, ifdOffset + countSize, entryCount * entrySize + offsetBytes);
  let width = 0;
  let height = 0;
  let description = '';
  for (let index = 0; index < entryCount; index += 1) {
    const entry = table.subarray(index * entrySize, index * entrySize + entrySize);
    const tag = uint16(entry, 0);
    const type = uint16(entry, 2);
    const count = bigTiff ? uint64(entry, 4) : uint32(entry, 4);
    const typeBytes = TIFF_TYPE_BYTES.get(type);
    const valueBytes = typeBytes && Number.isSafeInteger(count * typeBytes) ? count * typeBytes : 0;
    if (!typeBytes || !count || !valueBytes) throw new Error('Converter output has an invalid first TIFF IFD entry');
    const externalOffset = () => bigTiff ? uint64(entry, valueOffset) : uint32(entry, valueOffset);
    if (valueBytes > offsetBytes) validateFileRange(fileSize, externalOffset(), valueBytes);
    let scalar = 0;
    if (count === 1 && type === 3) scalar = uint16(entry, valueOffset);
    if (count === 1 && type === 4) scalar = uint32(entry, valueOffset);
    if (count === 1 && type === 16) scalar = uint64(entry, valueOffset);
    if (tag === 256) width = scalar;
    if (tag === 257) height = scalar;
    if (tag !== 270) continue;
    if (type !== 2 || !count || count > MAX_OME_DESCRIPTION_BYTES) {
      throw new Error('Converter output has an invalid TIFF ImageDescription');
    }
    const bytes = count <= offsetBytes
      ? entry.subarray(valueOffset, valueOffset + count)
      : await readFileRange(handle, fileSize, externalOffset(), count);
    description = bytes.toString('utf8').replace(/\0+$/, '');
  }
  if (!(width > 0 && height > 0)) throw new Error('Converter output first TIFF IFD is missing image dimensions');
  const pixels = description.match(/<Pixels\b([^>]*)>/i)?.[1] || '';
  const sizeX = Number(pixels.match(/\bSizeX=["']([1-9]\d*)["']/i)?.[1] || 0);
  const sizeY = Number(pixels.match(/\bSizeY=["']([1-9]\d*)["']/i)?.[1] || 0);
  if (!/<OME(?:\s|>)/i.test(description) || !/<\/OME>/i.test(description) || !sizeX || !sizeY) {
    throw new Error('Converter output TIFF ImageDescription does not contain valid OME-XML');
  }
  if (sizeX !== width || sizeY !== height) {
    throw new Error('Converter output OME dimensions do not match the first TIFF IFD');
  }
}

async function validateOutputArtifact(outputKind, outputPath) {
  const record = await outputArtifactRecord(outputPath);
  if (outputKind === 'ome-tiff') {
    if (record.kind !== 'file' || !record.bytes) {
      throw new Error('Converter exited successfully without a non-empty OME-TIFF output');
    }
    const handle = await fs.open(outputPath, 'r');
    try {
      await validateOmeTiff(handle, record.bytes);
    } finally {
      await handle.close();
    }
    return record;
  }

  if (outputKind === 'ome-zarr') {
    if (record.kind !== 'directory' || !record.entryCount) {
      throw new Error('Converter exited successfully without a non-empty OME-Zarr directory');
    }
    const metadataNames = ['zarr.json', '.zattrs', '.zmetadata'];
    let validMetadata = false;
    for (const name of metadataNames) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(outputPath, name), 'utf8'));
        const metadata = name === '.zmetadata' ? parsed?.metadata?.['.zattrs'] : parsed;
        if (hasOmeZarrMultiscales(metadata)) {
          validMetadata = true;
          break;
        }
      } catch {
        // Try the next recognized root metadata file.
      }
    }
    if (!validMetadata) throw new Error('Converter output is missing valid OME-Zarr root metadata');
    return record;
  }

  throw new Error(`Unsupported conversion output kind: ${outputKind}`);
}

function signalProcessTree(child, signal, platform = process.platform) {
  if (!child?.pid) return false;
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  return child.kill(signal);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function snapshot(job) {
  return {
    id: job.id,
    tool: job.tool.id,
    toolLabel: job.tool.label,
    status: job.status,
    inputPaths: job.inputPaths,
    inputFiles: job.inputFiles || [],
    outputKind: job.outputKind,
    outputPath: job.outputPath,
    knownLosses: job.knownLosses || [],
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
  constructor({
    userDataPath,
    env = process.env,
    tools = DEFAULT_TOOLS,
    signalChild = signalProcessTree,
    cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    maxTerminalJobs = DEFAULT_MAX_TERMINAL_CONVERSION_JOBS,
    // The Electron main process supplies shell.trashItem. Keeping this injected
    // makes the lifecycle policy testable without permanently deleting files.
    releaseJobDir = async () => false,
    platform = process.platform,
    isProcessAlive = processIsAlive,
    ownerPid = process.pid,
    sessionId = randomUUID(),
  } = {}) {
    super();
    this.userDataPath = userDataPath;
    this.env = env;
    this.platform = platform;
    this.tools = tools.map(tool => safeToolConfig(tool, env, platform));
    this.jobs = new Map();
    this.terminalArtifactDirs = new Set();
    this.signalChild = signalChild;
    this.cancelGraceMs = Math.max(1, Number(cancelGraceMs) || DEFAULT_CANCEL_GRACE_MS);
    this.shutdownTimeoutMs = Math.min(
      30_000,
      Math.max(this.cancelGraceMs * 2 + 100, Math.floor(Number(shutdownTimeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS)),
    );
    this.maxTerminalJobs = Math.max(1, Math.floor(Number(maxTerminalJobs) || DEFAULT_MAX_TERMINAL_CONVERSION_JOBS));
    this.releaseJobDir = releaseJobDir;
    this.isProcessAlive = isProcessAlive;
    this.ownerPid = Number(ownerPid);
    this.sessionId = String(sessionId || randomUUID());
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  capabilities() {
    return {
      available: this.tools.some(tool => tool.available),
      tools: this.tools.map(tool => ({
        id: tool.id,
        label: tool.label,
        available: tool.available,
        reason: tool.reason,
        env: tool.env,
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
    if (this.shuttingDown) throw new Error('Conversion manager is shutting down');
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
    const root = this.storageRoot();
    if (!root) throw new Error('Conversion job storage is unavailable');
    const jobDir = await fs.mkdtemp(path.join(root, 'conversions-'));
    const outputPath = path.join(jobDir, tool.outputName);
    const provenancePath = path.join(jobDir, 'provenance.json');
    const job = {
      id: randomUUID(),
      tool,
      status: 'running',
      inputPaths: [inputPath],
      inputFiles: [fileRecord(inputPath, inputStat)],
      outputKind,
      outputPath,
      knownLosses: knownLossesFor(tool, outputKind),
      jobDir,
      provenancePath,
      startedAt: new Date().toISOString(),
      exitCode: null,
      child: null,
      childClosed: false,
    };
    job.closedPromise = new Promise(resolve => {
      job.resolveClosed = resolve;
    });
    this.jobs.set(job.id, job);
    this.emitChange(job);

    const args = tool.args(inputPath, outputPath);
    job.child = spawn(tool.command, args, {
      cwd: jobDir,
      detached: this.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.child.stdout?.on('data', chunk => {
      job.stdout = tailAppend(job.stdout, chunk.toString());
      this.emitChange(job);
    });
    job.child.stderr?.on('data', chunk => {
      job.stderr = tailAppend(job.stderr, chunk.toString());
      this.emitChange(job);
    });
    job.child.on('error', error => {
      job.spawnError = error?.message || String(error);
    });
    job.child.on('close', (exitCode, signal) => {
      job.childClosed = true;
      this.finishAfterClose(job, exitCode, signal).catch(error => {
        job.status = 'failed';
        job.error = error?.message || String(error);
        job.finishedAt = new Date().toISOString();
        this.emitChange(job);
      }).finally(() => job.resolveClosed?.(snapshot(job)));
    });
    try {
      this.writeOwnershipMarker(job);
    } catch (error) {
      job.cancelRequested = true;
      this.sendSignal(job, 'SIGKILL');
      throw new Error(`Conversion ownership marker could not be written: ${error?.message || String(error)}`);
    }
    return snapshot(job);
  }

  async cancel(id) {
    const job = this.jobs.get(String(id || ''));
    if (!job) return null;
    if (job.status !== 'running') return snapshot(job);
    job.status = 'canceling';
    job.cancelRequested = true;
    this.sendSignal(job, 'SIGTERM');
    job.cancelTimer = setTimeout(() => {
      this.sendSignal(job, 'SIGKILL');
      job.cancelDeadlineTimer = setTimeout(() => {
        this.finish(job, 'failed', {
          error: 'Conversion process did not exit after cancellation signals and may still be running',
        }).catch(error => {
          job.status = 'failed';
          job.error = error?.message || String(error);
          job.finishedAt = new Date().toISOString();
          this.emitChange(job);
        });
      }, this.cancelGraceMs);
      job.cancelDeadlineTimer.unref?.();
    }, this.cancelGraceMs);
    job.cancelTimer.unref?.();
    this.emitChange(job);
    return snapshot(job);
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownRunningJobs();
    return this.shutdownPromise;
  }

  async shutdownRunningJobs() {
    const running = [...this.jobs.values()].filter(job => job.child && !job.childClosed);
    for (const job of running) {
      if (job.status === 'running') await this.cancel(job.id);
      else if (TERMINAL_STATUSES.has(job.status)) {
        try {
          this.signalChild(job.child, 'SIGKILL', this.platform);
        } catch {
          // The timeout result below keeps a demonstrably live directory out of cleanup.
        }
      }
    }
    const timedOut = [];
    await Promise.all(running.map(async job => {
      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
      });
      const closed = await Promise.race([
        job.closedPromise.then(() => true),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      if (!closed) timedOut.push(job.id);
    }));
    return {
      jobs: running.map(job => snapshot(job)),
      timedOut,
    };
  }

  sendSignal(job, signal) {
    if (TERMINAL_STATUSES.has(job.status)) return false;
    try {
      return this.signalChild(job.child, signal, this.platform);
    } catch {
      return false;
    }
  }

  async finishAfterClose(job, exitCode, signal) {
    if (TERMINAL_STATUSES.has(job.status)) return snapshot(job);
    if (job.cancelRequested) {
      return this.finish(job, 'canceled', { exitCode, signal });
    }
    if (job.spawnError) {
      return this.finish(job, 'failed', { exitCode, signal, error: job.spawnError });
    }
    if (exitCode !== 0) return this.finish(job, 'failed', { exitCode, signal });
    try {
      job.outputFiles = [await validateOutputArtifact(job.outputKind, job.outputPath)];
    } catch (error) {
      return this.finish(job, 'failed', { exitCode, signal, error: error?.message || String(error) });
    }
    if (job.cancelRequested) return this.finish(job, 'canceled', { exitCode, signal });
    return this.finish(job, 'completed', { exitCode, signal });
  }

  async finish(job, status, { exitCode = null, signal = '', error = '' } = {}) {
    if (TERMINAL_STATUSES.has(job.status)) return snapshot(job);
    if (job.cancelTimer) clearTimeout(job.cancelTimer);
    if (job.cancelDeadlineTimer) clearTimeout(job.cancelDeadlineTimer);
    job.status = status;
    job.exitCode = exitCode;
    job.signal = signal || '';
    job.error = error || '';
    job.finishedAt = new Date().toISOString();
    await this.writeProvenance(job);
    this.terminalArtifactDirs.add(job.jobDir);
    this.emitChange(job);
    this.trimTerminalJobHistory();
    return snapshot(job);
  }

  trimTerminalJobHistory() {
    const terminal = [...this.jobs.values()]
      .filter(job => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => String(left.finishedAt).localeCompare(String(right.finishedAt)));
    for (const job of terminal.slice(0, Math.max(0, terminal.length - this.maxTerminalJobs))) {
      this.jobs.delete(job.id);
    }
  }

  async releaseTerminalArtifacts() {
    const jobDirs = new Set(this.terminalArtifactDirs);
    for (const job of this.jobs.values()) {
      if (TERMINAL_STATUSES.has(job.status) && !job.artifactReleased) jobDirs.add(job.jobDir);
    }
    const released = [];
    for (const jobDir of jobDirs) {
      const job = [...this.jobs.values()].find(item => item.jobDir === jobDir);
      if ((job?.child && !job.childClosed) || await this.hasLiveChildOwner(jobDir)) continue;
      if (!await this.releaseArtifactDirectory(jobDir)) continue;
      released.push(jobDir);
      this.terminalArtifactDirs.delete(jobDir);
      for (const job of this.jobs.values()) {
        if (job.jobDir === jobDir) job.artifactReleased = true;
      }
    }
    return released;
  }

  async releaseStaleArtifacts() {
    const root = this.storageRoot();
    if (!root) return [];
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const rootPath = path.resolve(root);
    const released = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('conversions-')) continue;
      const jobDir = path.resolve(rootPath, entry.name);
      if (path.dirname(jobDir) !== rootPath) continue;
      if (await this.hasLiveOwnership(jobDir)) continue;
      if (await this.releaseArtifactDirectory(jobDir)) released.push(jobDir);
    }
    return released;
  }

  storageRoot() {
    return typeof this.userDataPath === 'function' ? this.userDataPath() : this.userDataPath;
  }

  async releaseArtifactDirectory(jobDir) {
    try {
      return (await this.releaseJobDir(jobDir)) !== false;
    } catch {
      // Keep artifacts when the platform trash is unavailable. A later startup
      // retries stale-session cleanup without risking permanent deletion.
      return false;
    }
  }

  writeOwnershipMarker(job) {
    const payload = {
      schema: 'voxellab.desktop-conversion-owner.v1',
      sessionId: this.sessionId,
      ownerPid: this.ownerPid,
      childPid: Number(job.child?.pid || 0),
      jobId: job.id,
      startedAt: job.startedAt,
    };
    writeFileSync(path.join(job.jobDir, CONVERTER_JOB_OWNER_FILE), `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async readOwnershipMarker(jobDir) {
    const marker = path.join(jobDir, CONVERTER_JOB_OWNER_FILE);
    try {
      const stat = await fs.stat(marker);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_MARKER_BYTES) return null;
      const payload = JSON.parse(await fs.readFile(marker, 'utf8'));
      if (payload?.schema !== 'voxellab.desktop-conversion-owner.v1') return null;
      return payload;
    } catch {
      return null;
    }
  }

  async hasLiveOwnership(jobDir) {
    const ownership = await this.readOwnershipMarker(jobDir);
    if (!ownership) return false;
    return this.isProcessAlive(Number(ownership.ownerPid))
      || this.isProcessAlive(Number(ownership.childPid));
  }

  async hasLiveChildOwner(jobDir) {
    const ownership = await this.readOwnershipMarker(jobDir);
    return Boolean(ownership && this.isProcessAlive(Number(ownership.childPid)));
  }

  async writeProvenance(job) {
    const outputFiles = job.outputFiles || [await outputArtifactRecord(job.outputPath)];
    const payload = {
      schema: 'voxellab.desktop-conversion-provenance.v1',
      exportedAt: new Date().toISOString(),
      ...snapshot(job),
      toolEnv: job.tool.env || '',
      toolVersion: String(job.tool.version || ''),
      outputFiles,
    };
    await fs.writeFile(job.provenancePath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  emitChange(job) {
    this.emit('changed', snapshot(job));
  }
}
