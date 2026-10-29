import { readFile } from 'node:fs/promises';

export const UPLOAD_ZONE = '#upload-zone';

export function tiffFile(path) {
  return { path, mimeType: 'image/tiff' };
}

export function zipFile(path) {
  return { path, mimeType: 'application/zip' };
}

export function jsonFile(path) {
  return { path, mimeType: 'application/json' };
}

export function binaryFile(path) {
  return { path, mimeType: 'application/octet-stream' };
}

export function dicomFile(path) {
  return { path, mimeType: 'application/dicom' };
}

async function transferPayload(files) {
  return Promise.all(files.map(async (file) => {
    const { path, mimeType = 'application/octet-stream', relativePath = '', bytes } = file;
    return {
      bytes: bytes || Array.from(await readFile(path)),
      name: (path || '').split('/').pop(),
      mimeType,
      relativePath,
    };
  }));
}

async function dispatchDrop(page, selector, dataTransfer) {
  await page.locator(selector).evaluate((target, transfer) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, dataTransfer);
}

export async function dropFiles(page, selector, files) {
  const payload = await transferPayload(files);
  const dataTransfer = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const file = new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType });
      if (item.relativePath) Object.defineProperty(file, 'webkitRelativePath', { value: item.relativePath });
      transfer.items.add(file);
    }
    return transfer;
  }, payload);
  await dispatchDrop(page, selector, dataTransfer);
}

export async function dropFile(page, selector, path, mimeType = 'application/octet-stream') {
  await dropFiles(page, selector, [{ path, mimeType }]);
}

export async function dropDirectory(page, selector, rootName, files) {
  const payload = await transferPayload(files);
  const dataTransfer = await page.evaluateHandle(({ rootName: directoryName, items }) => {
    const directory = (name) => ({
      name,
      isFile: false,
      isDirectory: true,
      children: [],
      createReader() {
        const children = this.children;
        let sent = false;
        return {
          readEntries(resolve) {
            const batch = sent ? [] : children;
            sent = true;
            resolve(batch);
          },
        };
      },
    });
    const fileEntry = (item) => ({
      name: item.name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
      },
    });
    const root = directory(directoryName);
    for (const item of items) {
      const parts = item.relativePath.split('/').filter(Boolean);
      let cursor = root;
      for (const part of parts.slice(0, -1)) {
        let child = cursor.children.find(entry => entry.isDirectory && entry.name === part);
        if (!child) {
          child = directory(part);
          cursor.children.push(child);
        }
        cursor = child;
      }
      cursor.children.push(fileEntry({ ...item, name: parts.at(-1) || item.name }));
    }
    return { files: [], items: [{ webkitGetAsEntry: () => root }] };
  }, { rootName, items: payload });
  await dispatchDrop(page, selector, dataTransfer);
}
