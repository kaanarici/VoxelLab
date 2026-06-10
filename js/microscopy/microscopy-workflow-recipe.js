// Public entrypoint for microscopy workflow recipes. The implementation is
// split into the capture path (recipe-encode.js) and the fail-closed
// validate/apply path (recipe-replay.js); importers depend on this module only.

export {
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_V2,
} from '../sidecar-schemas.js';

export { captureMicroscopyWorkflowRecipe } from './microscopy-workflow-recipe-encode.js';

export {
  applyMicroscopyWorkflowRecipe,
  validateAnalysisOps,
  validateMicroscopyWorkflowRecipe,
} from './microscopy-workflow-recipe-replay.js';
