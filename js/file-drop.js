function setRelativePath(file, relativePath) {
  const path = String(relativePath || '');
  if (!path || file.webkitRelativePath) return file;
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
  } catch {
    try { file.path = path; } catch {}
  }
  return file;
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectory(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function filesForEntry(entry, prefix = '') {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) return [setRelativePath(await entryFile(entry), path)];
  if (!entry.isDirectory) return [];
  const children = await readDirectory(entry.createReader());
  const nested = await Promise.all(children.map(child => filesForEntry(child, `${path}/`)));
  return nested.flat();
}

export async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(dataTransfer?.files || []);
  const nested = await Promise.all(entries.map(entry => filesForEntry(entry)));
  return nested.flat();
}
