// Synthetic raw single-channel plane with disjoint rectangular "particles" whose counts,
// areas, centroids, and intensities are known exactly for deterministic assertions.
// Rects are spaced so none touch (even diagonally) → each is its own 8-connected component.

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
    { x: 5, y: 5, w: 4, h: 4, value: 40000 },   // area 16, centroid (6.5, 6.5)
    { x: 20, y: 10, w: 6, h: 2, value: 20000 },  // area 12, centroid (22.5, 10.5)
    { x: 28, y: 28, w: 1, h: 1, value: 10000 },  // area 1, singleton
    { x: 0, y: 0, w: 3, h: 3, value: 30000 },    // area 9, touches the image edge
  ],
};

export const PARTICLE_GROUND_TRUTH = {
  count: 4,
  sortedAreas: [1, 9, 12, 16],
  big: { area: 16, value: 40000, centroid: { x: 6.5, y: 6.5 }, bbox: { x: 5, y: 5, w: 4, h: 4 } },
};
