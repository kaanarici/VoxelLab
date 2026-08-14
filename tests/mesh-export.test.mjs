import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../js/core/state.js';
import { exportLabelMesh, exportStudyMesh } from '../js/mesh/mesh-export.js';

const originalDocument = globalThis.document;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

let downloads;

function installDownloadStubs() {
  downloads = [];
  URL.createObjectURL = (blob) => {
    const url = `blob:mesh-${downloads.length}`;
    downloads.push({ url, blob, download: '' });
    return url;
  };
  URL.revokeObjectURL = () => {};
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return {
        href: '',
        download: '',
        click() {
          const record = downloads.find(item => item.url === this.href);
          if (record) record.download = this.download;
        },
        remove() {},
      };
    },
    body: { appendChild() {} },
  };
}

function resetMeshState() {
  state.manifest = { series: [] };
  state.seriesIdx = 0;
  state.regionImgs = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.useRegions = false;
}

beforeEach(() => {
  installDownloadStubs();
  resetMeshState();
});

after(() => {
  globalThis.document = originalDocument;
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

test('exportStudyMesh reports and downloads a cloud-style region mesh bundle', async () => {
  const series = { slug: 'cloud_seg_result', width: 3, height: 3, slices: 3 };
  state.manifest = { series: [series] };
  state.regionMeta = { regions: { 7: { name: 'Thalamus' } } };
  state.regionVoxels = new Uint8Array(27);
  state.regionVoxels[(1 * 3 + 1) * 3 + 1] = 7;

  const result = exportStudyMesh(series, 'obj');

  assert.equal(result.ok, true);
  assert.equal(result.filename, 'cloud-seg-result-segmentations.obj');
  assert.deepEqual(result.labels, ['Thalamus']);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, result.filename);
  assert.match(await downloads[0].blob.text(), /o Thalamus/);
});

test('exportLabelMesh reports unavailable labels before remote slices are cached', () => {
  const series = { slug: 'cloud_seg_result', width: 3, height: 3, slices: 3 };
  state.manifest = { series: [series] };
  state.regionMeta = { regions: { 7: { name: 'Thalamus' } } };

  const result = exportLabelMesh(series, 7, 'stl');

  assert.deepEqual(result, {
    ok: false,
    message: 'Segmentation labels are still loading or unavailable for this series.',
    reason: 'labels-unavailable',
  });
  assert.equal(downloads.length, 0);
});
