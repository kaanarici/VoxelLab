/* global Float32Array, Uint8Array, document */
import { expect, test } from '@playwright/test';
import { obliqueBasis } from '../../js/mpr/mpr-oblique-geometry.js';
import { planeForOblique } from '../../js/mpr/mpr-projection.js';
import { sampleTrilinear } from '../../js/mpr/mpr-sampling.js';

async function renderGpuPixels(page, options) {
  return page.evaluate(async (input) => {
    const { drawGpuMprSlice } = await import('/js/mpr/mpr-gpu.js');
    const canvas = document.createElement('canvas');
    canvas.width = input.width;
    canvas.height = input.height;
    const identity = Uint8Array.from({ length: 256 }, (_, index) => index);
    const ok = drawGpuMprSlice(canvas, {
      ...input,
      vox: input.floatVoxels ? Float32Array.from(input.vox) : Uint8Array.from(input.vox),
      wlLut: { key: 'identity', r: identity, g: identity, b: identity },
    });
    const pixels = ok
      ? Array.from(canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, canvas.width, canvas.height).data)
      : [];
    return { ok, red: pixels.filter((_, index) => index % 4 === 0) };
  }, options);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
});

test('GPU MPR maps fragment centers to exact voxel-center endpoints', async ({ page }) => {
  const input = {
    width: 4,
    height: 1,
    dims: { W: 4, H: 1, D: 1 },
    vox: [0, 85, 170, 255],
    plane: { origin: [0, 0, 0], axisU: [3, 0, 0], axisV: [0, 0, 0] },
    projection: { mode: 'thin', sampleCount: 1, slabStep: [0, 0, 0] },
  };
  const bytes = await renderGpuPixels(page, input);
  const floats = await renderGpuPixels(page, {
    ...input,
    floatVoxels: true,
    vox: [0, 1 / 3, 2 / 3, 1],
  });

  expect(bytes).toEqual({ ok: true, red: [0, 85, 170, 255] });
  expect(floats).toEqual({ ok: true, red: [0, 85, 170, 255] });
});

test('GPU MPR paints out-of-volume oblique samples as background', async ({ page }) => {
  const result = await renderGpuPixels(page, {
    width: 5,
    height: 5,
    dims: { W: 2, H: 2, D: 2 },
    vox: new Array(8).fill(255),
    plane: { origin: [-2, -2, 0.5], axisU: [8, 0, 0], axisV: [0, 8, 0] },
    projection: { mode: 'thin', sampleCount: 1, slabStep: [0, 0, 0] },
  });

  expect(result.ok).toBe(true);
  expect(result.red.filter(value => value === 255)).toHaveLength(1);
  expect(result.red.filter(value => value === 0)).toHaveLength(24);
});

test('GPU and CPU trilinear sampling agree at 45° yaw and 36.3° pitch', async ({ page }) => {
  const width = 7;
  const height = 6;
  const dims = { W: 5, H: 4, D: 3 };
  const spacing = { col: 0.7, row: 1.2, slice: 2.5 };
  const vox = Uint8Array.from({ length: dims.W * dims.H * dims.D }, (_, index) => {
    const z = Math.floor(index / (dims.W * dims.H));
    const y = Math.floor((index % (dims.W * dims.H)) / dims.W);
    const x = index % dims.W;
    return x * 19 + y * 27 + z * 43;
  });
  const basis = obliqueBasis(45, 36.3);
  const stepUMm = 0.5;
  const stepVMm = 0.5;
  const du = [
    basis.u[0] * stepUMm / spacing.col,
    basis.u[1] * stepUMm / spacing.row,
    basis.u[2] * stepUMm / spacing.slice,
  ];
  const dv = [
    basis.v[0] * stepVMm / spacing.col,
    basis.v[1] * stepVMm / spacing.row,
    basis.v[2] * stepVMm / spacing.slice,
  ];
  const plane = planeForOblique(width, height, [2, 1.5, 1], du, dv);
  const cpu = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const px = plane.origin[0] + u * plane.axisU[0] + v * plane.axisV[0];
      const py = plane.origin[1] + u * plane.axisU[1] + v * plane.axisV[1];
      const pz = plane.origin[2] + u * plane.axisU[2] + v * plane.axisV[2];
      const inside = px >= 0 && px <= dims.W - 1
        && py >= 0 && py <= dims.H - 1
        && pz >= 0 && pz <= dims.D - 1;
      cpu.push(inside ? Math.round(sampleTrilinear(vox, px, py, pz, dims.W, dims.H, dims.D)) : 0);
    }
  }

  const gpu = await renderGpuPixels(page, {
    width,
    height,
    dims,
    vox: Array.from(vox),
    plane,
    projection: { mode: 'thin', sampleCount: 1, slabStep: [0, 0, 0] },
  });

  expect(gpu.ok).toBe(true);
  expect(gpu.red).toHaveLength(cpu.length);
  expect(Math.max(...gpu.red.map((value, index) => Math.abs(value - cpu[index])))).toBeLessThanOrEqual(1);
});

test('GPU slab extrema include the center and ignore invalid leading samples', async ({ page }) => {
  const centerImpulse = new Array(81).fill(0);
  centerImpulse[40] = 255;
  const mip = await renderGpuPixels(page, {
    width: 1,
    height: 1,
    dims: { W: 1, H: 1, D: 81 },
    vox: centerImpulse,
    plane: { origin: [0, 0, 40], axisU: [0, 0, 0], axisV: [0, 0, 0] },
    projection: { mode: 'mip', sampleCount: 161, slabStep: [0, 0, 0.5] },
  });
  const minip = await renderGpuPixels(page, {
    width: 1,
    height: 1,
    dims: { W: 1, H: 1, D: 3 },
    vox: [255, 100, 20],
    plane: { origin: [0, 0, 0], axisU: [0, 0, 0], axisV: [0, 0, 0] },
    projection: { mode: 'minip', sampleCount: 3, slabStep: [0, 0, 1] },
  });

  expect(mip).toEqual({ ok: true, red: [255] });
  expect(minip).toEqual({ ok: true, red: [100] });
});
