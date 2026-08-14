function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('LZ4 input must be byte-addressable.');
}

function readExtendedLength(src, cursor, baseLength) {
  let pos = cursor;
  let length = baseLength;
  if (length !== 15) return { length, pos };

  let extension = 0;
  do {
    if (pos >= src.byteLength) throw new Error('Invalid LZ4 block: truncated length extension.');
    extension = src[pos];
    pos += 1;
    length += extension;
  } while (extension === 255);

  return { length, pos };
}

export function lz4BlockDecompress(srcBytes, destLen) {
  const src = asUint8Array(srcBytes);
  const outputLength = Number(destLen);
  if (!Number.isInteger(outputLength) || outputLength < 0) {
    throw new Error('Invalid LZ4 block: destination length must be a non-negative integer.');
  }

  const output = new Uint8Array(outputLength);
  let sp = 0;
  let dp = 0;

  while (sp < src.byteLength) {
    // LZ4 block sequence: token, literals, optional 16-bit match offset, match bytes.
    const token = src[sp];
    sp += 1;

    const literal = readExtendedLength(src, sp, token >> 4);
    sp = literal.pos;
    if (sp + literal.length > src.byteLength) throw new Error('Invalid LZ4 block: literal run overruns input.');
    if (dp + literal.length > outputLength) throw new Error('Invalid LZ4 block: literal run overruns output.');

    output.set(src.subarray(sp, sp + literal.length), dp);
    sp += literal.length;
    dp += literal.length;

    if (sp === src.byteLength) break;
    if (sp + 2 > src.byteLength) throw new Error('Invalid LZ4 block: missing match offset.');

    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;
    if (offset === 0 || offset > dp) throw new Error('Invalid LZ4 block: bad match offset.');

    const match = readExtendedLength(src, sp, token & 0x0f);
    sp = match.pos;
    const matchLength = match.length + 4;
    if (dp + matchLength > outputLength) throw new Error('Invalid LZ4 block: match overruns output.');

    for (let i = 0; i < matchLength; i += 1) {
      output[dp] = output[dp - offset];
      dp += 1;
    }
  }

  if (dp !== outputLength) throw new Error('Invalid LZ4 block: decoded length mismatch.');
  return output;
}
