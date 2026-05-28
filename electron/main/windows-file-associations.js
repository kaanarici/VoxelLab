import path from 'node:path';

const FILE_ASSOCIATIONS = Object.freeze([
  { extension: '.dcm', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.dicom', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.ima', progId: 'VoxelLab.dicom', description: 'DICOM image' },
  { extension: '.nii', progId: 'VoxelLab.nifti', description: 'NIfTI volume' },
  { extension: '.tif', progId: 'VoxelLab.tiff', description: 'Microscopy TIFF image' },
  { extension: '.tiff', progId: 'VoxelLab.tiff', description: 'Microscopy TIFF image' },
  { extension: '.czi', progId: 'VoxelLab.convertibleMicroscopy', description: 'Convertible microscopy image' },
  { extension: '.nd2', progId: 'VoxelLab.convertibleMicroscopy', description: 'Convertible microscopy image' },
  { extension: '.lif', progId: 'VoxelLab.convertibleMicroscopy', description: 'Convertible microscopy image' },
]);

function regAdd(pathName, data) {
  return ['reg.exe', ['add', pathName, '/ve', '/d', data, '/f']];
}

function regDelete(pathName) {
  return ['reg.exe', ['delete', pathName, '/f']];
}

export function windowsFileAssociationCommands(exePath) {
  const command = `"${exePath}" "%1"`;
  const commands = [];
  for (const association of FILE_ASSOCIATIONS) {
    commands.push(regAdd(`HKCU\\Software\\Classes\\${association.extension}`, association.progId));
  }
  for (const association of FILE_ASSOCIATIONS) {
    commands.push(regAdd(`HKCU\\Software\\Classes\\${association.progId}`, association.description));
    commands.push(regAdd(`HKCU\\Software\\Classes\\${association.progId}\\shell\\open\\command`, command));
  }
  return commands;
}

export function windowsFileAssociationCleanupCommands() {
  const commands = [];
  for (const association of FILE_ASSOCIATIONS) {
    commands.push(regDelete(`HKCU\\Software\\Classes\\${association.extension}`));
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

export function handleWindowsSquirrelEvent(argv, exePath, spawnImpl, platform = process.platform) {
  if (platform !== 'win32') return false;
  const event = argv[1];
  if (!event?.startsWith('--squirrel-')) return false;
  const updateExe = path.resolve(path.dirname(exePath), '..', 'Update.exe');
  const shortcutArgs = ['--createShortcut', path.basename(exePath)];

  if (event === '--squirrel-install' || event === '--squirrel-updated') {
    for (const [command, args] of windowsFileAssociationCommands(exePath)) spawnQuiet(spawnImpl, command, args);
    spawnQuiet(spawnImpl, updateExe, shortcutArgs);
    return true;
  }
  if (event === '--squirrel-uninstall') {
    for (const [command, args] of windowsFileAssociationCleanupCommands()) spawnQuiet(spawnImpl, command, args);
    spawnQuiet(spawnImpl, updateExe, ['--removeShortcut', path.basename(exePath)]);
    return true;
  }
  return event === '--squirrel-obsolete';
}
