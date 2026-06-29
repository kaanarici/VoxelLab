import { state } from '../core/state.js';
import { storedZip } from '../zip-store.js';
import { roiResultRows, roiResultsBundle, sourceForBundle, calibrationForBundle } from './roi-results-model.js';
import { roiResultsCsv } from './roi-results-export.js';

export const MICROSCOPY_EVIDENCE_PACKAGE_SCHEMA = 'voxellab.microscopyEvidencePackage.v1';
export const MICROSCOPY_ANALYSIS_DESCRIPTOR_SCHEMA = 'voxellab.microscopyAnalysisDescriptor.v1';

export const MICROSCOPY_EVIDENCE_LIMITATIONS = Object.freeze([
  'Research and educational use only; not clinical or diagnostic output.',
  'Particle evidence is threshold-driven and must be reviewed against the annotated snapshot and source microscopy data.',
  'Physical measurements are trusted only when metadata or manual calibration is explicit.',
  'The package excludes source image pixels in v1; it carries source file names, provenance, calibration, ROI rows, and rendered evidence only.',
]);

function safeFilenamePart(value) {
  return String(value || 'series').replace(/[^a-z0-9_.-]+/gi, '_') || 'series';
}

function jsonFile(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function bytesForSnapshot(snapshotPng) {
  if (snapshotPng instanceof Uint8Array) return snapshotPng;
  if (snapshotPng instanceof ArrayBuffer) return new Uint8Array(snapshotPng);
  if (ArrayBuffer.isView(snapshotPng)) return new Uint8Array(snapshotPng.buffer, snapshotPng.byteOffset, snapshotPng.byteLength);
  return null;
}

function analysisOpsForSeries(host, series) {
  const ops = host?._microscopyAnalysisLog?.[series?.slug] || [];
  return Array.isArray(ops) ? ops.slice() : [];
}

function intensityDomains(rows = []) {
  const bySource = new Map();
  for (const row of rows) {
    const source = row.valueSource || 'display_8bit';
    const current = bySource.get(source) || {
      valueSource: source,
      valueUnit: row.valueUnit || '',
      rows: 0,
      meaning: source === 'raw_16bit'
        ? 'raw retained microscopy plane intensity'
        : source === 'display_8bit'
        ? 'display-windowed 8-bit viewer intensity'
        : source,
    };
    current.rows += 1;
    bySource.set(source, current);
  }
  return [...bySource.values()];
}

function evidenceManifest({ series, rows, source, calibration, analysisOps, snapshotFilename }) {
  return {
    schema: MICROSCOPY_EVIDENCE_PACKAGE_SCHEMA,
    packageKind: 'microscopy-evidence-package',
    createdAt: new Date().toISOString(),
    series: {
      slug: series.slug || '',
      name: series.name || series.slug || '',
      imageDomain: series.imageDomain || '',
      width: Number(series.width) || 0,
      height: Number(series.height) || 0,
      slices: Number(series.slices) || 0,
    },
    source: {
      imageDomain: source.imageDomain,
      format: source.format,
      sourceFiles: source.sourceFiles,
      warnings: source.warnings,
    },
    axes: source.dataset?.axes || [],
    channels: source.dataset?.channels || [],
    planes: source.dataset?.planes || [],
    calibration,
    evidence: {
      artifact: `voxellab-microscopy-evidence-${safeFilenamePart(series.slug)}.zip`,
      files: [
        'manifest.json',
        'roi-results.json',
        'roi-results.csv',
        snapshotFilename,
        'analysis-descriptor.json',
        'LIMITATIONS.txt',
      ],
      roiRowCount: rows.length,
      analysisOperationCount: analysisOps.length,
      intensityDomains: intensityDomains(rows),
      sourceImageDataIncluded: false,
      sourceImageDataPolicy: 'excluded unless a future explicit include-source option is added',
    },
    limitations: MICROSCOPY_EVIDENCE_LIMITATIONS,
  };
}

function analysisDescriptor({ series, analysisOps }) {
  return {
    schema: MICROSCOPY_ANALYSIS_DESCRIPTOR_SCHEMA,
    createdAt: new Date().toISOString(),
    series: {
      slug: series.slug || '',
      name: series.name || series.slug || '',
    },
    operationCount: analysisOps.length,
    measurementDomains: [...new Set(analysisOps.map(op => op?.measurementDomain).filter(Boolean))],
    operations: analysisOps,
  };
}

function limitationsText() {
  return `${MICROSCOPY_EVIDENCE_LIMITATIONS.map(item => `- ${item}`).join('\n')}\n`;
}

export function buildMicroscopyEvidencePackage(host = state, { snapshotPng } = {}) {
  const series = host?.manifest?.series?.[host.seriesIdx];
  if (!series || series.imageDomain !== 'microscopy') return { ok: false, reason: 'not_microscopy' };
  const rows = roiResultRows(host, series);
  if (!rows.length) return { ok: false, reason: 'no_roi_rows' };
  const analysisOps = analysisOpsForSeries(host, series);
  if (!analysisOps.length) return { ok: false, reason: 'no_analysis_descriptor' };
  const snapshotBytes = bytesForSnapshot(snapshotPng);
  if (!snapshotBytes?.byteLength) return { ok: false, reason: 'no_snapshot' };

  const slug = safeFilenamePart(series.slug);
  const source = sourceForBundle(series);
  const calibration = calibrationForBundle(series);
  const snapshotFilename = `annotated-snapshot-${slug}.png`;
  const manifest = evidenceManifest({ series, rows, source, calibration, analysisOps, snapshotFilename });
  const descriptor = analysisDescriptor({ series, analysisOps });
  const bundle = roiResultsBundle(rows, series);
  const files = [
    { name: 'manifest.json', bytes: jsonFile(manifest) },
    { name: 'roi-results.json', bytes: jsonFile(bundle) },
    { name: 'roi-results.csv', bytes: roiResultsCsv(rows, series) },
    { name: snapshotFilename, bytes: snapshotBytes },
    { name: 'analysis-descriptor.json', bytes: jsonFile(descriptor) },
    { name: 'LIMITATIONS.txt', bytes: limitationsText() },
  ];
  const zip = storedZip(files);
  if (!zip) return { ok: false, reason: 'empty_package' };
  return {
    ok: true,
    filename: `voxellab-microscopy-evidence-${slug}.zip`,
    bytes: zip,
    files: files.map(file => file.name),
    manifest,
    analysisDescriptor: descriptor,
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportMicroscopyEvidencePackage(host = state) {
  const { capture2DScreenshotPngBlob } = await import('../screenshot.js');
  const snapshot = await capture2DScreenshotPngBlob();
  const snapshotBytes = snapshot?.blob ? new Uint8Array(await snapshot.blob.arrayBuffer()) : null;
  const result = buildMicroscopyEvidencePackage(host, { snapshotPng: snapshotBytes });
  if (!result.ok) return result;
  downloadBlob(new Blob([result.bytes], { type: 'application/zip' }), result.filename);
  return result;
}

export function microscopyEvidencePackageFailureText(reason = '') {
  if (reason === 'not_microscopy') return 'Open a microscopy series before exporting an evidence package';
  if (reason === 'no_roi_rows') return 'Run Analyze Particles before exporting an evidence package';
  if (reason === 'no_analysis_descriptor') return 'Run Analyze Particles before exporting an evidence package';
  if (reason === 'no_snapshot') return 'Snapshot capture failed; keep the 2D viewer visible and try again';
  return 'Microscopy evidence package export failed';
}
