export function finiteDisplayRange(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = Number(value[0]);
  const hi = Number(value[1]);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

export function rawDisplayRangeToByteRange(displayRange, rawRange, { invert = false } = {}) {
  const display = finiteDisplayRange(displayRange);
  const raw = finiteDisplayRange(rawRange);
  if (!display || !raw) return null;
  const [lo, hi] = raw;
  const sourceRange = hi - lo;
  const byteRange = [
    (display[0] - lo) / sourceRange * 255,
    (display[1] - lo) / sourceRange * 255,
  ];
  return invert ? [255 - byteRange[1], 255 - byteRange[0]] : byteRange;
}

export function applyDisplayRangeToImage(image, displayRange) {
  if (!image) return false;
  const byteRange = rawDisplayRangeToByteRange(displayRange, image._microscopyRawRange, {
    invert: !!image._microscopyInvertDisplayRange,
  });
  if (!byteRange) {
    delete image._microscopyDisplayByteRange;
    return false;
  }
  image._microscopyDisplayByteRange = byteRange;
  return true;
}

export function applyDisplayRangeToChannelStacks(stacks = {}, channelIndex = 0, displayRange) {
  const c = Math.max(0, Math.floor(Number(channelIndex) || 0));
  let updated = 0;
  for (const [key, images] of Object.entries(stacks || {})) {
    const [stackC] = key.split('|').map(Number);
    if (stackC !== c || !Array.isArray(images)) continue;
    for (const image of images) {
      if (applyDisplayRangeToImage(image, displayRange)) updated += 1;
    }
  }
  return updated;
}
