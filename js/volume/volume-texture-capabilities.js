function positiveDimension(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export const MAX_3D_BASE_TEXTURE_BYTES = 128 * 1024 * 1024;
export const MAX_3D_TEXTURE_BYTES = 256 * 1024 * 1024;

export function rendererMax3DTextureSize(renderer) {
  try {
    const gl = renderer?.getContext?.();
    if (!gl || gl.isContextLost?.()) return 0;
    return positiveDimension(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE));
  } catch {
    return 0;
  }
}

export function volumeTextureSizeSupport(dims, max3DTextureSize) {
  const W = positiveDimension(dims?.W);
  const H = positiveDimension(dims?.H);
  const D = positiveDimension(dims?.D);
  const maximum = positiveDimension(max3DTextureSize);
  if (!W || !H || !D) return { supported: false, reason: 'invalid volume dimensions', maximum };
  if (!maximum) return { supported: false, reason: '3D texture capability unavailable', maximum };
  const largest = Math.max(W, H, D);
  if (largest > maximum) {
    return {
      supported: false,
      reason: `volume dimension ${largest} exceeds GPU 3D texture limit ${maximum}`,
      maximum,
    };
  }
  return { supported: true, reason: '', maximum };
}
