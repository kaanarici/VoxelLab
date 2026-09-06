import { expect, test } from '@playwright/test';

test('all volume modes isolate labels and reuse unchanged voxel textures', async ({ page }) => {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { createVolumeRaycastMaterial } = await import('/js/volume/volume-raycast-material.js');
    const { updateLabelTexture } = await import('/js/volume/volume-label-overlay.js');
    const { state, batch } = await import('/js/core/state.js');
    const data = new Uint8Array(4096).fill(200);
    const labels = Uint8Array.from(data, (_, index) => index % 16 < 8 ? 1 : 2);
    const texture = new THREE.Data3DTexture(data, 16, 16, 16);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.needsUpdate = true;
    const lut = new THREE.DataTexture(new Uint8Array(1024), 256, 1);
    lut.needsUpdate = true;
    const material = createVolumeRaycastMaterial({
      texture, dummyLabel: null, lutTex: lut, width: 16, height: 16, depth: 16,
      lowT: 0, highT: 1, intensity: 1, clipMin: [0, 0, 0], clipMax: [1, 1, 1],
      clipPlane: [0, 0, 1, 0], renderMode: 'alpha',
    });
    Object.assign(material.userData, { max3DTextureSize: 2048, baseTextureBytes: 4096 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-0.65, 0.65, 0.65, -0.65, 0.1, 10);
    camera.position.set(0, 0, 2);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(64, 64);
    renderer.setClearColor(0, 0);
    const target = new THREE.WebGLRenderTarget(64, 64);
    renderer.setRenderTarget(target);
    const results = [];
    batch(() => {
      state.manifest = { series: [{ slug: 'render-proof', width: 16, height: 16, slices: 16, hasRegions: true }] };
      state.seriesIdx = 0;
      state.threeRuntime.mesh = mesh;
      state.regionVoxels = labels;
      state.overlays.labels = true;
      state.overlays.regionMeta = { regions: { 1: { name: 'A' }, 2: { name: 'B' } }, colors: { 1: [255, 0, 0], 2: [0, 255, 0] } };
      const visiblePixels = () => {
        renderer.clear();
        renderer.render(scene, camera);
        const pixels = new Uint8Array(16384);
        renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
        return pixels.filter((value, index) => index % 4 === 3 && value > 0).length;
      };
      for (const mode of [0, 1, 2]) {
        material.uniforms.uMode.value = mode;
        state.overlays.overlayOpacity = 0.5;
        state.lockedLabels = new Set();
        updateLabelTexture();
        const before = visiblePixels();
        state.lockedLabels = new Set([1]);
        updateLabelTexture();
        const after = visiblePixels();
        state.overlays.overlayOpacity = 0;
        updateLabelTexture();
        results.push({ mode, before, after, transparent: visiblePixels() });
      }
    });
    const labelTexture = material.uniforms.uLabel.value;
    const version = labelTexture.version;
    updateLabelTexture();
    const reused = labelTexture === material.uniforms.uLabel.value && version === labelTexture.version;
    renderer.dispose();
    target.dispose();
    return { results, reused };
  });
  expect(result.reused).toBe(true);
  for (const row of result.results) {
    expect(row.before).toBeGreaterThan(0);
    expect(row.after).toBe(row.before / 2);
    expect(row.transparent).toBe(row.mode === 0 ? 0 : row.after);
  }
});
