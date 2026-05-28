const { contextBridge, ipcRenderer } = require('electron');

const IPC = Object.freeze({
  appInfo: 'desktop:app-info',
  openFiles: 'desktop:open-files',
  openFolder: 'desktop:open-folder',
  getRecentDocuments: 'desktop:get-recent-documents',
  openRecentPath: 'desktop:open-recent-path',
  clearRecentDocuments: 'desktop:clear-recent-documents',
  recentDocumentsChanged: 'desktop:recent-documents-changed',
  readFileRange: 'desktop:read-file-range',
  getConverterCapabilities: 'desktop:get-converter-capabilities',
  startConversionJob: 'desktop:start-conversion-job',
  getConversionJob: 'desktop:get-conversion-job',
  cancelConversionJob: 'desktop:cancel-conversion-job',
  conversionJobChanged: 'desktop:conversion-job-changed',
  revealPath: 'desktop:reveal-path',
  windowState: 'desktop:window-state',
  windowStateChanged: 'desktop:window-state-changed',
  rendererReady: 'desktop:renderer-ready',
  menuCommand: 'desktop:menu-command',
  openPaths: 'desktop:open-paths',
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('voxellabDesktop', {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getWindowState: () => ipcRenderer.invoke(IPC.windowState),
  openFiles: () => ipcRenderer.invoke(IPC.openFiles),
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  getRecentDocuments: () => ipcRenderer.invoke(IPC.getRecentDocuments),
  openRecentPath: (filePath) => ipcRenderer.invoke(IPC.openRecentPath, String(filePath || '')),
  clearRecentDocuments: () => ipcRenderer.invoke(IPC.clearRecentDocuments),
  readFileRange: (filePath, range = {}) => ipcRenderer.invoke(IPC.readFileRange, String(filePath || ''), {
    start: Number(range.start || 0),
    end: Number.isFinite(Number(range.end)) ? Number(range.end) : undefined,
  }),
  getConverterCapabilities: () => ipcRenderer.invoke(IPC.getConverterCapabilities),
  startConversionJob: (payload = {}) => ipcRenderer.invoke(IPC.startConversionJob, {
    tool: String(payload.tool || ''),
    inputPaths: Array.isArray(payload.inputPaths) ? payload.inputPaths.map(String) : [],
    outputKind: String(payload.outputKind || 'ome-zarr'),
  }),
  getConversionJob: (id) => ipcRenderer.invoke(IPC.getConversionJob, String(id || '')),
  cancelConversionJob: (id) => ipcRenderer.invoke(IPC.cancelConversionJob, String(id || '')),
  revealPath: (filePath) => ipcRenderer.invoke(IPC.revealPath, String(filePath || '')),
  rendererReady: () => ipcRenderer.invoke(IPC.rendererReady),
  onOpenPaths: (callback) => subscribe(IPC.openPaths, callback),
  onMenuCommand: (callback) => subscribe(IPC.menuCommand, callback),
  onRecentDocumentsChanged: (callback) => subscribe(IPC.recentDocumentsChanged, callback),
  onConversionJobChanged: (callback) => subscribe(IPC.conversionJobChanged, callback),
  onWindowStateChanged: (callback) => subscribe(IPC.windowStateChanged, callback),
});
