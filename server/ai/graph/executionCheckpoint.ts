import type { ExecutionCheckpoint } from '../../../src/types/aiPatch'
import type { PageEditStateValue } from './pageEditState'

export const createExecutionCheckpoint = (
  state: Pick<PageEditStateValue,
    | 'intent'
    | 'stepIndex'
    | 'modelAttempt'
    | 'repairAttempt'
    | 'noOpRetry'
    | 'geometryRepairAttempt'
    | 'needsRelocate'
    | 'previousPatch'
    | 'validationError'>,
  resumeNode: ExecutionCheckpoint['resumeNode']
): ExecutionCheckpoint => ({
  branch: state.intent === 'large_edit' || state.intent === 'full_relayout' ? state.intent : 'local_edit',
  resumeNode,
  stepIndex: state.stepIndex,
  groupIndex: state.intent === 'full_relayout' ? state.stepIndex : 0,
  modelAttempt: state.modelAttempt,
  repairAttempt: state.repairAttempt,
  noOpRetry: state.noOpRetry,
  geometryRepairAttempt: state.geometryRepairAttempt,
  needsRelocate: state.needsRelocate,
  previousPatch: state.previousPatch,
  validationError: state.validationError
})

export const checkpointUpdate = (checkpoint: ExecutionCheckpoint) => ({
  stepIndex: checkpoint.stepIndex,
  modelAttempt: checkpoint.modelAttempt,
  repairAttempt: checkpoint.repairAttempt,
  noOpRetry: checkpoint.noOpRetry,
  geometryRepairAttempt: checkpoint.geometryRepairAttempt,
  needsRelocate: checkpoint.needsRelocate,
  previousPatch: checkpoint.previousPatch,
  validationError: checkpoint.validationError
})
