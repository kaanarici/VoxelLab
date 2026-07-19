/* global Buffer, Request, Response */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { clearCloudSettings, saveCloudSettings } from '../electron/main/cloud-settings.js';
import {
  CONVERTER_JOB_OWNER_FILE,
  ConverterJobManager,
} from '../electron/main/converter-jobs.js';
import {
  handleDesktopLocalApiRequest,
  MAX_DESKTOP_LOCAL_API_BODY_BYTES,
} from '../electron/main/local-api-proxy.js';
import {
  MAX_NATIVE_READ_RANGE_BYTES,
  readNativeFileRange,
} from '../electron/main/native-paths.js';
import { writeCalibratedOmeTiff } from './fixtures/microscopy/calibrated-ome-tiff.mjs';

async function writeTinyBigOmeTiff(filePath, { sizeX = 2, sizeY = 2 } = {}) {
  const description = Buffer.from(`<?xml version="1.0"?><OME><Image><Pixels SizeX="${sizeX}" SizeY="${sizeY}" SizeZ="1" SizeC="1" SizeT="1"/></Image></OME>\0`);
  const ifdOffset = 16;
  const entryCount = 3;
  const descriptionOffset = ifdOffset + 8 + entryCount * 20 + 8;
  const buffer = Buffer.alloc(descriptionOffset + description.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(43, 2);
  buffer.writeUInt16LE(8, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeBigUInt64LE(BigInt(ifdOffset), 8);
  buffer.writeBigUInt64LE(BigInt(entryCount), ifdOffset);
  let cursor = ifdOffset + 8;
  const entry = (tag, type, count, value, inline = false) => {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeBigUInt64LE(BigInt(count), cursor + 4);
    if (inline) buffer.writeUInt32LE(value, cursor + 12);
    else buffer.writeBigUInt64LE(BigInt(value), cursor + 12);
    cursor += 20;
  };
  entry(256, 4, 1, 2, true);
  entry(257, 4, 1, 2, true);
  entry(270, 2, description.length, descriptionOffset);
  buffer.writeBigUInt64LE(0n, cursor);
  description.copy(buffer, descriptionOffset);
  await fs.writeFile(filePath, buffer);
}

function waitForTerminalJob(manager, id) {
  return new Promise((resolve) => {
    const onChange = (snapshot) => {
      if (snapshot.id !== id || !['completed', 'failed', 'canceled'].includes(snapshot.status)) return;
      manager.off('changed', onChange);
      resolve(snapshot);
    };
    manager.on('changed', onChange);
    const current = manager.get(id);
    if (current) onChange(current);
  });
}

async function runFakeConversion(root, scriptPath, inputPath, { mode, outputKind, outputName, fixturePath = '' }) {
  const manager = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_TEST_CONVERTER: process.execPath },
    tools: [{
      id: 'test-converter',
      label: 'Test converter',
      env: 'VOXELLAB_TEST_CONVERTER',
      inputExtensions: ['.czi'],
      outputKinds: [outputKind],
      outputName,
      args: (_input, output) => [scriptPath, mode, output, fixturePath],
    }],
  });
  const job = await manager.start({ tool: 'test-converter', inputPaths: [inputPath], outputKind });
  return waitForTerminalJob(manager, job.id);
}

