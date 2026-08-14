const DESKTOP_BLOB_STREAM_CHUNK_BYTES = 1024 * 1024;

function normalizeSlicePoint(value, fallback, size) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  const relative = integer < 0 ? size + integer : integer;
  return Math.max(0, Math.min(size, relative));
}

class DesktopPathBlob {
  constructor(file, start, end, type = '') {
    this._file = file;
    this._start = start;
    this._end = end;
    this.size = Math.max(0, end - start);
    this.type = String(type || '').toLowerCase();
  }

  async arrayBuffer() {
    if (this.size === 0) return new ArrayBuffer(0);
    const result = await this._file._desktop.readFileRange(this._file.path, {
      start: this._start,
      end: this._end,
    });
    return result.bytes;
  }

  async text() {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  stream() {
    let offset = this._start;
    return new ReadableStream({
      pull: async (controller) => {
        if (offset >= this._end) {
          controller.close();
          return;
        }
        const end = Math.min(offset + DESKTOP_BLOB_STREAM_CHUNK_BYTES, this._end);
        const result = await this._file._desktop.readFileRange(this._file.path, { start: offset, end });
        const bytes = new Uint8Array(result.bytes);
        if (!bytes.byteLength) {
          controller.close();
          return;
        }
        offset += bytes.byteLength;
        controller.enqueue(bytes);
      },
    });
  }
}

class DesktopPathFile extends DesktopPathBlob {
  constructor(record, desktop) {
    const size = Math.max(0, Number(record.size || 0));
    super({ path: record.path, _desktop: desktop }, 0, size);
    this._file = this;
    this._desktop = desktop;
    this.path = record.path;
    this.name = record.name;
    this.size = size;
    this.lastModified = Number(record.lastModified || Date.now());
    this.webkitRelativePath = String(record.relativePath || '');
  }

  slice(start = 0, end = this.size, type = '') {
    const rangeStart = normalizeSlicePoint(start, 0, this.size);
    const rangeEnd = normalizeSlicePoint(end, this.size, this.size);
    return new DesktopPathBlob(this, rangeStart, Math.max(rangeStart, rangeEnd), type);
  }
}

export function desktopFileFromRecord(record, desktop) {
  return new DesktopPathFile(record, desktop);
}
