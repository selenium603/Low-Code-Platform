import type {
  AIEditTaskState,
  AIPendingTask,
  AutonomousFallback,
  ClarificationProposal
} from '../../../src/types/aiPatch'
import { signPendingTask } from './pendingTaskIntegrity'

export type ClarificationBrokerDecision =
  | { type: 'continue'; appliedFallbacks: AutonomousFallback[] }
  | { type: 'ask'; question: string; pendingTask: AIPendingTask }
  | { type: 'no_change'; message: string }
  | { type: 'execution_failed'; code: string; message: string; retryable: boolean }

const priority: Record<ClarificationProposal['code'], number> = {
  DELETION_AUTH_REQUIRED: 0,
  CONFLICTING_REQUIREMENTS: 1,
  TARGET_AMBIGUOUS: 2,
  MISSING_EXECUTION_DATA: 3,
  GEOMETRY_RELAYOUT_AUTH_REQUIRED: 4
}

const sortedProposals = (proposals: ClarificationProposal[]) => [...proposals].sort((left, right) => (
  Number(right.blocking) - Number(left.blocking)
  || priority[left.code] - priority[right.code]
  || right.affectedComponentCount - left.affectedComponentCount
  || left.proposalId.localeCompare(right.proposalId)
))

const checkedFallback = (proposal: ClarificationProposal): ClarificationBrokerDecision | AutonomousFallback => {
  const fallback = proposal.fallback
  if (fallback.kind === 'select_best_candidate' && !fallback.orderedCandidateIds.length) {
    return {
      type: 'execution_failed',
      code: 'NO_SAFE_TARGET_CANDIDATE',
      message: '无法确定安全的目标组件，本次未执行修改。',
      retryable: true
    }
  }
  if (fallback.kind === 'return_no_change') return { type: 'no_change', message: fallback.message }
  return fallback
}

export const clarificationBroker = (input: {
  task: AIEditTaskState
  proposals: ClarificationProposal[]
  integritySecret: string
  handledProposalIds?: Set<string>
}): ClarificationBrokerDecision => {
  const proposals = sortedProposals(input.proposals)
  if (!proposals.length) return { type: 'continue', appliedFallbacks: [] }
  const repeated = proposals.find((proposal) => input.handledProposalIds?.has(proposal.proposalId))
  if (repeated) return { type: 'no_change', message: '同一安全约束在本轮恢复后再次出现，本次未提交页面修改。' }
  const primary = proposals[0]!
  if (input.task.clarificationUsed === 0) {
    const unsigned: Omit<AIPendingTask, 'integrityToken'> = {
      schemaVersion: 3,
      taskId: input.task.taskId,
      pageId: input.task.pageId,
      pageRevision: input.task.pageRevision,
      status: 'awaiting_user',
      taskIntent: input.task.intent,
      rootRequest: input.task.rootRequest,
      additionalInstructions: [...input.task.additionalInstructions],
      actionScopes: [...input.task.actionScopes],
      clarification: {
        used: 1,
        max: 1,
        code: primary.code,
        question: primary.question.slice(0, 500),
        source: primary.source
      }
    }
    return {
      type: 'ask',
      question: unsigned.clarification.question,
      pendingTask: signPendingTask(unsigned, input.integritySecret)
    }
  }
  const appliedFallbacks: AutonomousFallback[] = []
  for (const proposal of proposals) {
    const checked = checkedFallback(proposal)
    if ('type' in checked) return checked
    appliedFallbacks.push(checked)
  }
  return { type: 'continue', appliedFallbacks }
}