test('desktop conversion rejects exit-zero missing, empty, and wrong-kind artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-output-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'output-converter.mjs');
  const calibratedTiff = path.join(root, 'calibrated.ome.tiff');
  const bigTiff = path.join(root, 'calibrated-big.ome.tiff');
  const mismatchedTiff = path.join(root, 'mismatched.ome.tiff');
  const mismatchedBigTiff = path.join(root, 'mismatched-big.ome.tiff');
  const plainTiff = path.join(root, 'plain.tiff');
  await fs.writeFile(inputPath, 'fake czi');
  await writeCalibratedOmeTiff(calibratedTiff);
  await writeTinyBigOmeTiff(bigTiff);
  const mismatch = await fs.readFile(calibratedTiff);
  mismatch.write('15', mismatch.indexOf('SizeX="16"') + 7, 'ascii');
  await fs.writeFile(mismatchedTiff, mismatch);
  await writeTinyBigOmeTiff(mismatchedBigTiff, { sizeX: 3 });
  const plain = await fs.readFile(calibratedTiff);
  plain.write('<BAD', plain.indexOf('<OME'), 'ascii');
  await fs.writeFile(plainTiff, plain);
  await fs.writeFile(scriptPath, `
    import fs from 'node:fs/promises';
    const [, , mode, output, fixture] = process.argv;
    if (mode === 'empty-zarr') await fs.mkdir(output, { recursive: true });
    if (mode === 'wrong-zarr-kind') await fs.writeFile(output, '{}');
    if (mode === 'zarr-without-metadata') {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(output + '/chunk', 'data');
    }
    if (mode === 'empty-tiff') await fs.writeFile(output, '');
    if (mode === 'wrong-tiff-signature') await fs.writeFile(output, 'not a tiff');
    if (mode === 'truncated-tiff') await fs.writeFile(output, Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0]));
    if (mode === 'copy-tiff') await fs.copyFile(fixture, output);
  `);

  const cases = [
    ['missing OME-Zarr', { mode: 'missing', outputKind: 'ome-zarr', outputName: 'converted.ome.zarr' }, /without a non-empty OME-Zarr/i],
    ['empty OME-Zarr', { mode: 'empty-zarr', outputKind: 'ome-zarr', outputName: 'converted.ome.zarr' }, /without a non-empty OME-Zarr/i],
    ['wrong OME-Zarr kind', { mode: 'wrong-zarr-kind', outputKind: 'ome-zarr', outputName: 'converted.ome.zarr' }, /without a non-empty OME-Zarr/i],
    ['OME-Zarr without metadata', { mode: 'zarr-without-metadata', outputKind: 'ome-zarr', outputName: 'converted.ome.zarr' }, /missing valid OME-Zarr root metadata/i],
    ['empty OME-TIFF', { mode: 'empty-tiff', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff' }, /without a non-empty OME-TIFF/i],
    ['wrong OME-TIFF signature', { mode: 'wrong-tiff-signature', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff' }, /does not have a TIFF signature/i],
    ['truncated OME-TIFF', { mode: 'truncated-tiff', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff' }, /truncated TIFF structure/i],
    ['plain TIFF without OME metadata', { mode: 'copy-tiff', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff', fixturePath: plainTiff }, /does not contain valid OME-XML/i],
    ['OME-TIFF with mismatched dimensions', { mode: 'copy-tiff', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff', fixturePath: mismatchedTiff }, /dimensions do not match/i],
    ['BigTIFF with mismatched dimensions', { mode: 'copy-tiff', outputKind: 'ome-tiff', outputName: 'converted.ome.tiff', fixturePath: mismatchedBigTiff }, /dimensions do not match/i],
  ];
  for (const [name, options, errorPattern] of cases) {
    await t.test(name, async () => {
      const job = await runFakeConversion(root, scriptPath, inputPath, options);
      assert.equal(job.status, 'failed');
      assert.equal(job.exitCode, 0);
      assert.match(job.error, errorPattern);
      const provenance = JSON.parse(await fs.readFile(job.provenancePath, 'utf8'));
      assert.equal(provenance.status, 'failed');
      assert.match(provenance.error, errorPattern);
    });
  }

  const valid = await runFakeConversion(root, scriptPath, inputPath, {
    mode: 'copy-tiff',
    outputKind: 'ome-tiff',
    outputName: 'converted.ome.tiff',
    fixturePath: calibratedTiff,
  });
  assert.equal(valid.status, 'completed');
  const validBigTiff = await runFakeConversion(root, scriptPath, inputPath, {
    mode: 'copy-tiff',
    outputKind: 'ome-tiff',
    outputName: 'converted.ome.tiff',
    fixturePath: bigTiff,
  });
  assert.equal(validBigTiff.status, 'completed');
});

test('desktop cancellation fails terminally when TERM and KILL cannot stop the child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-cancel-failed-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'slow-converter.mjs');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(scriptPath, 'setTimeout(() => {}, 100);');
  const signals = [];
  const manager = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_TEST_CONVERTER: process.execPath },
    tools: [{
      id: 'test-converter',
      label: 'Test converter',
      env: 'VOXELLAB_TEST_CONVERTER',
      inputExtensions: ['.czi'],
      outputKinds: ['ome-zarr'],
      outputName: 'converted.ome.zarr',
      args: () => [scriptPath],
    }],
    cancelGraceMs: 10,
    signalChild(_child, signal) {
      signals.push(signal);
      return false;
    },
  });

  const running = await manager.start({ tool: 'test-converter', inputPaths: [inputPath], outputKind: 'ome-zarr' });
  assert.equal((await manager.cancel(running.id)).status, 'canceling');
  const failed = await waitForTerminalJob(manager, running.id);

  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /may still be running/i);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  const provenance = JSON.parse(await fs.readFile(failed.provenancePath, 'utf8'));
  assert.equal(provenance.status, 'failed');
  assert.match(provenance.error, /may still be running/i);
});

test('desktop converter shutdown terminates and awaits running children before artifact release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-shutdown-'));
  const inputPath = path.join(root, 'cells.czi');
  const scriptPath = path.join(root, 'running-converter.mjs');
  await fs.writeFile(inputPath, 'fake czi');
  await fs.writeFile(scriptPath, 'setInterval(() => {}, 1000);');
  const released = [];
  const manager = new ConverterJobManager({
    userDataPath: root,
    env: { VOXELLAB_TEST_CONVERTER: process.execPath },
    tools: [{
      id: 'test-converter',
      label: 'Test converter',
      env: 'VOXELLAB_TEST_CONVERTER',
      inputExtensions: ['.czi'],
      outputKinds: ['ome-zarr'],
      outputName: 'converted.ome.zarr',
      args: () => [scriptPath],
    }],
    cancelGraceMs: 20,
    shutdownTimeoutMs: 1000,
    releaseJobDir: async jobDir => {
      released.push(jobDir);
      return true;
    },
  });

  const running = await Promise.all([0, 1].map(() => manager.start({
    tool: 'test-converter',
    inputPaths: [inputPath],
    outputKind: 'ome-zarr',
  })));
  const ownership = await Promise.all(running.map(job => fs.readFile(
    path.join(job.jobDir, CONVERTER_JOB_OWNER_FILE),
    'utf8',
  ).then(JSON.parse)));
  assert.equal(ownership.every(record => record.ownerPid === process.pid), true);
  assert.equal(ownership.every(record => record.childPid > 0), true);

  const shutdown = await manager.shutdown();
  assert.deepEqual(shutdown.timedOut, []);
  assert.equal(shutdown.jobs.length, 2);
  for (let index = 0; index < running.length; index += 1) {
    const job = running[index];
    assert.equal(manager.get(job.id).status, 'canceled');
    assert.equal(JSON.parse(await fs.readFile(job.provenancePath, 'utf8')).status, 'canceled');
    assert.equal((await fs.stat(job.jobDir)).isDirectory(), true, 'shutdown retains terminal artifacts until cleanup');
    assert.throws(() => process.kill(ownership[index].childPid, 0), error => error?.code === 'ESRCH');
  }

  assert.deepEqual((await manager.releaseTerminalArtifacts()).sort(), running.map(job => job.jobDir).sort());
  assert.deepEqual(released.sort(), running.map(job => job.jobDir).sort());
  await assert.rejects(
    manager.start({ tool: 'test-converter', inputPaths: [inputPath], outputKind: 'ome-zarr' }),
    /shutting down/i,
  );
});

test('stale converter cleanup skips directories with a demonstrably live owner or child PID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-live-owner-'));
  const liveOwner = path.join(root, 'conversions-live-owner');
  const liveChild = path.join(root, 'conversions-live-child');
  const staleOwned = path.join(root, 'conversions-stale-owned');
  const staleUnmarked = path.join(root, 'conversions-stale-unmarked');
  await Promise.all([liveOwner, liveChild, staleOwned, staleUnmarked].map(dir => fs.mkdir(dir)));
  const marker = (ownerPid, childPid) => `${JSON.stringify({
    schema: 'voxellab.desktop-conversion-owner.v1',
    sessionId: 'previous-session',
    ownerPid,
    childPid,
    jobId: 'previous-job',
  })}\n`;
  await fs.writeFile(path.join(liveOwner, CONVERTER_JOB_OWNER_FILE), marker(101, 0));
  await fs.writeFile(path.join(liveChild, CONVERTER_JOB_OWNER_FILE), marker(0, 202));
  await fs.writeFile(path.join(staleOwned, CONVERTER_JOB_OWNER_FILE), marker(303, 404));
  const released = [];
  const manager = new ConverterJobManager({
    userDataPath: root,
    isProcessAlive: pid => pid === 101 || pid === 202,
    releaseJobDir: async jobDir => {
      released.push(jobDir);
      return true;
    },
  });

  const cleaned = await manager.releaseStaleArtifacts();
  assert.deepEqual(cleaned.sort(), [staleOwned, staleUnmarked].sort());
  assert.deepEqual(released.sort(), [staleOwned, staleUnmarked].sort());
});

