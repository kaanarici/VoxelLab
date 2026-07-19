#!/usr/bin/env node
/* global process */
// Generate js/sw-precache-manifest.js from the on-disk asset tree so the
// service worker never drifts from a hand-maintained file list.
//
// PRECACHE_LOCAL is the install-time precache set: every js/**/*.js,
// css/*.css, templates/*.html, and index.html EXCEPT the lazy optional
// modules below. Lazy modules are still served cache-first on first use
// (sw.js cache-firsts all of /js/) — they are only kept out of the
// install-time addAll() so first paint stays light. Adding or renaming a
// non-lazy asset is picked up automatically; a new lazy/optional module
// must be listed in LAZY_OPTIONAL_MODULES to stay out of install precache.
//
// Run via `npm run gen:sw`.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'js', 'sw-precache-manifest.js');
const OUTPUT_REL = 'js/sw-precache-manifest.js';

// Optional features imported via dynamic import(); kept out of the
// install-time precache. The service worker itself loads the generated
// manifest, so it is excluded too (it is not an app-fetched module).
export const LAZY_OPTIONAL_MODULES = new Set([
  'js/dicom/dicom-codecs.js',
  'js/consult-ask.js',
  'js/ask-event-stream.js',
  'js/dicom/dicom-derived-import.js',
  'js/dicom/derived-common.js',
  'js/dicom/derived-hydrate.js',
  'js/dicom/derived-rtdose.js',
  'js/dicom/derived-rtstruct.js',
  'js/dicom/derived-seg.js',
  'js/dicom/derived-sr.js',
  'js/dicom/dicom-import-classify.js',
  'js/dicom/dicom-import-geometry.js',
  'js/dicom/dicom-import-parse.js',
  'js/dicom/dicom-import-routing.js',
  'js/dicom/dicom-import.js',
  'js/dicom/dicom-pixel-data.js',
  'js/dicom/dicom-sr-collect.js',
  'js/dicom/dicom-sr-dataset.js',
  'js/dicom/dicom-sr-utils.js',
  'js/dicom/dicom-sr.js',
  'js/dicom/dicomweb/dicomweb-source.js',
  'js/dicom/dicomweb/session-transport.js',
  'js/desktop-bridge.js',
  'js/dicom/dicomweb-derived-import.js',
  'js/dicom/dicomweb-import.js',
  'js/desktop-path-file.js',
  'js/shell/desktop-window-chrome.js',
  'js/file-drop.js',
  'js/format-capability-matrix.js',
  'js/fusion-loader.js',
  'js/microscopy/imagej-roi.js',
  'js/microscopy/microscopy-analysis.js',
  'js/microscopy/microscopy-analysis-overlay.js',
  'js/microscopy/microscopy-analysis-panel.js',
  'js/microscopy/microscopy-quantification.js',
  'js/microscopy/microscopy-hyperstack-controls.js',
  'js/microscopy/microscopy-import.js',
  'js/microscopy/microscopy-series-results.js',
  'js/microscopy/microscopy-particles.js',
  'js/microscopy/microscopy-projection.js',
  'js/microscopy/microscopy-threshold.js',
  'js/microscopy/microscopy-workflow-recipe.js',
  'js/microscopy/microscopy-workflow-recipe-encode.js',
  'js/microscopy/microscopy-workflow-recipe-replay.js',
  'js/microscopy/microscopy-zarr-import.js',
  'js/microscopy/microscopy-zarr-metadata.js',
  'js/mpr/mpr-gpu.js',
  'js/dicom/nifti-import-parse.js',
  'js/plugin.js',
  'js/projects/cloud-action-preflight.js',
  'js/projects/dicomweb-import-modal.js',
  'js/projects/local-intake-summary.js',
  'js/projects/local-intake-text.js',
  'js/projects/microscopy-sidecars.js',
  'js/projects/ome-zarr-import-modal.js',
  'js/projects/upload-status.js',
  'js/screenshot.js',
  'js/shortcuts-modal.js',
  'js/overlay/slimsam-fetch.js',
  'js/overlay/slimsam-inference.js',
  'js/overlay/slimsam.js',
  'js/projects/study-upload-modal.js',
  'js/projects/vendor-microscopy-convert.js',
  'js/volume/vendor-three.js',
  'js/volume/vendor-trackball-controls.js',
  'js/volume/volume-3d-hover.js',
  'js/volume/volume-3d-views.js',
  'js/volume/volume-label-overlay.js',
  'js/volume/volume-raycast-material.js',
  'js/volume/volume-raycast-shaders.js',
  'js/volume/volume-raycast-steps.js',
  'js/volume/volume-three-bootstrap.js',
  // Mesh export (Feature B) is reached only via dynamic import() on a download click.
  'js/mesh/mesh-export.js',
  'js/mesh/marching-cubes.js',
  'js/mesh/marching-cubes-tables.js',
  'js/mesh/mesh-transform.js',
  'js/mesh/mesh-encoders.js',
  OUTPUT_REL,
]);

function walk(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry).split(path.sep).join('/');
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      out.push(...walk(rel, predicate));
    } else if (predicate(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function glob(dir, ext) {
  return walk(dir, (rel) => rel.endsWith(ext));
}

export function collectPrecacheAssets() {
  return [
    ...glob('js', '.js').filter((rel) => !LAZY_OPTIONAL_MODULES.has(rel)),
    ...glob('css', '.css'),
    ...glob('templates', '.html'),
    'index.html',
  ]
    .map((rel) => `./${rel}`)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function render(assets) {
  return `// GENERATED by scripts/gen_sw_manifest.mjs — do not edit by hand.
// Run \`npm run gen:sw\` after adding/removing/renaming precached assets.
export const PRECACHE_LOCAL = [
${assets.map((asset) => `  '${asset}',`).join('\n')}
];
`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const assets = collectPrecacheAssets();
  writeFileSync(OUTPUT, render(assets));
  process.stdout.write(`Wrote ${assets.length} entries to ${OUTPUT_REL}\n`);
}
