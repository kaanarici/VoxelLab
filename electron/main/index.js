import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, session } from 'electron';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConverterJobManager } from './converter-jobs.js';
import { openTrustedExternalUrl } from './external-urls.js';
import { launchPathsFromArgv } from './launch-paths.js';
import { collectSupportedFolderFiles, nativePathItem, nativePathItems, openFolderPayload, readNativeFileRange } from './native-paths.js';
import {
  clearRecentDocuments,
  readRecentDocuments,
  rememberRecentDocuments,
  removeRecentDocuments,
} from './recent-documents.js';
import { registerStaticProtocol } from './static-protocol.js';
import { handleWindowsSquirrelEvent } from './windows-file-associations.js';
import { restoredWindowOptions, trackWindowState } from './window-state.js';
import {
  APP_HOST,
  APP_SCHEME,
  APP_URL,
  DESKTOP_API_VERSION,
  DESKTOP_OPEN_FILE_FILTER_EXTENSIONS,
  DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS,
  DESKTOP_SIDECAR_INPUT_EXTENSIONS,
  IPC,
  MENU_COMMAND,
  openPathsPayload,
} from '../shared/desktop-contracts.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRELOAD_PATH = path.join(ROOT_DIR, 'electron/preload/index.cjs');
const APP_ICON_PATH = path.join(ROOT_DIR, 'electron/assets/icon.png');
// macOS Dock/About use the safe-area (padded) variant so the runtime icon matches
// the .icns footprint and is sized like other Dock apps, not edge-to-edge.
const MAC_ICON_PATH = path.join(ROOT_DIR, 'electron/assets/icon-macos.png');
const REPO_URL = 'https://github.com/kaanarici/VoxelLab';
const IS_SMOKE = process.env.VOXELLAB_ELECTRON_SMOKE === '1';
const MAC_TRAFFIC_LIGHTS = Object.freeze({ x: 14, y: 16, reservedWidth: 86 });
const SMOKE_KEEP_HIDDEN = process.env.VOXELLAB_ELECTRON_SMOKE === '1'
  && process.env.VOXELLAB_ELECTRON_NATIVE_FULLSCREEN_SMOKE !== '1';
const SMOKE_NON_ACTIVATING = process.env.VOXELLAB_ELECTRON_SMOKE === '1' && !SMOKE_KEEP_HIDDEN;
const selectedPaths = new Set();
const pendingOpenPayloads = [];
const pendingMenuCommands = [];
const readyWindows = new WeakSet();
const converterJobs = new ConverterJobManager({
  userDataPath: () => app.getPath('userData'),
});
const openedConversionOutputs = new Set();
const RECENT_SIDECAR_EXTENSIONS = new Set(DESKTOP_SIDECAR_INPUT_EXTENSIONS);
let recentDocuments = [];

if (handleWindowsSquirrelEvent(process.argv, process.execPath, spawn)) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    allowServiceWorkers: true,
    supportFetchAPI: true,
    corsEnabled: true,
    codeCache: true,
  },
}]);

