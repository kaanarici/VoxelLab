// ROI results entrypoint: aggregates the split modules so importers keep one
// stable name. Data shaping + bundle import/export logic lives in
// roi-results-model.js, CSV/JSON/ImageJ serialization in roi-results-export.js,
// and the panel UI in roi-results-table.js.

export {
  activateRoiResultRow,
  importRoiResultsBundle,
  roiResultRows,
  roiResultsBundle,
  roiResultsBundleIncompatibleRowCount,
  roiResultsImportFailureText,
  roiResultsImportStatusText,
  rowMatchesCurrentScope,
  setRoiResultLabel,
  validateRoiResultsBundleForSeries,
} from './roi-results-model.js';

export {
  exportImageJRoiZip,
  exportRoiResultsCsv,
  exportRoiResultsJson,
  roiResultsCsv,
} from './roi-results-export.js';

export { initRoiResultsPanel, renderRoiResults } from './roi-results-table.js';
