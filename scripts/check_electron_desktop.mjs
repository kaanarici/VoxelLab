/* global URL */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
  DESKTOP_OPEN_FILE_FILTER_EXTENSIONS,
  DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS,
} from '../electron/shared/desktop-contracts.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mainSource = readFileSync(new URL('../electron/main/index.js', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload/index.cjs', import.meta.url), 'utf8');
const windowsAssociationsSource = readFileSync(new URL('../electron/main/windows-file-associations.js', import.meta.url), 'utf8');

assert.equal(packageJson.main, 'electron/main/index.js');
assert.ok(packageJson.devDependencies?.electron, 'Electron must be a pinned dev dependency through package-lock');
assert.equal(packageJson.scripts?.['desktop:start'], 'electron .');
assert.equal(packageJson.scripts?.['desktop:ensure-electron'], 'node scripts/ensure_electron_runtime.mjs');
assert.equal(packageJson.scripts?.['desktop:smoke'], 'npm run desktop:ensure-electron && node --test --test-concurrency=1 tests/electron-runtime-smoke.mjs tests/electron-nifti-smoke.mjs tests/electron-tiff-sequence-smoke.mjs tests/electron-microscopy-workflow-smoke.mjs');
assert.equal(packageJson.scripts?.['desktop:check'], 'node scripts/check_electron_desktop.mjs && node scripts/check_electron_package.mjs && node scripts/check_release_workflow.mjs && node --test tests/electron-desktop-contract.test.mjs && npm run desktop:smoke');

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
  'https://github.com/kaanarici/VoxelLab',
  'handleWindowsSquirrelEvent',
]) {
  assert.ok(mainSource.includes(required), `Electron main process is missing: ${required}`);
}
assert.equal(mainSource.includes('https://github.com/kaanaricio/VoxelLab'), false, 'Electron Help menu must use the canonical public repo URL');
assert.ok(
  mainSource.includes('DESKTOP_OPEN_FILE_FILTER_EXTENSIONS')
    && ['czi', 'nd2', 'lif', 'oib', 'oif', 'lsm'].every(extension => DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes(extension))
    && !DESKTOP_OPEN_FILE_FILTER_EXTENSIONS.includes('csv'),
  'Open Files dialog must show configured convertible microscopy files in the primary VoxelLab filter',
);
assert.ok(
  mainSource.includes('DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS')
    && ['json', 'roi', 'sr', 'zip'].every(extension => DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS.includes(extension)),
  'Open Files dialog must show configured sidecar files in the VoxelLab sidecar filter',
);
assert.equal(mainSource.includes("script-src 'self' https://cdn.jsdelivr.net"), false, 'Electron must not expose native IPC to CDN script execution');
assert.ok(
  mainSource.includes("const SMOKE_KEEP_HIDDEN = process.env.VOXELLAB_ELECTRON_SMOKE === '1'")
    && mainSource.includes("process.env.VOXELLAB_ELECTRON_NATIVE_FULLSCREEN_SMOKE !== '1'")
    && mainSource.includes('if (SMOKE_KEEP_HIDDEN) return;')
    && mainSource.includes('if (SMOKE_KEEP_HIDDEN) return window;'),
  'Electron smoke runs must keep windows hidden and avoid focusing unless fullscreen smoke opts in',
);
assert.ok(
  mainSource.includes("if (SMOKE_NON_ACTIVATING && typeof window.showInactive === 'function') window.showInactive();"),
  'Electron fullscreen smoke should use non-activating show when available',
);

for (const required of [
  '--squirrel-install',
  '--squirrel-uninstall',
  'HKCU\\\\Software\\\\Classes',
  '.dcm',
  'DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS',
]) {
  assert.ok(windowsAssociationsSource.includes(required), `Windows file associations are missing: ${required}`);
}
assert.deepEqual(DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS, ['.czi', '.nd2', '.lif', '.oib', '.oif', '.lsm']);
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
