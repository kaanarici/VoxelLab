import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS } from '../shared/desktop-contracts.js';

const FILE_ASSOCIATIONS = Object.freeze([
  { extension: '.dcm', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.dicom', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.ima', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.nii', progId: 'VoxelLab.nifti', description: 'NIfTI volume' },
  { extension: '.tif', progId: 'VoxelLab.tiff', description: 'Microscopy TIFF image' },
  { extension: '.tiff', progId: 'VoxelLab.tiff', description: 'Microscopy TIFF image' },
  { extension: '.roi', progId: 'VoxelLab.imagejRoi', description: 'ImageJ ROI sidecar' },
  { extension: '.sr', progId: 'VoxelLab.dicomSr', description: 'DICOM Structured Report' },
  ...DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS.map(extension => ({
    extension,
    progId: 'VoxelLab.convertibleMicroscopy',
    description: 'Convertible microscopy image',
  })),
]);

function regAdd(pathName, data) {
  return ['reg.exe', ['add', pathName, '/ve', '/d', data, '/f']];
}

function regAddOpenWithProgId(extension, progId) {
  return ['reg.exe', [
    'add',
    `HKCU\\Software\\Classes\\${extension}\\OpenWithProgids`,
    '/v',
    progId,
    '/t',
    'REG_NONE',
    '/f',
  ]];
}

function regDelete(pathName) {
  return ['reg.exe', ['delete', pathName, '/f']];
}

function regDeleteValue(pathName, valueName) {
  return ['reg.exe', ['delete', pathName, '/v', valueName, '/f']];
}

function removeOwnedLegacyDefaults(spawnImpl, spawnSyncImpl) {
  for (const association of FILE_ASSOCIATIONS) {
    const extensionKey = `HKCU\\Software\\Classes\\${association.extension}`;
    const result = spawnSyncImpl('reg.exe', ['query', extensionKey, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result?.error) throw result.error;
    const currentProgId = String(result?.stdout || '').match(/\sREG_SZ\s+(\S+)\s*$/im)?.[1] || '';
    if (result?.status !== 0 || currentProgId !== association.progId) continue;
    spawnQuiet(spawnImpl, 'reg.exe', ['delete', extensionKey, '/ve', '/f']);
  }
}

export function windowsFileAssociationCommands(exePath) {
  const command = `"${exePath}" "%1"`;
  const commands = [];
  for (const association of FILE_ASSOCIATIONS) {
    commands.push(regAddOpenWithProgId(association.extension, association.progId));
  }
  const progIds = new Map(FILE_ASSOCIATIONS.map(item => [item.progId, item.description]));
  for (const [progId, description] of progIds) {
    commands.push(regAdd(`HKCU\\Software\\Classes\\${progId}`, description));
    commands.push(regAdd(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, command));
  }
  return commands;
}

export function windowsFileAssociationCleanupCommands() {
  const commands = [];
  for (const association of FILE_ASSOCIATIONS) {
    commands.push(regDeleteValue(
      `HKCU\\Software\\Classes\\${association.extension}\\OpenWithProgids`,
      association.progId,
    ));
  }
  for (const progId of [...new Set(FILE_ASSOCIATIONS.map(item => item.progId))]) {
    commands.push(regDelete(`HKCU\\Software\\Classes\\${progId}`));
  }
  return commands;
}

function spawnQuiet(spawnImpl, command, args) {
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child?.unref?.();
}

export function handleWindowsSquirrelEvent(
  argv,
  exePath,
  spawnImpl,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
) {
  if (platform !== 'win32') return false;
  const event = argv[1];
  if (!event?.startsWith('--squirrel-')) return false;
  const updateExe = path.resolve(path.dirname(exePath), '..', 'Update.exe');
  const shortcutArgs = ['--createShortcut', path.basename(exePath)];

  if (event === '--squirrel-install' || event === '--squirrel-updated') {
    removeOwnedLegacyDefaults(spawnImpl, spawnSyncImpl);
    for (const [command, args] of windowsFileAssociationCommands(exePath)) spawnQuiet(spawnImpl, command, args);
    spawnQuiet(spawnImpl, updateExe, shortcutArgs);
    return true;
  }
  if (event === '--squirrel-uninstall') {
    removeOwnedLegacyDefaults(spawnImpl, spawnSyncImpl);
    for (const [command, args] of windowsFileAssociationCleanupCommands()) spawnQuiet(spawnImpl, command, args);
    spawnQuiet(spawnImpl, updateExe, ['--removeShortcut', path.basename(exePath)]);
    return true;
  }
  return event === '--squirrel-obsolete';
}
