const MEDICAL_MODALITIES = new Set(['CT', 'MR', 'MRI', 'MR_LIKE', 'PT', 'PET', 'US', 'XA', 'DX']);
const MR_MODALITIES = new Set(['MR', 'MRI', 'MR_LIKE']);
const MICROSCOPY_HINT = /(OME|TIFF|CZI|ND2|LIF|ZARR|MICROSC|CHANNEL|FLUORESC|HISTO|CELL|NUCLE)/i;

export const SEGMENTATION_ADAPTER_FIELDS = Object.freeze([
  'id',
  'name',
  'group',
  'family',
  'modalities',
  'dimensions',
  'interaction',
  'execution',
  'inputs',
  'outputs',
  'preprocess',
  'checkpoints',
  'license',
  'provenance',
]);

export const SEGMENTATION_ENGINES = Object.freeze([
  {
    id: 'totalsegmentator',
    name: 'TotalSegmentator',
    group: 'Organs',
    family: 'Anatomical labels',
    status: 'integrated',
    domains: ['medical'],
    modalities: ['CT', 'MR'],
    anatomy: ['body', 'chest', 'abdomen', 'pelvis', 'head', 'neck', 'limb'],
    dimensions: ['3d-volume'],
    interaction: 'automatic',
    execution: ['modal-cloud-gpu', 'local-python'],
    inputs: ['DICOM volume', 'NIfTI volume'],
    outputs: ['labelmap', 'region-volumes'],
    preprocess: ['orientation', 'resample', 'roi-subset'],
    checkpoints: 'auto-download',
    license: { code: 'Apache-2.0', weights: 'task-specific', data: 'task-specific' },
    provenance: 'wasserth/TotalSegmentator',
    command: 'npm run modal:submit',
    note: 'Best current CT/MR automatic anatomy path; cloud GPU can run ROI subsets.',
  },
  {
    id: 'synthseg',
    name: 'SynthSeg',
    group: 'Brain',
    family: 'Brain parcellation',
    status: 'integrated',
    domains: ['medical'],
    modalities: ['MR', 'MRI', 'MR_LIKE'],
    anatomy: ['brain', 'head'],
    dimensions: ['3d-volume'],
    interaction: 'automatic',
    execution: ['local-python', 'future-cloud-gpu'],
    inputs: ['MRI volume'],
    outputs: ['labelmap', 'region-volumes'],
    preprocess: ['orientation', 'contrast-agnostic-normalization'],
    checkpoints: 'FreeSurfer or SynthSeg runtime',
    license: { code: 'upstream-specific', weights: 'upstream-specific', data: 'upstream-specific' },
    provenance: 'BBillot/SynthSeg',
    command: 'python3 python/synthseg_pipeline.py',
    note: 'Strong MR brain parcellation candidate when geometry is volume-safe.',
  },
  {
    id: 'tissue-deep-atropos',
    name: 'Deep Atropos / tissue classes',
    group: 'Brain',
    family: 'Brain tissue',
    status: 'integrated',
    domains: ['medical'],
    modalities: ['MR', 'MRI', 'MR_LIKE'],
    anatomy: ['brain', 'head'],
    dimensions: ['3d-volume'],
    interaction: 'automatic',
    execution: ['local-python'],
    inputs: ['brain mask', 'MRI volume'],
    outputs: ['tissue-mask', 'tissue-volumes'],
    preprocess: ['brain-mask', 'intensity-normalization'],
    checkpoints: 'ANTsPyNet when installed; GMM fallback',
    license: { code: 'upstream-specific', weights: 'upstream-specific', data: 'upstream-specific' },
    provenance: 'ANTsPyNet / local fallback',
    command: 'python3 python/tissue_seg_atropos.py',
    note: 'Useful CSF/GM/WM overlay; not anatomical organ segmentation.',
  },
  {
    id: 'slimsam',
    name: 'SlimSAM click-to-segment',
    group: 'Promptable',
    family: 'Interactive prompt',
    status: 'integrated',
    domains: ['medical', 'microscopy'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'US', 'microscopy'],
    anatomy: ['any'],
    dimensions: ['2d-slice'],
    interaction: 'single-click',
    execution: ['browser-onnx', 'precomputed-sidecars'],
    inputs: ['2D slice', 'SAM embedding sidecars'],
    outputs: ['binary-mask-preview'],
    preprocess: ['per-slice-embedding'],
    checkpoints: 'local ONNX decoder + sidecars',
    license: { code: 'upstream-specific', weights: 'upstream-specific', data: 'user-generated-sidecars' },
    provenance: 'SlimSAM/SAM sidecar path',
    command: 'python3 python/slimsam_embed.py',
    note: 'Browser-side prompt preview once per-slice embeddings exist.',
  },
  {
    id: 'dicom-seg-import',
    name: 'DICOM SEG import',
    group: 'Imported',
    family: 'Imported labels',
    status: 'integrated',
    domains: ['medical'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'PT', 'PET'],
    anatomy: ['any'],
    dimensions: ['3d-volume', '2d-slice'],
    interaction: 'imported',
    execution: ['local-import'],
    inputs: ['DICOM SEG'],
    outputs: ['labelmap', 'region-volumes'],
    preprocess: ['geometry-validation'],
    checkpoints: 'external',
    license: { code: 'n/a', weights: 'n/a', data: 'source-dependent' },
    provenance: 'DICOM SEG source file',
    note: 'Uses externally generated segmentations with geometry checks.',
  },
  {
    id: 'medsam',
    name: 'MedSAM',
    group: 'Promptable',
    family: 'Interactive medical SAM',
    status: 'adapter-planned',
    domains: ['medical'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'US'],
    anatomy: ['any'],
    dimensions: ['2d-slice'],
    interaction: 'box-and-click',
    execution: ['modal-cloud-gpu', 'local-python'],
    inputs: ['2D slice', 'box prompt', 'point prompts'],
    outputs: ['binary-mask', 'roi'],
    preprocess: ['windowing', 'normalization', 'prompt-transform'],
    checkpoints: 'BYO or configured checkpoint',
    license: { code: 'Apache-2.0', weights: 'checkpoint-specific', data: 'checkpoint-specific' },
    provenance: 'bowang-lab/MedSAM',
    note: 'Next promptable medical-image adapter; should support positive/negative refinement.',
  },
  {
    id: 'sam-med3d',
    name: 'SAM-Med3D',
    group: 'Promptable',
    family: 'Promptable volume model',
    status: 'adapter-planned',
    domains: ['medical'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE'],
    anatomy: ['any'],
    dimensions: ['3d-volume'],
    interaction: 'promptable',
    execution: ['modal-cloud-gpu'],
    inputs: ['3D volume', 'point prompts'],
    outputs: ['labelmap', 'binary-mask'],
    preprocess: ['resample', 'normalize', 'prompt-transform'],
    checkpoints: 'BYO or configured checkpoint',
    license: { code: 'Apache-2.0', weights: 'checkpoint-specific', data: 'checkpoint-specific' },
    provenance: 'uni-medical/SAM-Med3D',
    note: 'Candidate for true volumetric prompting instead of slice-only masks.',
  },
  {
    id: 'monai-bundle',
    name: 'MONAI bundle',
    group: 'Model zoo',
    family: 'Medical model zoo',
    status: 'adapter-planned',
    domains: ['medical'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'PT', 'PET'],
    anatomy: ['task-specific'],
    dimensions: ['3d-volume', '2d-slice'],
    interaction: 'automatic',
    execution: ['modal-cloud-gpu', 'local-python'],
    inputs: ['bundle-defined'],
    outputs: ['labelmap', 'probability-map'],
    preprocess: ['bundle-defined'],
    checkpoints: 'MONAI bundle',
    license: { code: 'bundle-specific', weights: 'bundle-specific', data: 'bundle-specific' },
    provenance: 'Project-MONAI/model-zoo',
    note: 'Adapter should read bundle metadata before offering a model.',
  },
  {
    id: 'nnunet',
    name: 'nnU-Net',
    group: 'Model zoo',
    family: 'Custom biomedical segmentation',
    status: 'adapter-planned',
    domains: ['medical', 'microscopy'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'microscopy'],
    anatomy: ['task-specific'],
    dimensions: ['3d-volume', '2d-slice'],
    interaction: 'automatic',
    execution: ['modal-cloud-gpu', 'local-python'],
    inputs: ['task-defined volume or image set'],
    outputs: ['labelmap', 'probability-map'],
    preprocess: ['task-plan', 'resample', 'normalize'],
    checkpoints: 'BYO trained nnU-Net model',
    license: { code: 'Apache-2.0', weights: 'model-specific', data: 'model-specific' },
    provenance: 'MIC-DKFZ/nnUNet',
    note: 'Best adapter shape for user-supplied trained models and challenge models.',
  },
  {
    id: 'cellpose-sam',
    name: 'Cellpose / Cellpose-SAM',
    group: 'Cells/Nuclei',
    family: 'Cell and nuclei',
    status: 'adapter-planned',
    domains: ['microscopy'],
    modalities: ['microscopy'],
    anatomy: ['cell', 'nucleus'],
    dimensions: ['2d-slice', '3d-volume'],
    interaction: 'automatic',
    execution: ['modal-cloud-gpu', 'local-python'],
    inputs: ['microscopy image or stack', 'channel selection'],
    outputs: ['instance-mask', 'roi'],
    preprocess: ['channel-select', 'normalize', 'tile'],
    checkpoints: 'built-in or BYO model',
    license: { code: 'BSD-3-Clause', weights: 'model-specific', data: 'model-specific' },
    provenance: 'MouseLand/cellpose',
    note: 'Primary microscopy cell/nucleus adapter candidate.',
  },
  {
    id: 'stardist',
    name: 'StarDist',
    group: 'Cells/Nuclei',
    family: 'Microscopy nuclei',
    status: 'adapter-planned',
    domains: ['microscopy'],
    modalities: ['microscopy'],
    anatomy: ['nucleus', 'cell'],
    dimensions: ['2d-slice'],
    interaction: 'automatic',
    execution: ['local-python', 'modal-cloud-gpu'],
    inputs: ['microscopy image', 'model selection'],
    outputs: ['instance-mask', 'roi'],
    preprocess: ['normalize', 'tile', 'anisotropy-handling'],
    checkpoints: 'built-in or BYO model',
    license: { code: 'BSD-3-Clause', weights: 'model-specific', data: 'model-specific' },
    provenance: 'stardist/stardist',
    note: 'Strong for star-convex nuclei/cells; should be offered only for microscopy-like series.',
  },
  {
    id: 'bioimageio',
    name: 'BioImage.IO / DeepImageJ models',
    group: 'Model zoo',
    family: 'Bioimage model zoo',
    status: 'adapter-planned',
    domains: ['microscopy'],
    modalities: ['microscopy'],
    anatomy: ['task-specific'],
    dimensions: ['2d-slice', '3d-volume'],
    interaction: 'automatic',
    execution: ['local-python', 'modal-cloud-gpu'],
    inputs: ['model-card-defined'],
    outputs: ['labelmap', 'probability-map', 'instance-mask'],
    preprocess: ['model-card-defined'],
    checkpoints: 'BioImage.IO model',
    license: { code: 'model-specific', weights: 'model-specific', data: 'model-specific' },
    provenance: 'bioimage.io / deepImageJ',
    note: 'Fiji-like model-zoo adapter; requires model-card capability parsing.',
  },
  {
    id: 'ilastik-labkit-weka',
    name: 'Trainable pixel classifiers',
    group: 'Trainable',
    family: 'Fiji-style training',
    status: 'adapter-planned',
    domains: ['microscopy'],
    modalities: ['microscopy'],
    anatomy: ['task-specific'],
    dimensions: ['2d-slice', '3d-volume'],
    interaction: 'trainable',
    execution: ['local-python', 'external-plugin'],
    inputs: ['image stack', 'user labels', 'trained project'],
    outputs: ['labelmap', 'probability-map'],
    preprocess: ['features', 'channel-select', 'block-processing'],
    checkpoints: 'trained classifier/project',
    license: { code: 'upstream-specific', weights: 'user-trained', data: 'user-trained' },
    provenance: 'Labkit / Weka / ilastik family',
    note: 'Matches Fiji/Labkit/Weka workflows: draw labels, train/apply, export.',
  },
  {
    id: 'morphology-watershed',
    name: 'Morphology / watershed',
    group: 'Classical morphology',
    family: 'Classical segmentation',
    status: 'adapter-planned',
    domains: ['medical', 'microscopy'],
    modalities: ['CT', 'MR', 'MRI', 'MR_LIKE', 'microscopy'],
    anatomy: ['task-specific'],
    dimensions: ['2d-slice', '3d-volume'],
    interaction: 'parameterized',
    execution: ['local-python', 'future-gpu'],
    inputs: ['image stack', 'threshold/seed parameters'],
    outputs: ['labelmap', 'roi'],
    preprocess: ['filter', 'threshold', 'distance-transform', 'watershed'],
    checkpoints: 'none',
    license: { code: 'local/open-source', weights: 'none', data: 'n/a' },
    provenance: 'MorphoLibJ-style workflow',
    note: 'Useful Fiji-style non-deep baseline for threshold, watershed, morphology chains.',
  },
]);

export function inferSegmentationStudy(series = {}) {
  const modality = normalizeModality(series.modality || series.Modality);
  const bodyPart = normalizeToken(series.bodyPart || series.bodyPartExamined || series.anatomy || '');
  const text = [
    series.name,
    series.description,
    series.sequence,
    series.source,
    series.kind,
    modality,
    bodyPart,
  ].filter(Boolean).join(' ');
  const microscopy = isMicroscopySeries(series, text);
  const nucleus = /\b(NUCLEI|NUCLEUS|DAPI)\b/i.test(text);
  const cell = /\b(CELL|CELLS|CYTOPLASM|MEMBRANE)\b/i.test(text);
  const brain = /\b(BRAIN|HEAD|SKULL|T1|T2|FLAIR|MPRAGE|DWI|ADC)\b/i.test(text) || ['BRAIN', 'HEAD'].includes(bodyPart);
  const chest = /\b(CHEST|LUNG|THORAX|CARDIAC|HEART)\b/i.test(text) || bodyPart === 'CHEST';
  const abdomen = /\b(ABDOMEN|PELVIS|LIVER|KIDNEY|SPLEEN)\b/i.test(text);
  const slices = Number(series.slices || series.numSlices || 0);
  return {
    modality,
    bodyPart,
    domain: microscopy ? 'microscopy' : MEDICAL_MODALITIES.has(modality) ? 'medical' : 'unknown',
    anatomy: nucleus ? 'nucleus' : cell ? 'cell' : brain ? 'brain' : chest ? 'chest' : abdomen ? 'abdomen' : bodyPart ? bodyPart.toLowerCase() : 'unknown',
    dimensions: slices > 1 ? '3d-volume' : '2d-slice',
    slices,
  };
}

export function getSegmentationRecommendations(series, options = {}) {
  if (!series) return [];
  const study = inferSegmentationStudy(series);
  const existing = existingSegmentationOutputs(series);
  const slimsamInfo = options.slimsamInfo || null;
  const rows = SEGMENTATION_ENGINES
    .map((engine) => recommendationForEngine(engine, series, study, existing, slimsamInfo))
    .filter((row) => row.relevant || row.status === 'available')
    .sort((a, b) => b.score - a.score || statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
  const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : 8;
  return limit ? rows.slice(0, limit) : rows;
}

export function existingSegmentationOutputs(series = {}) {
  const out = [];
  if (series.hasRegions) {
    const source = String(series.anatomySource || '').toLowerCase();
    out.push({
      kind: 'regions',
      engineId: source === 'totalseg' ? 'totalsegmentator' : source === 'synthseg' ? 'synthseg' : 'dicom-seg-import',
      label: sourceLabel(source) || 'Anatomical regions',
    });
  }
  if (series.hasSeg) {
    out.push({
      kind: 'tissue',
      engineId: 'tissue-deep-atropos',
      label: 'Tissue mask',
    });
  }
  if (series.hasMaskRaw || series.hasBrain) {
    out.push({
      kind: 'mask',
      engineId: 'tissue-deep-atropos',
      label: series.hasBrain ? 'Brain mask' : 'Mask volume',
    });
  }
  return out;
}

function recommendationForEngine(engine, series, study, existing, slimsamInfo) {
  const domainMatch = engine.domains.includes(study.domain);
  const modalityMatch = engine.modalities.includes(study.modality) ||
    (study.domain === 'microscopy' && engine.modalities.includes('microscopy')) ||
    (MR_MODALITIES.has(study.modality) && engine.modalities.some((m) => MR_MODALITIES.has(m)));
  const anatomyMatch = engine.anatomy.includes('any') ||
    engine.anatomy.includes('task-specific') ||
    engine.anatomy.includes(study.anatomy) ||
    (study.anatomy === 'brain' && engine.anatomy.includes('head')) ||
    (['chest', 'abdomen'].includes(study.anatomy) && engine.anatomy.includes('body'));
  const dimensionMatch = engine.dimensions.includes(study.dimensions) ||
    (study.dimensions === '2d-slice' && engine.dimensions.includes('3d-volume')) ||
    (study.dimensions === '3d-volume' && engine.dimensions.includes('2d-slice'));
  const existingOutput = existing.find((item) => item.engineId === engine.id);
  const status = availabilityStatus(engine, series, study, existingOutput, slimsamInfo);
  const relevant = domainMatch && modalityMatch && anatomyMatch && dimensionMatch;
  let score = 0;
  if (existingOutput) score += 100;
  if (existingOutput?.kind === 'regions') score += 10;
  if (status === 'ready') score += 80;
  if (status === 'can-run') score += 60;
  if (status === 'needs-sidecars') score += 45;
  if (engine.status === 'adapter-planned') score += 20;
  if (domainMatch) score += 12;
  if (modalityMatch) score += 10;
  if (anatomyMatch) score += 8;
  if (dimensionMatch) score += 4;
  if (engine.execution.includes('modal-cloud-gpu')) score += 2;
  return {
    id: engine.id,
    name: engine.name,
    group: engine.group,
    family: engine.family,
    status,
    statusLabel: statusLabel(status),
    relevant,
    score,
    note: statusNote(engine, series, study, existingOutput, slimsamInfo),
    command: engine.command || '',
    execution: engine.execution,
    runtime: engine.execution,
    outputs: engine.outputs,
    interaction: engine.interaction,
    preprocess: engine.preprocess,
    checkpoints: engine.checkpoints,
    license: engine.license,
    provenance: engine.provenance,
  };
}

function availabilityStatus(engine, series, study, existingOutput, slimsamInfo) {
  if (existingOutput) return 'available';
  if (engine.id === 'slimsam') {
    if (slimsamInfo?.available) return 'ready';
    if (study.dimensions === '2d-slice' || study.slices > 0) return 'needs-sidecars';
  }
  if (engine.id === 'totalsegmentator' && ['CT', 'MR', 'MRI', 'MR_LIKE'].includes(study.modality)) return 'can-run';
  if (engine.id === 'synthseg' && study.anatomy === 'brain' && MR_MODALITIES.has(study.modality)) return 'can-run';
  if (engine.id === 'tissue-deep-atropos' && study.anatomy === 'brain' && MR_MODALITIES.has(study.modality)) {
    return series.hasBrain ? 'can-run' : 'needs-prerequisite';
  }
  if (engine.status === 'adapter-planned') return 'adapter-planned';
  return 'not-available';
}

function statusNote(engine, series, study, existingOutput, slimsamInfo) {
  if (existingOutput) return `${existingOutput.label} is already attached to this series.`;
  if (engine.id === 'slimsam' && slimsamInfo && !slimsamInfo.available) {
    if (slimsamInfo.reason === 'geometry_mismatch') return 'Sidecars exist but do not match this series geometry.';
    return 'Generate SAM sidecars first, then use click-to-segment.';
  }
  if (engine.id === 'tissue-deep-atropos' && !series.hasBrain && study.anatomy === 'brain') {
    return 'Needs a brain mask before tissue classes can run.';
  }
  return engine.note;
}

function statusRank(status) {
  return {
    available: 0,
    ready: 1,
    'can-run': 2,
    'needs-sidecars': 3,
    'needs-prerequisite': 4,
    'adapter-planned': 5,
    'not-available': 6,
  }[status] ?? 9;
}

function statusLabel(status) {
  return {
    available: 'Available',
    ready: 'Ready',
    'can-run': 'Can run',
    'needs-sidecars': 'Needs sidecars',
    'needs-prerequisite': 'Needs prerequisite',
    'adapter-planned': 'Adapter planned',
    'not-available': 'Not available',
  }[status] || 'Unknown';
}

function sourceLabel(source) {
  return {
    totalseg: 'TotalSegmentator labels',
    synthseg: 'SynthSeg labels',
    heuristic: 'Heuristic regions',
  }[source] || '';
}

function normalizeModality(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'MRI') return 'MR';
  return raw || 'UNKNOWN';
}

function normalizeToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function isMicroscopySeries(series, text) {
  if (String(series.modality || '').toLowerCase() === 'microscopy') return true;
  if (series.channels || series.timepoints || series.ome || series.pixelSizeMicrons) return true;
  return MICROSCOPY_HINT.test(text);
}
