import { expect } from '@playwright/test';
import { tinyNiftiBuffer } from './fixtures/nifti.mjs';

export function tinyNiftiByteArray(options = {}) {
  return Array.from(tinyNiftiBuffer(options));
}

export async function installDesktopBridgeStub(page, {
  fileBytes = null,
  gateReads = false,
  openFilesError = '',
} = {}) {
  await page.addInitScript(({ bytes, gate, openFilesFailure }) => {
    const source = new Uint8Array(bytes).buffer;
    let releaseRead = null;
    const readGate = gate ? new Promise((resolve) => { releaseRead = resolve; }) : null;
    window.__releaseDesktopRead = releaseRead;
    window.voxellabDesktop = {
      onMenuCommand() {},
      onOpenPaths(handler) { window.__dispatchDesktopOpen = handler; },
      async rendererReady() {},
      async getCloudSettings() { return {}; },
      async saveCloudSettings() {},
      async openFolder() {},
      async openFiles() {
        window.__desktopOpenFilesCalls = (window.__desktopOpenFilesCalls || 0) + 1;
        if (openFilesFailure) throw new Error(openFilesFailure);
      },
      async getConverterCapabilities() { return { tools: [] }; },
      async readFileRange(_path, { start = 0, end = source.byteLength } = {}) {
        window.__desktopReadStarted = true;
        if (readGate) await readGate;
        window.__desktopReadFinished = true;
        return { bytes: source.slice(start, end) };
      },
    };
  }, { bytes: fileBytes || tinyNiftiByteArray(), gate: gateReads, openFilesFailure: openFilesError });
}

export async function waitForDesktopBridge(page) {
  await page.waitForFunction(() => window.__dispatchDesktopOpen instanceof Function);
}

export async function dispatchDesktopOpen(page, { supported = [], unsupported = [], convertible = [] }) {
  await page.evaluate((payload) => {
    void window.__dispatchDesktopOpen(payload);
  }, { supported, unsupported, convertible });
}

export function desktopFile(name, size = 360) {
  return { kind: 'file', name, path: `/tmp/${name}`, size };
}

export async function expectDesktopReadStarted(page) {
  await expect.poll(() => page.evaluate(() => window.__desktopReadStarted)).toBe(true);
}

export async function desktopOpenFilesCalls(page) {
  return page.evaluate(() => window.__desktopOpenFilesCalls || 0);
}

export async function releaseDesktopRead(page) {
  await page.evaluate(() => window.__releaseDesktopRead());
  await expect.poll(() => page.evaluate(() => window.__desktopReadFinished)).toBe(true);
}
