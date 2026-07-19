export const MAX_TIFF_COMPRESSED_STRIP_BYTES = 32 * 1024 * 1024;

const CLEAR_CODE = 256;
const END_OF_INFORMATION_CODE = 257;
const FIRST_DICTIONARY_CODE = 258;
const MAX_DICTIONARY_CODES = 4096;
const LITERALS = Array.from({ length: 256 }, (_, value) => Uint8Array.of(value));

function lzwError(stripIndex, detail) {
  return new Error(`TIFF LZW strip ${stripIndex + 1} ${detail}`);
}

function lzwResourceLimit(stripIndex, detail) {
  const error = new Error(`TIFF resource limit: strip ${stripIndex + 1} ${detail}`);
  error.tiffResourceLimit = true;
  return error;
}

function appendByte(prefix, value) {
  const entry = new Uint8Array(prefix.byteLength + 1);
  entry.set(prefix);
  entry[prefix.byteLength] = value;
  return entry;
}

function readCode(source, state) {
  if (state.bitOffset + state.codeWidth > source.byteLength * 8) return null;
  let code = 0;
  for (let index = 0; index < state.codeWidth; index += 1) {
    const bit = state.bitOffset + index;
    code = (code << 1) | ((source[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  state.bitOffset += state.codeWidth;
  return code;
}

function hasNonzeroPadding(source, bitOffset) {
  for (let bit = bitOffset; bit < source.byteLength * 8; bit += 1) {
    if ((source[bit >> 3] >> (7 - (bit & 7))) & 1) return true;
  }
  return false;
}

export function decodeTiffLzwStrip(value, expectedBytes, stripIndex = 0) {
  const source = value instanceof Uint8Array
    ? value
    : new Uint8Array(value?.buffer || value, value?.byteOffset || 0, value?.byteLength);
  const expected = Number(expectedBytes);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw lzwError(stripIndex, 'has invalid decoded geometry.');
  }
  if (expected > MAX_TIFF_COMPRESSED_STRIP_BYTES) {
    throw lzwResourceLimit(
      stripIndex,
      `decoded size ${expected} exceeds the ${MAX_TIFF_COMPRESSED_STRIP_BYTES} byte budget.`,
    );
  }
  if (source.byteLength > MAX_TIFF_COMPRESSED_STRIP_BYTES) {
    throw lzwResourceLimit(
      stripIndex,
      `encoded size ${source.byteLength} exceeds the ${MAX_TIFF_COMPRESSED_STRIP_BYTES} byte budget.`,
    );
  }

  const output = new Uint8Array(expected);
  const dictionary = new Array(MAX_DICTIONARY_CODES);
  const state = { bitOffset: 0, codeWidth: 9 };
  const maxCodes = expected + Math.ceil(expected / 256) + 16;
  let nextCode = FIRST_DICTIONARY_CODE;
  let previous = null;
  let outputOffset = 0;
  let codeCount = 0;
  let sawClear = false;
  let sawEnd = false;

  while (true) {
    const code = readCode(source, state);
    if (code == null) break;
    codeCount += 1;
    if (codeCount > maxCodes) {
      throw lzwResourceLimit(stripIndex, `contains more than ${maxCodes} bounded decoder codes.`);
    }
    if (code === CLEAR_CODE) {
      state.codeWidth = 9;
      nextCode = FIRST_DICTIONARY_CODE;
      previous = null;
      sawClear = true;
      continue;
    }
    if (!sawClear) throw lzwError(stripIndex, 'does not begin with the required clear code.');
    if (code === END_OF_INFORMATION_CODE) {
      sawEnd = true;
      break;
    }

    let entry;
    if (code < 256) entry = LITERALS[code];
    else if (code < nextCode && dictionary[code]) entry = dictionary[code];
    else if (code === nextCode && previous && nextCode < MAX_DICTIONARY_CODES) {
      entry = appendByte(previous, previous[0]);
    } else {
      throw lzwError(stripIndex, `contains invalid code ${code}.`);
    }
    if (entry.byteLength > expected - outputOffset) {
      throw lzwResourceLimit(stripIndex, `expands beyond its ${expected} byte geometry.`);
    }
    output.set(entry, outputOffset);
    outputOffset += entry.byteLength;

    if (previous && nextCode < MAX_DICTIONARY_CODES) {
      dictionary[nextCode] = appendByte(previous, entry[0]);
      nextCode += 1;
      // TIFF uses the early-change LZW convention from TIFF 6.0.
      if (state.codeWidth < 12 && nextCode === (1 << state.codeWidth) - 1) {
        state.codeWidth += 1;
      }
    }
    previous = entry;
  }

  if (!sawEnd) throw lzwError(stripIndex, 'is truncated or missing its end-of-information code.');
  if (outputOffset !== expected) {
    throw lzwError(stripIndex, `decoded to ${outputOffset} bytes; expected ${expected}.`);
  }
  const paddingBits = source.byteLength * 8 - state.bitOffset;
  if (paddingBits > 8 || hasNonzeroPadding(source, state.bitOffset)) {
    throw lzwError(stripIndex, 'contains trailing data after its end-of-information code.');
  }
  return output;
}