test('desktop converter artifacts are session-scoped and only release terminal job directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-converter-retention-'));
  const stale = path.join(root, 'conversions-stale');
  const staleSecond = path.join(root, 'conversions-stale-second');
  const nonArtifact = path.join(root, 'not-a-conversion');
  await Promise.all([fs.mkdir(stale), fs.mkdir(staleSecond), fs.mkdir(nonArtifact)]);
  await fs.writeFile(path.join(root, 'conversions-not-a-directory'), 'keep');

  const released = [];
  const manager = new ConverterJobManager({
    userDataPath: root,
    maxTerminalJobs: 1,
    releaseJobDir: async jobDir => {
      released.push(jobDir);
      return true;
    },
  });

  assert.deepEqual(await manager.releaseStaleArtifacts(), [stale, staleSecond]);
  assert.deepEqual(released, [stale, staleSecond]);

  manager.jobs.set('first', {
    id: 'first',
    status: 'completed',
    jobDir: stale,
    finishedAt: '2026-01-01T00:00:00.000Z',
  });
  manager.jobs.set('second', {
    id: 'second',
    status: 'failed',
    jobDir: staleSecond,
    finishedAt: '2026-01-02T00:00:00.000Z',
  });
  manager.jobs.set('active', {
    id: 'active',
    status: 'running',
    jobDir: nonArtifact,
    finishedAt: '',
  });
  manager.terminalArtifactDirs.add(stale);
  manager.terminalArtifactDirs.add(staleSecond);

  manager.trimTerminalJobHistory();
  assert.equal(manager.jobs.has('first'), false, 'terminal status history remains bounded');
  assert.equal(manager.jobs.has('second'), true);
  assert.equal(manager.jobs.has('active'), true);
  assert.deepEqual(await manager.releaseTerminalArtifacts(), [stale, staleSecond]);
  assert.deepEqual(released, [stale, staleSecond, stale, staleSecond]);
  assert.deepEqual(await manager.releaseTerminalArtifacts(), []);
});

