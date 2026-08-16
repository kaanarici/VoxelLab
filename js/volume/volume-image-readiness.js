export function workerFlattenAvailable() {
  return globalThis.Worker instanceof Function
    && globalThis.OffscreenCanvas instanceof Function
    && globalThis.createImageBitmap instanceof Function;
}

export function hasDenseLoadedImages(imgs, count) {
  if (!Array.isArray(imgs) || imgs.length !== count) return false;
  for (let i = 0; i < count; i++) {
    const img = imgs[i];
    if (!img || !img.complete || img.naturalWidth <= 0) return false;
  }
  return true;
}
