import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function compressedZipEntry(name, payload, { dataDescriptor = false } = {}) {
  const compressed = deflateRawSync(payload);
  const encodedName = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  if (dataDescriptor) local.writeUInt16LE(0x08, 6);
  local.writeUInt16LE(8, 8);
  if (!dataDescriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
  }
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  const descriptor = dataDescriptor ? Buffer.alloc(16) : null;
  if (descriptor) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(payload.length, 12);
  }
  const central = Buffer.alloc(46 + encodedName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  if (dataDescriptor) central.writeUInt16LE(0x08, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  encodedName.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length + (descriptor?.length || 0), 16);
  return Buffer.concat([local, compressed, ...(descriptor ? [descriptor] : []), central, eocd]);
}

export function withDeclaredUncompressedSize(zip, size) {
  const forged = Buffer.from(zip);
  const centralOffset = 30 + forged.readUInt16LE(26) + forged.readUInt32LE(18);
  forged.writeUInt32LE(size, 22);
  forged.writeUInt32LE(size, centralOffset + 24);
  return forged;
}

export function storedLocalZipEntry(name, payload, { flags = 0, crc = crc32(payload) } = {}) {
  const encodedName = Buffer.from(name);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  return Buffer.concat([local, payload]);
}

export function compressedLocalZipEntry(name, payload, { crc = crc32(payload) } = {}) {
  const encodedName = Buffer.from(name);
  const compressed = deflateRawSync(payload);
  const local = Buffer.alloc(30 + encodedName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  return Buffer.concat([local, compressed]);
}

export function localZipEntryWithSizes(name, { method = 0, compressedSize = 0, uncompressedSize = 0, payload = Buffer.alloc(0) } = {}) {
  const encodedName = Buffer.from(name);
  const local = Buffer.alloc(30 + encodedName.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  payload.copy(local, 30 + encodedName.length);
  return local;
}

export function zipArchive(localEntries) {
  let offset = 0;
  const centralEntries = localEntries.map(entry => {
    const nameLength = entry.readUInt16LE(26);
    const name = entry.subarray(30, 30 + nameLength);
    const central = Buffer.alloc(46 + nameLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.readUInt16LE(6), 8);
    central.writeUInt16LE(entry.readUInt16LE(8), 10);
    central.writeUInt32LE(entry.readUInt32LE(14), 16);
    central.writeUInt32LE(entry.readUInt32LE(18), 20);
    central.writeUInt32LE(entry.readUInt32LE(22), 24);
    central.writeUInt16LE(nameLength, 28);
    name.copy(central, 46);
    central.writeUInt32LE(offset, 42);
    offset += entry.length;
    return central;
  });
  const central = Buffer.concat(centralEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(localEntries.length, 8);
  eocd.writeUInt16LE(localEntries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, central, eocd]);
}

export function unsupportedDescriptorThenStoredZip(unsupportedName, unsupportedPayload, storedName, storedPayload) {
  const unsupportedEncodedName = Buffer.from(unsupportedName);
  const unsupportedLocal = Buffer.alloc(30 + unsupportedEncodedName.length);
  unsupportedLocal.writeUInt32LE(0x04034b50, 0);
  unsupportedLocal.writeUInt16LE(20, 4);
  unsupportedLocal.writeUInt16LE(0x08, 6);
  unsupportedLocal.writeUInt16LE(12, 8);
  unsupportedLocal.writeUInt16LE(unsupportedEncodedName.length, 26);
  unsupportedEncodedName.copy(unsupportedLocal, 30);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32(unsupportedPayload), 4);
  descriptor.writeUInt32LE(unsupportedPayload.length, 8);
  descriptor.writeUInt32LE(unsupportedPayload.length, 12);
  const stored = storedLocalZipEntry(storedName, storedPayload);
  const centralEntry = (name, { flags, method, crc, compressedSize, uncompressedSize, offset }) => {
    const encodedName = Buffer.from(name);
    const central = Buffer.alloc(46 + encodedName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(encodedName.length, 28);
    encodedName.copy(central, 46);
    central.writeUInt32LE(offset, 42);
    return central;
  };
  const firstLength = unsupportedLocal.length + unsupportedPayload.length + descriptor.length;
  const central = Buffer.concat([
    centralEntry(unsupportedName, { flags: 0x08, method: 12, crc: crc32(unsupportedPayload), compressedSize: unsupportedPayload.length, uncompressedSize: unsupportedPayload.length, offset: 0 }),
    centralEntry(storedName, { flags: 0, method: 0, crc: crc32(storedPayload), compressedSize: storedPayload.length, uncompressedSize: storedPayload.length, offset: firstLength }),
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(firstLength + stored.length, 16);
  return Buffer.concat([unsupportedLocal, unsupportedPayload, descriptor, stored, central, eocd]);
}