test('Electron main uses OS Trash for real converter sessions but not temporary smoke profiles', async () => {
  const mainSource = await fs.readFile(new URL('../electron/main/index.js', import.meta.url), 'utf8');
  assert.match(mainSource, /new ConverterJobManager\(\{\s*userDataPath: \(\) => app\.getPath\('userData'\),[\s\S]*?releaseJobDir: IS_SMOKE \? async \(\) => false : jobDir => shell\.trashItem\(jobDir\),/s);
  assert.match(mainSource, /app\.whenReady\(\)\.then\(async \(\) => \{\s*recentDocuments = await readRecentDocuments\(app\);\s*\/\/ Converted data is session-scoped\.[\s\S]*?await converterJobs\.releaseStaleArtifacts\(\);/);
  assert.match(mainSource, /app\.on\('before-quit', \(event\) => \{\s*if \(converterArtifactsReleasedForQuit\) return;\s*event\.preventDefault\(\);\s*if \(releasingConverterArtifactsBeforeQuit\) return;\s*releasingConverterArtifactsBeforeQuit = true;\s*void converterJobs\.shutdown\(\)\s*\.then\(\(\) => converterJobs\.releaseTerminalArtifacts\(\)\)[\s\S]*?converterArtifactsReleasedForQuit = true;\s*app\.quit\(\);/s);
});

test('desktop native file reads cannot raise the main-process hard cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-native-read-cap-'));
  const filePath = path.join(root, 'sparse-volume.bin');
  await fs.writeFile(filePath, '');
  await fs.truncate(filePath, MAX_NATIVE_READ_RANGE_BYTES + 1);

  await assert.rejects(
    readNativeFileRange(filePath, {
      start: 0,
      end: MAX_NATIVE_READ_RANGE_BYTES + 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    }),
    /too large/i,
  );
});

test('desktop local API proxy disk-spools bounded bodies without weakening microscopy uploads', async () => {
  assert.equal(MAX_DESKTOP_LOCAL_API_BODY_BYTES, 256 * 1024 * 1024);
  let fetchCalls = 0;
  const response = await handleDesktopLocalApiRequest(
    new Request('voxellab://app/api/microscopy/convert?name=cells.czi', {
      method: 'POST',
      body: '12345',
    }),
    {
      fetch: async (_url, init) => {
        fetchCalls += 1;
        assert.equal(init.body instanceof Blob, true);
        return Response.json({ ok: true });
      },
    },
    'http://127.0.0.1:9123',
    { maxBodyBytes: 4 },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request body is too large' });

  const forwarded = await handleDesktopLocalApiRequest(
    new Request('voxellab://app/api/microscopy/convert?name=cells.czi', {
      method: 'POST',
      body: '1234',
    }),
    {
      fetch: async (_url, init) => {
        fetchCalls += 1;
        assert.equal(init.body instanceof Blob, true);
        assert.equal(await init.body.text(), '1234');
        return Response.json({ ok: true });
      },
    },
    'http://127.0.0.1:9123',
    { maxBodyBytes: 4 },
  );
  assert.equal(fetchCalls, 1);
  assert.equal(forwarded.status, 200);

  const declared = await handleDesktopLocalApiRequest(
    new Request('voxellab://app/api/microscopy/convert?name=cells.czi', {
      method: 'POST',
      headers: { 'Content-Length': '5' },
      body: '12345',
    }),
    { fetch: async () => assert.fail('declared oversized body must be rejected before fetch') },
    'http://127.0.0.1:9123',
    { maxBodyBytes: 4 },
  );
  assert.equal(declared.status, 413);

  const hardCap = await handleDesktopLocalApiRequest(
    new Request('voxellab://app/api/microscopy/convert?name=cells.czi', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_DESKTOP_LOCAL_API_BODY_BYTES + 1) },
      body: 'x',
    }),
    { fetch: async () => assert.fail('the local API body hard cap cannot be raised') },
    'http://127.0.0.1:9123',
    { maxBodyBytes: Number.MAX_SAFE_INTEGER },
  );
  assert.equal(hardCap.status, 413);
});

test('desktop cloud settings preserve the prior file when atomic replacement fails', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-settings-atomic-'));
  const settingsFile = path.join(userData, 'cloud-settings.json');
  await saveCloudSettings(userData, {
    modalWebhookBase: 'https://original--pipeline.modal.run',
    modalAuthToken: 'original-secret',
    r2PublicUrl: 'https://original.example',
  });
  const before = await fs.readFile(settingsFile, 'utf8');
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'rename') return async () => { throw new Error('simulated rename failure'); };
      return target[property];
    },
  });

  await assert.rejects(
    saveCloudSettings(userData, {
      modalWebhookBase: 'https://replacement--pipeline.modal.run',
      modalAuthToken: 'replacement-secret',
      r2PublicUrl: 'https://replacement.example',
    }, { fsApi: failingFs }),
    /simulated rename failure/,
  );

  assert.equal(await fs.readFile(settingsFile, 'utf8'), before);
  assert.equal((await fs.readdir(userData)).some(name => name.endsWith('.tmp')), false);
});

