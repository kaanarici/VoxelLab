import { installViewerGlobals } from './viewer-globals.mjs';

export async function installRoiResultsHost() {
  const { storage } = installViewerGlobals();
  const { state } = await import('../../../js/core/state.js');
  const { initROI } = await import('../../../js/roi.js');
  const { importRoiResultsBundle } = await import('../../../js/roi/roi-results.js');
  const { seriesPersistenceKey } = await import('../../../js/core/series-identity.js');

  initROI({ state });

  const importBundleForActiveSeries = (bundle, host = state) => {
    const series = host?.manifest?.series?.[host?.seriesIdx];
    return importRoiResultsBundle({
      ...bundle,
      series: {
        ...bundle.series,
        persistenceKey: bundle.series?.persistenceKey || seriesPersistenceKey(series, host?.manifest),
      },
    }, host);
  };

  return { state, storage, importBundleForActiveSeries, seriesPersistenceKey };
}
