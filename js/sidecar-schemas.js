export const ROI_RESULTS_BUNDLE_SCHEMA = 'voxellab.roiResults.v1';
export const MICROSCOPY_WORKFLOW_RECIPE_SCHEMA = 'voxellab.microscopyWorkflowRecipe.v1';
export const MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_V2 = 'voxellab.microscopyWorkflowRecipe.v2';
export const MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS = Object.freeze([
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_V2,
]);
export const SOURCE_MANIFEST_LABEL = 'VoxelLab source manifest';
export const INVALID_JSON_SIDECAR_REASON = 'invalid_json_sidecar';
export const UNRECOGNIZED_JSON_SIDECAR_REASON = 'unrecognized_json_sidecar';
export const PATH_UNAVAILABLE_REASON = 'path_unavailable';

const UNSUPPORTED_REASON_LABELS = new Map([
  [INVALID_JSON_SIDECAR_REASON, 'invalid JSON sidecar'],
  [UNRECOGNIZED_JSON_SIDECAR_REASON, 'unrecognized JSON sidecar'],
  [PATH_UNAVAILABLE_REASON, 'not found or unreadable'],
]);

export function sidecarFormatLabelForSchema(schema) {
  const value = String(schema || '');
  if (value === ROI_RESULTS_BUNDLE_SCHEMA) return 'ROI results';
  if (MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS.includes(value)) return 'Workflow recipe';
  return '';
}

export function sidecarUnsupportedReasonLabel(reason) {
  return UNSUPPORTED_REASON_LABELS.get(String(reason || '')) || '';
}

function compactSchemaText(schema) {
  const value = String(schema || '').replace(/\s+/g, ' ').trim();
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

export function sidecarUnsupportedDescription(itemOrReason) {
  const item = typeof itemOrReason === 'object' && itemOrReason ? itemOrReason : null;
  const reason = item ? item.reason || item.skipReason : itemOrReason;
  const label = sidecarUnsupportedReasonLabel(reason);
  const schema = item && reason === UNRECOGNIZED_JSON_SIDECAR_REASON
    ? compactSchemaText(item.schema)
    : '';
  return label && schema ? `${label} schema: ${schema}` : label;
}

export function classifyJsonSidecarText(text) {
  try {
    const payload = JSON.parse(String(text || ''));
    const schema = String(payload?.schema || '');
    if (payload?.sourceKind === 'projection' || payload?.sourceKind === 'ultrasound') {
      return {
        schema,
        formatLabel: SOURCE_MANIFEST_LABEL,
        reason: UNRECOGNIZED_JSON_SIDECAR_REASON,
      };
    }
    return {
      schema,
      formatLabel: sidecarFormatLabelForSchema(schema),
      reason: UNRECOGNIZED_JSON_SIDECAR_REASON,
    };
  } catch {
    return { schema: '', formatLabel: '', reason: INVALID_JSON_SIDECAR_REASON };
  }
}
