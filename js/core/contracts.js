// Browser modules cannot JSON-import schemas/ over HTTP; dumpContractEnums()
// must stay identical to schemas/enums.json (scripts/check_contract_enums.mjs).

export const ORTHONORMAL_TOLERANCE = 0.001;
export const SLICE_AXIS_ALIGNMENT_MIN = 0.9999;

export const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'IO', 'MG', 'PX', 'RF', 'XA']);
export const PROJECTION_KINDS = new Set(['cbct', 'parallel-beam', 'tomosynthesis', 'unknown', 'xray']);
export const PROJECTION_STATUSES = new Set([
  'reconstructed',
  'reconstruction-failed',
  'reconstruction-pending',
  'requires-calibration',
  'requires-reconstruction',
]);
export const GEOMETRY_KIND_CAPABILITY = Object.freeze({
  derivedVolume: 'display-volume',
  imageStack: '2d-only',
  microscopyStack: '2d-only',
  projectionSet: 'requires-reconstruction',
  singleImage: '2d-only',
  singleProjection: '2d-only',
  ultrasoundSource: 'requires-reconstruction',
  volumeStack: 'display-volume',
});
export const DERIVED_KINDS = new Set(['derived-volume', 'registration', 'rtdose', 'rtstruct', 'seg', 'sr']);
export const SOURCE_RECORD_VERSIONS = new Set([1, 2]);
export const PROJECTION_GEOMETRIES = new Set(['circular-cbct', 'limited-angle-tomo', 'parallel-beam-stack']);
export const ULTRASOUND_MODES = new Set(['stacked-sector', 'tracked-freehand-sector']);
export const ULTRASOUND_PROBE_GEOMETRIES = new Set(['curvilinear', 'linear', 'sector']);
export const REGISTRATION_TRANSFORMS = new Set(['rigid', 'translation']);

export function parallelBeamCoverageDeg(angles = []) {
  if (angles.length < 2) return 0;
  const normalized = [...angles].map((angle) => ((Number(angle) % 360) + 360) % 360).sort((a, b) => a - b);
  const gaps = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    gaps.push(normalized[index + 1] - normalized[index]);
  }
  gaps.push(normalized[0] + 360 - normalized[normalized.length - 1]);
  return 360 - Math.max(...gaps);
}

export function sourceRecordVersion(payload) {
  if (payload == null || Object(payload) !== payload) return 0;
  const raw = payload.sourceRecordVersion ?? payload.version ?? 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || !SOURCE_RECORD_VERSIONS.has(value)) return 0;
  return value;
}

export function dumpContractEnums() {
  return {
    orthonormalTolerance: ORTHONORMAL_TOLERANCE,
    sliceAxisAlignmentMin: SLICE_AXIS_ALIGNMENT_MIN,
    projectionModalities: [...PROJECTION_MODALITIES].sort(),
    projectionKinds: [...PROJECTION_KINDS].sort(),
    projectionStatuses: [...PROJECTION_STATUSES].sort(),
    geometryKindCapability: { ...GEOMETRY_KIND_CAPABILITY },
    derivedKinds: [...DERIVED_KINDS].sort(),
    sourceRecordVersions: [...SOURCE_RECORD_VERSIONS].sort((a, b) => a - b),
    projectionGeometries: [...PROJECTION_GEOMETRIES].sort(),
    ultrasoundModes: [...ULTRASOUND_MODES].sort(),
    ultrasoundProbeGeometries: [...ULTRASOUND_PROBE_GEOMETRIES].sort(),
    registrationTransforms: [...REGISTRATION_TRANSFORMS].sort(),
  };
}
