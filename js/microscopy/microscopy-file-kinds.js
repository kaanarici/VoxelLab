export function microscopyFilePath(file = {}) {
  return String(file.webkitRelativePath || file.path || file.name || '').replaceAll('\\', '/');
}

export function isOmeZarrFile(file = {}) {
  const path = microscopyFilePath(file);
  return /\.zarr(\/|$)/i.test(path) || /(^|\/)(\.zattrs|\.zarray|\.zgroup|\.zmetadata|zarr\.json)$/i.test(path);
}

export function isImageJRoiFile(file = {}) {
  return /\.roi$/i.test(file?.name || '');
}

export function isImageJRoiZipFile(file = {}) {
  return /\.zip$/i.test(file?.name || '');
}
