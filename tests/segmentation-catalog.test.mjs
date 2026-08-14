import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  SEGMENTATION_ADAPTER_FIELDS,
  SEGMENTATION_ENGINES,
  getSegmentationRecommendations,
  inferSegmentationStudy,
} = await import('../js/segmentation/segmentation-catalog.js');

test('segmentation adapter contract includes model provenance and execution shape', () => {
  for (const field of ['id', 'name', 'group', 'family', 'execution', 'preprocess', 'checkpoints', 'license', 'provenance']) {
    assert.ok(SEGMENTATION_ADAPTER_FIELDS.includes(field), field);
  }
  for (const engine of SEGMENTATION_ENGINES) {
    for (const field of SEGMENTATION_ADAPTER_FIELDS) {
      assert.ok(field in engine, `${engine.id} missing ${field}`);
    }
  }
});

test('CT series recommends cloud-GPU TotalSegmentator and promptable adapters', () => {
  const series = {
    slug: 'ct_chest',
    modality: 'CT',
    bodyPart: 'CHEST',
    slices: 192,
    width: 512,
    height: 512,
  };
  const recommendations = getSegmentationRecommendations(series, { limit: 0 });
  const ids = recommendations.map((item) => item.id);
  const totalseg = recommendations.find((item) => item.id === 'totalsegmentator');
  assert.equal(inferSegmentationStudy(series).anatomy, 'chest');
  assert.equal(totalseg.status, 'can-run');
  assert.ok(totalseg.execution.includes('modal-cloud-gpu'));
  assert.ok(ids.includes('medsam'));
  assert.ok(ids.includes('sam-med3d'));
});

test('MR brain series prefers existing SynthSeg labels and tissue segmentation', () => {
  const series = {
    slug: 't1_brain',
    modality: 'MR',
    bodyPart: 'BRAIN',
    slices: 160,
    hasRegions: true,
    hasSeg: true,
    hasBrain: true,
    anatomySource: 'synthseg',
  };
  const recommendations = getSegmentationRecommendations(series, { limit: 0 });
  assert.equal(recommendations[0].id, 'synthseg');
  assert.equal(recommendations[0].status, 'available');
  assert.equal(recommendations.find((item) => item.id === 'tissue-deep-atropos').status, 'available');
});

test('microscopy-like series surfaces Fiji-style and bioimage adapters', () => {
  const series = {
    slug: 'ome_cells',
    modality: 'microscopy',
    description: 'OME-TIFF fluorescence nuclei stack',
    channels: 2,
    slices: 12,
  };
  const ids = getSegmentationRecommendations(series, { limit: 0 }).map((item) => item.id);
  assert.ok(ids.includes('cellpose-sam'));
  assert.ok(ids.includes('stardist'));
  assert.ok(ids.includes('bioimageio'));
  assert.ok(ids.includes('ilastik-labkit-weka'));
});
