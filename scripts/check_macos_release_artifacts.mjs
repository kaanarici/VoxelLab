/* global console, process */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPackagedMacAppLaunch } from './check_packaged_electron_app.mjs';

const APP_NAME = 'VoxelLab.app';

async function walkFiles(rootDir) {
  const results = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const pathname = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(pathname);
      else if (entry.isFile()) results.push(pathname);
    }
  }
  await visit(rootDir);
  return results;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status === 0) return result;
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
}

async function findArtifact(rootDir, pattern, label) {
  const matches = (await walkFiles(rootDir)).filter(file => pattern.test(file));
  assert.equal(matches.length, 1, `expected exactly one ${label} artifact under ${rootDir}`);
  return matches[0];
}

async function checkZip(zipPath, tempRoot) {
  const extractDir = path.join(tempRoot, 'zip');
  await fs.mkdir(extractDir, { recursive: true });
  run('ditto', ['-x', '-k', zipPath, extractDir]);
  const appPath = path.join(extractDir, APP_NAME);
  await fs.access(appPath);
  const result = await checkPackagedMacAppLaunch(appPath);
  return { artifact: zipPath, appPath, closeMode: result.closeMode };
}

async function checkDmg(dmgPath, tempRoot) {
  const mountPoint = path.join(tempRoot, 'dmg');
  await fs.mkdir(mountPoint, { recursive: true });
  let attached = false;
  let result = null;
  let smokeError = null;
  let detachError = null;
  try {
    run('hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mountPoint, '-quiet']);
    attached = true;
    const appPath = path.join(mountPoint, APP_NAME);
    await fs.access(appPath);
    result = await checkPackagedMacAppLaunch(appPath);
  } catch (error) {
    smokeError = error;
  } finally {
    if (attached) {
      const detach = spawnSync('hdiutil', ['detach', '-force', mountPoint], { encoding: 'utf8' });
      if (detach.status !== 0) {
        const detail = [detach.stdout, detach.stderr].filter(Boolean).join('\n').trim();
        detachError = new Error(`hdiutil detach -force ${mountPoint} failed${detail ? `:\n${detail}` : ''}`);
      }
    }
  }
  if (smokeError) throw smokeError;
  if (detachError) throw detachError;
  return { artifact: dmgPath, appPath: path.join(mountPoint, APP_NAME), closeMode: result.closeMode };
}

export async function checkMacosReleaseArtifacts(rootDir = 'out/forge/make') {
  assert.equal(process.platform, 'darwin', 'macOS release artifact install smoke must run on macOS');
  const resolved = path.resolve(rootDir);
  const dmgPath = await findArtifact(resolved, /\/VoxelLab\.dmg$/, 'macOS DMG');
  const zipPath = await findArtifact(resolved, /\/VoxelLab-darwin-[^/]+-\d+\.\d+\.\d+\.zip$/, 'macOS ZIP');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-release-artifacts-'));
  try {
    const zip = await checkZip(zipPath, tempRoot);
    const dmg = await checkDmg(dmgPath, tempRoot);
    return { dmg, zip };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkMacosReleaseArtifacts(process.argv[2] || 'out/forge/make');
  console.log(`OK: macOS release artifacts extract, mount, and launch (${path.basename(result.zip.artifact)}, ${path.basename(result.dmg.artifact)})`);
}
