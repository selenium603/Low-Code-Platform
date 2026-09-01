import { randomUUID } from 'node:crypto'

import type {
  AIEditTaskState,
  AIPendingTask,
  AutonomousFallback,
  PendingConfirmationEvidence,
  NormalizedRoutingDecision
} from '../../../src/types/aiPatch'
import { deriveResumeFallbacks, pendingConfirmationEvidenceFrom } from './pendingResume'

const cleanInstruction = (message: string) => message.trim().replace(/\s+/g, ' ').slice(0, 500)
const editIntent = (intent: NormalizedRoutingDecision['intent']): intent is AIEditTaskState['intent'] => (
  intent === 'local_edit' || intent === 'large_edit' || intent === 'full_relayout'
)

export type TaskReduction =
  | {
      action: 'edit'
      task: AIEditTaskState
      pendingTask: AIPendingTask | null
      resumeFallbacks: AutonomousFallback[]
      pendingConfirmationEvidence: PendingConfirmationEvidence | null
    }
  | { action: 'question' | 'chat'; task: null; pendingTask: AIPendingTask | null }
  | { action: 'cancel'; task: null; pendingTask: null }
  | { action: 'failed'; task: null; pendingTask: AIPendingTask | null; message: string }

export const reduceTaskState = (input: {
  decision: NormalizedRoutingDecision
  pendingTask: AIPendingTask | null
  message: string
  pageId: string
  pageRevision: number
  createTaskId?: () => string
}): TaskReduction => {
  const createTask = (intent: AIEditTaskState['intent'], rootRequest: string): AIEditTaskState => ({
    taskId: input.createTaskId?.() || `task_${randomUUID()}`,
    pageId: input.pageId,
    pageRevision: input.pageRevision,
    intent,
    rootRequest: rootRequest.trim().slice(0, 1_000),
    additionalInstructions: [],
    targetComponentIds: [],
    candidateComponentIds: [],
    actionScopes: [],
    clarificationUsed: 0,
    resumedFromPending: false,
    delegatedToModel: false
  })
  if (input.decision.intent === 'question' || input.decision.relationToPending === 'question') {
    return { action: 'question', task: null, pendingTask: input.pendingTask }
  }
  if (input.decision.intent === 'chat' || input.decision.relationToPending === 'chat') {
    return { action: 'chat', task: null, pendingTask: input.pendingTask }
  }
  if (input.decision.intent === 'cancel' || input.decision.relationToPending === 'cancel') {
    return { action: 'cancel', task: null, pendingTask: null }
  }
  if (!input.pendingTask || input.decision.relationToPending === 'none' || input.decision.relationToPending === 'replace') {
    if (!editIntent(input.decision.intent)) {
      return { action: 'failed', task: null, pendingTask: null, message: '无法确定可执行的页面修改意图。' }
    }
    return {
      action: 'edit',
      task: createTask(input.decision.intent, input.message),
      pendingTask: null,
      resumeFallbacks: [],
      pendingConfirmationEvidence: null
    }
  }
  const pending = input.pendingTask
  const instruction = cleanInstruction(input.message)
  const additionalInstructions = instruction
    ? [...new Set([...pending.additionalInstructions, instruction])].slice(-6)
    : [...pending.additionalInstructions]
  return {
    action: 'edit',
    pendingTask: pending,
    resumeFallbacks: deriveResumeFallbacks({
      pendingTask: pending,
      relation: input.decision.relationToPending,
      currentMessage: input.message
    }),
    pendingConfirmationEvidence: pendingConfirmationEvidenceFrom({
      pendingTask: pending,
      relation: input.decision.relationToPending,
      currentMessage: input.message
    }),
    task: {
      taskId: pending.taskId,
      pageId: pending.pageId,
      pageRevision: pending.pageRevision,
      intent: pending.taskIntent,
      rootRequest: pending.rootRequest,
      additionalInstructions,
      targetComponentIds: [...pending.targetComponentIds],
      candidateComponentIds: [...pending.candidateComponentIds],
      actionScopes: [...(pending.actionScopes || [])],
      clarificationUsed: 1,
      resumedFromPending: true,
      delegatedToModel: input.decision.relationToPending === 'delegate'
    }
  }
}

export const effectiveTaskRequest = (task: AIEditTaskState) => [
  task.rootRequest,
  ...task.additionalInstructions.map((instruction) => `补充要求：${instruction}`),
  ...(task.delegatedToModel ? ['未指定的非破坏性视觉参数由模型按当前页面风格自主决定。'] : [])
].join('\n')
