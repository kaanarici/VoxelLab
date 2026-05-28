import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mainSource = readFileSync(new URL('../electron/main/index.js', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload/index.cjs', import.meta.url), 'utf8');
const windowsAssociationsSource = readFileSync(new URL('../electron/main/windows-file-associations.js', import.meta.url), 'utf8');

assert.equal(packageJson.main, 'electron/main/index.js');
assert.ok(packageJson.devDependencies?.electron, 'Electron must be a pinned dev dependency through package-lock');
assert.equal(packageJson.scripts?.['desktop:start'], 'electron .');
assert.equal(packageJson.scripts?.['desktop:smoke'], 'node --test tests/electron-runtime-smoke.mjs');
assert.equal(packageJson.scripts?.['desktop:check'], 'node scripts/check_electron_desktop.mjs && node scripts/check_electron_package.mjs && node --test tests/electron-desktop-contract.test.mjs && npm run desktop:smoke');

for (const required of [
  'nodeIntegration: false',
  'contextIsolation: true',
  'sandbox: true',
  'webSecurity: true',
  'allowRunningInsecureContent: false',
  'protocol.registerSchemesAsPrivileged',
  'allowServiceWorkers: true',
  'supportFetchAPI: true',
  'registerStaticProtocol',
  'Content-Security-Policy',
  'requestSingleInstanceLock',
  "app.on('second-instance'",
  'publishLaunchPaths(process.argv',
  'IPC.rendererReady',
  'IPC.getRecentDocuments',
  'IPC.openRecentPath',
  'IPC.clearRecentDocuments',
  'IPC.windowState',
  'desktopWindowState',
  'enter-full-screen',
  'leave-full-screen',
  'recentDocumentsChanged',
  'Open Recent',
  'Clear Recent Items',
  'handleWindowsSquirrelEvent',
]) {
  assert.ok(mainSource.includes(required), `Electron main process is missing: ${required}`);
}
assert.equal(mainSource.includes("script-src 'self' https://cdn.jsdelivr.net"), false, 'Electron must not expose native IPC to CDN script execution');

for (const required of [
  '--squirrel-install',
  '--squirrel-uninstall',
  'HKCU\\\\Software\\\\Classes',
  '.dcm',
  '.czi',
]) {
  assert.ok(windowsAssociationsSource.includes(required), `Windows file associations are missing: ${required}`);
}
assert.equal(windowsAssociationsSource.includes("extension: '.gz'"), false, 'Windows open-with must not claim every .gz file');

assert.ok(preloadSource.includes("contextBridge.exposeInMainWorld('voxellabDesktop'"));
assert.ok(preloadSource.includes('rendererReady'), 'preload must expose renderer-ready acknowledgement');
assert.ok(preloadSource.includes('getRecentDocuments'), 'preload must expose app-managed recent documents');
assert.ok(preloadSource.includes('openRecentPath'), 'preload must expose guarded recent reopen');
assert.ok(preloadSource.includes('clearRecentDocuments'), 'preload must expose guarded recent clear');
assert.ok(preloadSource.includes('onRecentDocumentsChanged'), 'preload must expose recent change subscription');
assert.equal(preloadSource.includes('ipcRenderer.send'), false, 'preload must not expose one-way raw send');
assert.equal(preloadSource.includes('sendSync'), false, 'preload must not expose sync IPC');
assert.equal(preloadSource.includes('require('), true, 'preload should remain tiny CommonJS for Electron sandbox compatibility');
