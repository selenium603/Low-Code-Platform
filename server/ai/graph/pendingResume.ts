import type {
  AIPendingTask,
  AutonomousFallback,
  PendingConfirmationEvidence,
  PendingRelation
} from '../../../src/types/aiPatch'

const UNINFORMATIVE_CONFIRM = /^(?:是|可以|行|好|好的|继续|同意|没问题|嗯)[。！!？?]*$/

export const isUninformativePendingReply = (relation: PendingRelation, message: string) => (
  relation === 'delegate' || UNINFORMATIVE_CONFIRM.test(message.trim())
)

export const deriveResumeFallbacks = (input: {
  pendingTask: AIPendingTask
  relation: PendingRelation
  currentMessage: string
}): AutonomousFallback[] => {
  if (!isUninformativePendingReply(input.relation, input.currentMessage)) return []
  const { clarification } = input.pendingTask
  if (clarification.source === 'large_edit_planner') {
    return [{ kind: 'use_conservative_plan', maxSteps: 2, operationLimit: 8 }]
  }
  if (clarification.code === 'MISSING_EXECUTION_DATA') {
    return [{
      kind: 'use_model_defaults',
      allowedComponentIds: [...input.pendingTask.targetComponentIds]
    }]
  }
  if (clarification.code === 'CONFLICTING_REQUIREMENTS') {
    return [{ kind: 'return_no_change', message: '当前要求互相冲突，本次保留现有页面。' }]
  }
  return []
}

export const pendingConfirmationEvidenceFrom = (input: {
  pendingTask: AIPendingTask
  relation: PendingRelation
  currentMessage: string
}): PendingConfirmationEvidence => ({
  clarificationCode: input.pendingTask.clarification.code,
  clarificationSource: input.pendingTask.clarification.source,
  signedTargetComponentIds: [...input.pendingTask.targetComponentIds],
  signedCandidateComponentIds: [...input.pendingTask.candidateComponentIds],
  relation: input.relation,
  rawUserReply: input.currentMessage
})
