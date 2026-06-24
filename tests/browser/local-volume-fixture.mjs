export function localVolumeSeries(slug, name, options = {}) {
  const slices = options.slices ?? 16;
  return {
    slug,
    name,
    description: options.description ?? 'browser fixture volume',
    modality: options.modality ?? 'MR',
    slices,
    width: options.width ?? 32,
    height: options.height ?? 32,
    pixelSpacing: options.pixelSpacing ?? [1, 1],
    sliceThickness: options.sliceThickness ?? 1,
    sliceSpacingStats: options.sliceSpacingStats ?? { mean: 1, regular: true },
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    renderability: 'volume',
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, Math.max(0, slices - 1)],
    orientation: [1, 0, 0, 0, 1, 0],
  };
}

export async function routeLocalVolumeStudy(page, series) {
  await page.route('**/api/local-token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ localApiToken: 'fixture-local-token' }),
    });
  });
  await page.route(/\/config(?:\.local)?\.json$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: { enabled: true, provider: 'local', ready: true, issues: [] },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        features: { cloudProcessing: false, aiAnalysis: true },
      }),
    });
  });
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series }),
    });
  });
  await page.route('**/data/registration.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  for (const [seriesIndex, item] of series.entries()) {
    await page.route(`**/data/${item.slug}/*.png`, async (route) => {
      const file = route.request().url().split('/').pop() || '';
      const index = Number.parseInt(file.replace('.png', ''), 10);
      if (!Number.isFinite(index) || index < 0 || index >= item.slices) {
        await route.fulfill({ status: 404 });
        return;
      }
      const shade = Math.min(235, 60 + seriesIndex * 40 + (index % 8) * 18);
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}" viewBox="0 0 ${item.width} ${item.height}">
          <rect width="${item.width}" height="${item.height}" fill="rgb(${shade},${shade},${shade})"/>
          <path d="M0 ${6 + index} L${item.width} ${item.height - 6 - (index % 10)}" stroke="rgb(255,255,255)" stroke-width="3"/>
          <circle cx="${8 + (index % 6) * 4}" cy="${item.height - 8 - (index % 5) * 3}" r="5" fill="rgb(20,20,20)"/>
        </svg>`,
      });
    });
  }
  return series;
}