function trustedSender(event) {
  const frameUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  try {
    const url = new URL(frameUrl);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

function requireTrustedSender(event) {
  if (!trustedSender(event)) throw new Error('Rejected Electron IPC from an untrusted frame');
}

function rememberPayload(payload, { recentPaths = null } = {}) {
  for (const record of [...payload.supported, ...(payload.convertible || [])]) {
    selectedPaths.add(record.path);
  }
  const recent = Array.isArray(recentPaths)
    ? recentPaths
    : [...payload.supported, ...(payload.convertible || [])]
      .filter(record => record.kind !== 'file' || !RECENT_SIDECAR_EXTENSIONS.has(path.extname(record.path).toLowerCase()))
      .map(record => record.path);
  for (const itemPath of recent) {
    app.addRecentDocument(itemPath);
  }
  refreshRecentDocuments(recent).catch(showOpenError);
}

function publishOpenPaths(window, payload, opts = {}) {
  if (!payload.records.length) return;
  rememberPayload(payload, opts);
  if (window && !window.isDestroyed() && readyWindows.has(window)) window.webContents.send(IPC.openPaths, payload);
  else pendingOpenPayloads.push(payload);
}

function flushPendingOpenPaths(window) {
  readyWindows.add(window);
  for (const payload of pendingOpenPayloads.splice(0)) window.webContents.send(IPC.openPaths, payload);
  for (const payload of pendingMenuCommands.splice(0)) window.webContents.send(IPC.menuCommand, payload);
}

function targetWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

async function openNativeFiles(window) {
  const options = {
    title: 'Open Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'VoxelLab Inputs', extensions: DESKTOP_OPEN_FILE_FILTER_EXTENSIONS },
      { name: 'VoxelLab Sidecars', extensions: DESKTOP_SIDECAR_OPEN_FILE_FILTER_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return openPathsPayload([]);
  const payload = openPathsPayload(await nativePathItems(result.filePaths));
  publishOpenPaths(window, payload);
  return payload;
}

async function openNativeFolder(window) {
  const options = {
    title: 'Open Dataset Folder',
    properties: ['openDirectory', 'multiSelections'],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return openPathsPayload([]);
  const { files, warnings, summary } = await collectSupportedFolderFiles(result.filePaths);
  const payload = openFolderPayload(result.filePaths, files, warnings, summary);
  publishOpenPaths(window, payload, { recentPaths: result.filePaths });
  return payload;
}

async function publishExternalPath(filePath, opts = {}) {
  const item = await nativePathItem(filePath);
  if (item.isDirectory) {
    const { files, warnings, summary } = await collectSupportedFolderFiles([filePath]);
    publishOpenPaths(targetWindow(), openFolderPayload([filePath], files, warnings, summary), {
      recentPaths: Array.isArray(opts.recentPaths) ? opts.recentPaths : [filePath],
    });
    return;
  }
  publishOpenPaths(targetWindow(), openPathsPayload([item]), opts);
}

async function publishRecentPath(filePath) {
  const target = String(filePath || '');
  if (!recentDocuments.some(record => record.path === target)) {
    throw new Error('Recent item is no longer available to VoxelLab');
  }
  try {
    await access(target);
  } catch {
    await removeDesktopRecentDocuments([target]);
    throw new Error('Recent item is no longer available to VoxelLab');
  }
  await publishExternalPath(target);
}

function publishRecentDocumentsChanged() {
  installMenu();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && readyWindows.has(window)) {
      window.webContents.send(IPC.recentDocumentsChanged, recentDocuments);
    }
  }
}

async function refreshRecentDocuments(paths = []) {
  if (paths.length) recentDocuments = await rememberRecentDocuments(app, paths);
  else recentDocuments = await readRecentDocuments(app);
  publishRecentDocumentsChanged();
}

async function removeDesktopRecentDocuments(paths) {
  recentDocuments = await removeRecentDocuments(app, paths);
  publishRecentDocumentsChanged();
  return recentDocuments;
}

async function clearDesktopRecentDocuments() {
  app.clearRecentDocuments();
  recentDocuments = await clearRecentDocuments(app);
  publishRecentDocumentsChanged();
  return recentDocuments;
}

async function publishLaunchPaths(argv, cwd) {
  const launchPaths = launchPathsFromArgv(argv, {
    cwd,
    rootDir: ROOT_DIR,
    mainPath: path.join(ROOT_DIR, 'electron/main/index.js'),
  });
  const files = [];
  const folders = [];
  const items = await nativePathItems(launchPaths);
  for (const item of items) {
    if (item.isDirectory) folders.push(item.path);
    else files.push(item);
  }
  if (files.length) publishOpenPaths(targetWindow(), openPathsPayload(files));
  if (folders.length) {
    const { files: folderFiles, warnings, summary } = await collectSupportedFolderFiles(folders);
    publishOpenPaths(targetWindow(), openFolderPayload(folders, folderFiles, warnings, summary), { recentPaths: folders });
  }
}

function sendMenuCommand(command) {
  const window = targetWindow();
  const payload = { command };
  if (window && !window.isDestroyed() && readyWindows.has(window)) window.webContents.send(IPC.menuCommand, payload);
  else pendingMenuCommands.push(payload);
}

function maybeOpenCompletedConversion(snapshot) {
  if (
    snapshot?.status === 'completed'
    && snapshot.outputKind === 'ome-tiff'
    && snapshot.outputPath
    && !openedConversionOutputs.has(snapshot.outputPath)
  ) {
    openedConversionOutputs.add(snapshot.outputPath);
    publishExternalPath(snapshot.outputPath, { recentPaths: [] }).catch(showOpenError);
  }
}

function broadcastConversionJob(snapshot) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && readyWindows.has(window)) {
      window.webContents.send(IPC.conversionJobChanged, snapshot);
    }
  }
  maybeOpenCompletedConversion(snapshot);
}

