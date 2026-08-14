function buildLUT(fn) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const [r, g, b] = fn(t);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

export const COLORMAPS = {
  grayscale: {
    label: 'Grayscale',
    lut: buildLUT(t => { const value = clamp(t * 255); return [value, value, value]; }),
  },
  inverted: {
    label: 'Inverted',
    lut: buildLUT(t => { const value = clamp((1 - t) * 255); return [value, value, value]; }),
  },
  hot: {
    label: 'Hot',
    lut: buildLUT(t => [
      clamp(t < 0.33 ? t * 3 * 255 : 255),
      clamp(t < 0.33 ? 0 : t < 0.66 ? (t - 0.33) * 3 * 255 : 255),
      clamp(t < 0.66 ? 0 : (t - 0.66) * 3 * 255),
    ]),
  },
  cool: {
    label: 'Cool',
    lut: buildLUT(t => [
      clamp(t * 255),
      clamp((1 - t) * 255),
      255,
    ]),
  },
  bone: {
    label: 'Bone',
    lut: buildLUT(t => {
      const r = clamp(t < 0.75 ? t * 255 * 0.99 : (0.25 + (t - 0.75) * 3) * 255);
      const g = clamp(t < 0.375 ? t * 255 * 0.99 : t < 0.75 ? (0.125 + (t - 0.375) * 2) * 255 * 0.99 : (0.375 + (t - 0.75) * 2.5) * 255);
      const b = clamp(t * 255 * 1.1);
      return [r, g, b];
    }),
  },
  pet: {
    label: 'PET',
    lut: buildLUT(t => {
      if (t < 0.15) return [0, 0, clamp(t / 0.15 * 200)];
      if (t < 0.30) return [0, clamp((t - 0.15) / 0.15 * 255), 200];
      if (t < 0.45) return [0, 255, clamp(200 - (t - 0.30) / 0.15 * 200)];
      if (t < 0.60) return [clamp((t - 0.45) / 0.15 * 255), 255, 0];
      if (t < 0.75) return [255, clamp(255 - (t - 0.60) / 0.15 * 255), 0];
      if (t < 0.90) return [255, clamp((t - 0.75) / 0.15 * 200), clamp((t - 0.75) / 0.15 * 200)];
      return [255, clamp(200 + (t - 0.90) / 0.10 * 55), clamp(200 + (t - 0.90) / 0.10 * 55)];
    }),
  },
  rainbow: {
    label: 'Rainbow',
    lut: buildLUT(t => {
      const h = t * 300;
      const c = 1;
      const x = c * (1 - Math.abs((h / 60) % 2 - 1));
      let r;
      let g;
      let b;
      if (h < 60) { r = c; g = x; b = 0; }
      else if (h < 120) { r = x; g = c; b = 0; }
      else if (h < 180) { r = 0; g = c; b = x; }
      else if (h < 240) { r = 0; g = x; b = c; }
      else { r = x; g = 0; b = c; }
      return [clamp(r * 255), clamp(g * 255), clamp(b * 255)];
    }),
  },
};