test('desktop cloud settings fsync the parent after atomic rename', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-settings-fsync-'));
  const operations = [];
  const trackingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'rename') return async (...args) => {
        operations.push('rename');
        return target.rename(...args);
      };
      if (property === 'open') return async (targetPath, ...args) => {
        const handle = await target.open(targetPath, ...args);
        if (targetPath !== userData) return handle;
        operations.push('directory-open');
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === 'sync') return async () => {
              operations.push('directory-sync');
              return handleTarget.sync();
            };
            if (handleProperty === 'close') return async () => {
              operations.push('directory-close');
              return handleTarget.close();
            };
            return handleTarget[handleProperty];
          },
        });
      };
      return target[property];
    },
  });

  await saveCloudSettings(userData, { modalWebhookBase: 'https://example.modal.run' }, { fsApi: trackingFs });

  assert.deepEqual(operations, ['rename', 'directory-open', 'directory-sync', 'directory-close']);
});

test('desktop cloud settings fsync the parent after clearing the file', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-cloud-settings-clear-fsync-'));
  await saveCloudSettings(userData, { modalWebhookBase: 'https://example.modal.run' });
  const operations = [];
  const trackingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'rm') return async (...args) => {
        operations.push('rm');
        return target.rm(...args);
      };
      if (property === 'open') return async (targetPath, ...args) => {
        const handle = await target.open(targetPath, ...args);
        if (targetPath !== userData) return handle;
        operations.push('directory-open');
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty === 'sync') return async () => {
              operations.push('directory-sync');
              return handleTarget.sync();
            };
            if (handleProperty === 'close') return async () => {
              operations.push('directory-close');
              return handleTarget.close();
            };
            return handleTarget[handleProperty];
          },
        });
      };
      return target[property];
    },
  });

  await clearCloudSettings(userData, { fsApi: trackingFs });

  assert.deepEqual(operations, ['rm', 'directory-open', 'directory-sync', 'directory-close']);
});