function desktopWindowState(window = targetWindow()) {
  return {
    platform: process.platform,
    fullscreen: Boolean(window?.isFullScreen?.() || window?.isSimpleFullScreen?.()),
    trafficLightInset: process.platform === 'darwin' ? MAC_TRAFFIC_LIGHTS.reservedWidth : 0,
  };
}

function broadcastWindowState(window) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.windowStateChanged, desktopWindowState(window));
}

function installIpc() {
  ipcMain.handle(IPC.appInfo, (event) => {
    requireTrustedSender(event);
    return {
      apiVersion: DESKTOP_API_VERSION,
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      appUrl: APP_URL,
    };
  });
  ipcMain.handle(IPC.windowState, (event) => {
    requireTrustedSender(event);
    return desktopWindowState(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(IPC.openFiles, async (event) => {
    requireTrustedSender(event);
    return openNativeFiles(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(IPC.openFolder, async (event) => {
    requireTrustedSender(event);
    return openNativeFolder(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle(IPC.getRecentDocuments, (event) => {
    requireTrustedSender(event);
    return recentDocuments;
  });
  ipcMain.handle(IPC.openRecentPath, async (event, filePath) => {
    requireTrustedSender(event);
    await publishRecentPath(filePath);
    return true;
  });
  ipcMain.handle(IPC.clearRecentDocuments, async (event) => {
    requireTrustedSender(event);
    return clearDesktopRecentDocuments();
  });
  ipcMain.handle(IPC.readFileRange, async (event, filePath, range) => {
    requireTrustedSender(event);
    const target = String(filePath || '');
    if (!selectedPaths.has(target)) throw new Error('File was not selected through VoxelLab desktop open dialog');
    return readNativeFileRange(target, range && typeof range === 'object' ? range : {});
  });
  ipcMain.handle(IPC.getConverterCapabilities, (event) => {
    requireTrustedSender(event);
    return converterJobs.capabilities();
  });
  ipcMain.handle(IPC.startConversionJob, async (event, payload) => {
    requireTrustedSender(event);
    const inputPaths = Array.isArray(payload?.inputPaths) ? payload.inputPaths.map(item => String(item || '')) : [];
    for (const itemPath of inputPaths) {
      if (!selectedPaths.has(itemPath)) throw new Error('Conversion input was not selected through VoxelLab desktop open dialog');
    }
    return converterJobs.start({
      tool: String(payload?.tool || ''),
      inputPaths,
      outputKind: String(payload?.outputKind || 'ome-zarr'),
    });
  });
  ipcMain.handle(IPC.getConversionJob, (event, id) => {
    requireTrustedSender(event);
    return converterJobs.get(id);
  });
  ipcMain.handle(IPC.cancelConversionJob, async (event, id) => {
    requireTrustedSender(event);
    return converterJobs.cancel(id);
  });
  ipcMain.handle(IPC.revealPath, async (event, filePath) => {
    requireTrustedSender(event);
    const target = String(filePath || '');
    if (!selectedPaths.has(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle(IPC.rendererReady, (event) => {
    requireTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) flushPendingOpenPaths(window);
    return true;
  });
}

function installCsp() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' http: https: data: blob:",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(`${APP_SCHEME}://`)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function createWindow() {
  // Smokes keep a fixed, deterministic window; real launches restore the last
  // size/position/state so the app reopens where the researcher left it.
  const restored = IS_SMOKE ? { options: { width: 1440, height: 960 }, maximized: false, fullScreen: false } : restoredWindowOptions(app);
  const window = new BrowserWindow({
    ...restored.options,
    minWidth: 1024,
    minHeight: 720,
    title: 'VoxelLab',
    show: false,
    icon: APP_ICON_PATH,
    backgroundColor: '#090d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: MAC_TRAFFIC_LIGHTS.x, y: MAC_TRAFFIC_LIGHTS.y },
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  if (restored.fullScreen) window.setFullScreen(true);
  else if (restored.maximized) window.maximize();
  if (!IS_SMOKE) trackWindowState(window, app);
  window.once('ready-to-show', () => {
    if (SMOKE_KEEP_HIDDEN) return;
    if (SMOKE_NON_ACTIVATING && typeof window.showInactive === 'function') window.showInactive();
    else window.show();
  });
  window.on('enter-full-screen', () => broadcastWindowState(window));
  window.on('leave-full-screen', () => broadcastWindowState(window));
  window.on('resize', () => broadcastWindowState(window));
  window.on('focus', () => broadcastWindowState(window));
  window.webContents.on('did-start-loading', () => readyWindows.delete(window));
  window.webContents.on('render-process-gone', () => readyWindows.delete(window));
  window.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternalUrl(shell, url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
      openTrustedExternalUrl(shell, url);
    }
  });
  window.loadURL(APP_URL);
  return window;
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const recentSubmenu = recentDocuments.length
    ? recentDocuments.map(record => ({
      label: record.kind === 'folder' ? `${record.name} Folder` : record.name,
      sublabel: record.path,
      click: () => publishRecentPath(record.path).catch(showOpenError),
    }))
    : [{ label: 'No Recent Files', enabled: false }];
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Files...', accelerator: 'CmdOrCtrl+O', click: () => openNativeFiles(targetWindow()) },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+Shift+O', click: () => openNativeFolder(targetWindow()) },
        {
          label: 'Open Recent',
          submenu: [
            ...recentSubmenu,
            { type: 'separator' },
            { label: 'Clear Recent Items', enabled: recentDocuments.length > 0, click: () => clearDesktopRecentDocuments().catch(showOpenError) },
          ],
        },
        { role: 'recentDocuments', visible: false, submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Upload Study Panel', accelerator: 'CmdOrCtrl+U', click: () => sendMenuCommand(MENU_COMMAND.showUpload) },
        { label: 'Export Screenshot', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand(MENU_COMMAND.exportScreenshot) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
    {
      role: 'help',
      label: 'Help',
      submenu: [
        { label: 'VoxelLab Documentation', click: () => openTrustedExternalUrl(shell, REPO_URL) },
        { label: 'Report an Issue', click: () => openTrustedExternalUrl(shell, `${REPO_URL}/issues`) },
        ...(isMac ? [] : [
          { type: 'separator' },
          { label: 'About VoxelLab', click: () => app.showAboutPanel() },
        ]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showOpenError(error) {
  dialog.showErrorBox('Open failed', error.message || String(error));
}

function focusOrCreateWindow() {
  const window = targetWindow() || createWindow();
  if (SMOKE_KEEP_HIDDEN) return window;
  if (window.isMinimized()) window.restore();
  window.focus();
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    focusOrCreateWindow();
    publishLaunchPaths(argv, cwd).catch(showOpenError);
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    publishExternalPath(filePath).catch(showOpenError);
  });

  app.whenReady().then(async () => {
    recentDocuments = await readRecentDocuments(app);
    app.setAboutPanelOptions({
      applicationName: 'VoxelLab',
      applicationVersion: app.getVersion(),
      version: '',
      copyright: 'Research and educational use only — not for clinical use.\nVoxelLab contributors. MIT License.',
      credits: 'Local-first research viewer for medical volumes and microscopy stacks.',
      iconPath: MAC_ICON_PATH,
    });
    if (process.platform === 'darwin') {
      const dockIcon = nativeImage.createFromPath(MAC_ICON_PATH);
      if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
    }
    registerStaticProtocol({ protocol, net, scheme: APP_SCHEME, rootDir: ROOT_DIR });
    installCsp();
    installIpc();
    converterJobs.on('changed', broadcastConversionJob);
    installMenu();
    if (process.platform === 'darwin') {
      app.dock?.setMenu(Menu.buildFromTemplate([
        { label: 'Open Files…', click: () => openNativeFiles(focusOrCreateWindow()) },
        { label: 'Open Folder…', click: () => openNativeFolder(focusOrCreateWindow()) },
      ]));
    }
    createWindow();
    publishLaunchPaths(process.argv, process.cwd()).catch(showOpenError);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
