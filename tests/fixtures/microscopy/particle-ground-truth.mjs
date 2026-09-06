export function makeRectParticlePlane({ width, height, rects = [] }) {
  const pixels = new Float32Array(width * height);
  for (const { x, y, w, h, value } of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        pixels[yy * width + xx] = value;
      }
    }
  }
  return { pixels, width, height };
}

export const PARTICLE_PLANE = {
  width: 32,
  height: 32,
  rects: [
    { x: 5, y: 5, w: 4, h: 4, value: 40000 },
    { x: 20, y: 10, w: 6, h: 2, value: 20000 },
    { x: 28, y: 28, w: 1, h: 1, value: 10000 },
    { x: 0, y: 0, w: 3, h: 3, value: 30000 },
  ],
};

export const PARTICLE_GROUND_TRUTH = {
  count: 4,
  sortedAreas: [1, 9, 12, 16],
  big: { area: 16, value: 40000, centroid: { x: 6.5, y: 6.5 }, bbox: { x: 5, y: 5, w: 4, h: 4 } },
};
