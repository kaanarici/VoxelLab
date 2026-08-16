/* global console, document, process, setTimeout, window */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const PRODUCT_NAME = 'VoxelLab';

async function pathExists(pathname) {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function findPackagedMacApp(inputPath) {
  const resolved = path.resolve(inputPath || 'out/forge');
  if (resolved.endsWith('.app')) return resolved;
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appPath = path.join(resolved, entry.name, `${PRODUCT_NAME}.app`);
    if (await pathExists(appPath)) return appPath;
  }
  throw new Error(`Could not find ${PRODUCT_NAME}.app under ${resolved}`);
}

async function findPackagedWindowsExecutable(inputPath) {
  const resolved = path.resolve(inputPath || 'out/forge');
  if (resolved.toLowerCase().endsWith('.exe')) return resolved;
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const executablePath = path.join(resolved, entry.name, `${PRODUCT_NAME}.exe`);
    if (await pathExists(executablePath)) return executablePath;
  }
  throw new Error(`Could not find ${PRODUCT_NAME}.exe under ${resolved}`);
}

async function closePackagedApp(app) {
  const child = app.process();
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('packaged app close timed out')), 5_000);
      }),
    ]);
    return 'graceful';
  } catch {
    if (child && !child.killed) child.kill();
    return 'killed';
  }
}

export async function checkPackagedMacAppLaunch(inputPath = 'out/forge') {
  assert.equal(process.platform, 'darwin', 'packaged macOS app launch check must run on macOS');
  const appPath = await findPackagedMacApp(inputPath);
  const executablePath = path.join(appPath, 'Contents/MacOS', PRODUCT_NAME);
  await fs.access(executablePath, constants.X_OK);

  const app = await electron.launch({
    executablePath,
    env: { ...process.env, VOXELLAB_ELECTRON_SMOKE: '1' },
  });
  const pageErrors = [];
  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => (
      document.readyState !== 'loading'
      && globalThis.voxellabDesktop?.getAppInfo instanceof Function
      && document.getElementById('canvas-wrap')
    ), null, { timeout: 20_000 });
    const result = await page.evaluate(async () => ({
      href: window.location.href,
      title: document.title,
      requireExposed: 'require' in globalThis,
      processExposed: 'process' in globalThis,
      appInfo: await globalThis.voxellabDesktop.getAppInfo(),
    }));
    assert.equal(result.href, 'voxellab://app/index.html');
    assert.match(result.title, /^VoxelLab(?:$|: )/);
    assert.equal(result.requireExposed, false);
    assert.equal(result.processExposed, false);
    assert.equal(result.appInfo.name, PRODUCT_NAME);
    assert.equal(result.appInfo.platform, 'darwin');
    assert.deepEqual(pageErrors, []);
    const closeMode = await closePackagedApp(app);
    return { appPath, executablePath, appInfo: result.appInfo, closeMode };
  } catch (error) {
    const child = app.process();
    if (child && !child.killed) child.kill('SIGKILL');
    throw error;
  }
}

export async function checkPackagedWindowsAppLaunch(inputPath = 'out/forge') {
  assert.equal(process.platform, 'win32', 'packaged Windows app launch check must run on Windows');
  const executablePath = await findPackagedWindowsExecutable(inputPath);
  await fs.access(executablePath, constants.X_OK);

  const app = await electron.launch({
    executablePath,
    env: { ...process.env, VOXELLAB_ELECTRON_SMOKE: '1' },
  });
  const pageErrors = [];
  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => (
      document.readyState !== 'loading'
      && globalThis.voxellabDesktop?.getAppInfo instanceof Function
      && document.getElementById('canvas-wrap')
    ), null, { timeout: 20_000 });
    const result = await page.evaluate(async () => ({
      href: window.location.href,
      title: document.title,
      requireExposed: 'require' in globalThis,
      processExposed: 'process' in globalThis,
      appInfo: await globalThis.voxellabDesktop.getAppInfo(),
    }));
    assert.equal(result.href, 'voxellab://app/index.html');
    assert.match(result.title, /^VoxelLab(?:$|: )/);
    assert.equal(result.requireExposed, false);
    assert.equal(result.processExposed, false);
    assert.equal(result.appInfo.name, PRODUCT_NAME);
    assert.equal(result.appInfo.platform, 'win32');
    assert.equal(result.appInfo.arch, 'x64');
    assert.deepEqual(pageErrors, []);
    const closeMode = await closePackagedApp(app);
    return { executablePath, appInfo: result.appInfo, closeMode };
  } catch (error) {
    const child = app.process();
    if (child && !child.killed) child.kill();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.platform === 'win32'
    ? await checkPackagedWindowsAppLaunch(process.argv[2] || 'out/forge')
    : await checkPackagedMacAppLaunch(process.argv[2] || 'out/forge');
  console.log(`OK: packaged ${result.appInfo.platform} VoxelLab app launches (${result.appInfo.arch}, close=${result.closeMode})`);
}
