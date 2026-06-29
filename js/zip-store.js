const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DEFAULT_TIME = 0;
const ZIP_DEFAULT_DATE = 33;
const encoder = new TextEncoder();

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function entryBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function safeEntryName(name) {
  return String(name || '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
}

function uniqueEntryName(name, seen) {
  const safe = safeEntryName(name);
  if (!safe) return '';
  let candidate = safe;
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let suffix = 2; seen.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${stem}-${suffix}${ext}`;
  }
  seen.add(candidate.toLowerCase());
  return candidate;
}

export function storedZip(entries = []) {
  const seenNames = new Set();
  const files = entries.map((entry) => ({
    name: uniqueEntryName(entry?.name, seenNames),
    bytes: entryBytes(entry?.bytes ?? entry?.data),
  })).filter(file => file.name && file.bytes?.byteLength > 0);
  if (!files.length) return null;

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(10, ZIP_DEFAULT_TIME, true);
    localView.setUint16(12, ZIP_DEFAULT_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    localParts.push(local, file.bytes);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(12, ZIP_DEFAULT_TIME, true);
    centralView.setUint16(14, ZIP_DEFAULT_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.byteLength, true);
    centralView.setUint32(24, file.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength + file.bytes.byteLength;
  }

  const centralOffset = offset;
  const central = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, centralOffset, true);
  return concatBytes([...localParts, central, eocd]);
}
