import type {
  AIEditTaskState,
  AutonomousFallback,
  DeleteAuthorization,
  ExecutionPolicy,
  PendingConfirmationEvidence,
  UserAuthorizationEvidence
} from '../../../src/types/aiPatch'
import { analyzeEditActions } from './editActionAnalysis'
import { deleteTargetIdsFor } from './editSemanticAnalysis'

const EXACT_DELETE_CONFIRM = /^(?:是|可以|行|好的|继续|同意|没问题)[。！!？?]*$/
const EXACT_DELETE_REJECT = /^(?:不|不可以|不行|不同意|不要|不允许|不能|保留|别删)[。！!？?]*$/

export const hasExplicitDeleteAuthorization = (evidence: UserAuthorizationEvidence) => {
  const messages = [evidence.rootUserMessage, ...evidence.additionalUserMessages]
  const analyses = messages.map(analyzeEditActions)
  return analyses.some((analysis) => analysis.mentions.some((mention) => mention.kind === 'delete' && !mention.negated))
}

const deriveDeleteAuthorization = (input: {
  task: AIEditTaskState
  authorizationEvidence: UserAuthorizationEvidence
  pendingConfirmationEvidence?: PendingConfirmationEvidence | null
}): DeleteAuthorization => {
  const reply = input.pendingConfirmationEvidence?.rawUserReply.trim() || ''
  if (EXACT_DELETE_REJECT.test(reply)) return { authorized: false, source: 'none', componentIds: [] }

  const signedConfirmation = input.pendingConfirmationEvidence?.clarificationCode === 'DELETION_AUTH_REQUIRED'
    && input.pendingConfirmationEvidence.relation === 'answer'
    && EXACT_DELETE_CONFIRM.test(reply)
    && deleteTargetIdsFor({ actionScopes: input.pendingConfirmationEvidence.signedActionScopes }).length > 0
  if (signedConfirmation && input.pendingConfirmationEvidence) {
    const componentIds = deleteTargetIdsFor({ actionScopes: input.pendingConfirmationEvidence.signedActionScopes }).slice(0, 12)
    return { authorized: true, source: 'signed_pending_confirmation', componentIds }
  }

  const scopedDeleteIds = deleteTargetIdsFor(input.task)
  if (hasExplicitDeleteAuthorization(input.authorizationEvidence) && scopedDeleteIds.length) {
    return {
      authorized: true,
      source: 'explicit_user_request',
      componentIds: scopedDeleteIds.slice(0, 12)
    }
  }
  return { authorized: false, source: 'none', componentIds: [] }
}

export const deriveExecutionPolicy = (input: {
  task: AIEditTaskState
  authorizationEvidence: UserAuthorizationEvidence
  appliedFallbacks?: AutonomousFallback[]
  pendingConfirmationEvidence?: PendingConfirmationEvidence | null
}): ExecutionPolicy => {
  const fallbacks = input.appliedFallbacks || []
  const geometryFallback = fallbacks.find((fallback): fallback is Extract<AutonomousFallback, { kind: 'limit_geometry_scope' }> => (
    fallback.kind === 'limit_geometry_scope'
  ))
  const executionLimits = fallbacks.filter((fallback): fallback is Extract<AutonomousFallback, { kind: 'limit_execution' }> => (
    fallback.kind === 'limit_execution'
  ))
  const operationLimit = executionLimits.reduce((limit, fallback) => Math.min(limit, fallback.operationLimit), 12)
  const deleteAuthorization = deriveDeleteAuthorization(input)
  return {
    canClarify: input.task.clarificationUsed === 0,
    useModelDefaults: input.task.delegatedToModel || fallbacks.some((fallback) => fallback.kind === 'use_model_defaults'),
    allowDelete: deleteAuthorization.authorized,
    deleteAuthorization,
    allowRegionalRelayout: Boolean(geometryFallback),
    maxAffectedComponents: geometryFallback?.maxAffectedComponents || 12,
    operationLimit: Math.max(1, operationLimit)
  }
}
