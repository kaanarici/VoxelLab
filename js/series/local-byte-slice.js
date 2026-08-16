const LOCAL_BYTE_DATA = '_voxellabByteData';

function validDimension(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function createLocalByteSlice(bytes, width, height) {
  const naturalWidth = validDimension(width);
  const naturalHeight = validDimension(height);
  if (!(bytes instanceof Uint8Array) || bytes.length !== naturalWidth * naturalHeight) {
    throw new Error('Local byte slice dimensions do not match its pixel data');
  }
  return {
    complete: true,
    naturalWidth,
    naturalHeight,
    [LOCAL_BYTE_DATA]: bytes,
  };
}

export function localByteSliceData(source) {
  return source?.[LOCAL_BYTE_DATA] instanceof Uint8Array
    ? source[LOCAL_BYTE_DATA]
    : null;
}

export function downsampleLocalByteSlice(bytes, width, height, maxDimension) {
  const sourceWidth = validDimension(width);
  const sourceHeight = validDimension(height);
  const limit = validDimension(maxDimension);
  if (!(bytes instanceof Uint8Array) || bytes.length !== sourceWidth * sourceHeight || !limit) {
    throw new Error('Local byte thumbnail dimensions do not match its pixel data');
  }
  const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  if (targetWidth === sourceWidth && targetHeight === sourceHeight) {
    return { bytes, width: sourceWidth, height: sourceHeight };
  }
  const sampled = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / targetWidth));
      sampled[y * targetWidth + x] = bytes[sourceY * sourceWidth + sourceX];
    }
  }
  return { bytes: sampled, width: targetWidth, height: targetHeight };
}

export function stackHasLocalByteSlices(stack, count = stack?.length) {
  if (!Array.isArray(stack) || stack.length !== count) return false;
  for (let index = 0; index < count; index += 1) {
    if (!localByteSliceData(stack[index])) return false;
  }
  return true;
}
