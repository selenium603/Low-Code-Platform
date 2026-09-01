import type {
  AIEditActionScope,
  AIPendingTask,
  AutonomousFallback,
  PendingConfirmationEvidence,
  PendingRelation
} from '../../../src/types/aiPatch'
import { contextTargetIdsFor } from './editSemanticAnalysis'

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
  if (clarification.code === 'MISSING_EXECUTION_DATA') {
    return [{
      kind: 'use_model_defaults',
      allowedComponentIds: contextTargetIdsFor(input.pendingTask)
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
  signedActionScopes: input.pendingTask.actionScopes.map((action): AIEditActionScope => ({
    ...action,
    componentTypes: [...action.componentTypes],
    targetComponentIds: [...action.targetComponentIds],
    candidateComponentIds: [...action.candidateComponentIds]
  })),
  relation: input.relation,
  rawUserReply: input.currentMessage
})
