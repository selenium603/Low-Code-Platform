import { StateSchema } from '@langchain/langgraph'
import { z } from 'zod'

import type { RagComponentIndexItem } from '../../componentRag'
import type {
  AIConversationMemory,
  AIConversationMessage,
  AIEditTaskState,
  AIPendingTask,
  AutonomousFallback,
  ClarificationProposal,
  ExecutionCheckpoint,
  ExecutionPolicy,
  ModelRoutingDecision,
  PageEditGraphResult as SharedPageEditGraphResult,
  PendingConfirmationEvidence,
  AIPageEditPlan,
  AIPagePatch,
  UserAuthorizationEvidence
} from '../../../src/types/aiPatch'
import type { PageData } from '../../../src/types'

export type PageEditIntent = 'local_edit' | 'large_edit' | 'full_relayout' | 'question' | 'chat' | 'cancel' | 'unresolved'
export type PageEditRoutingSource = 'rule' | 'context' | 'tool'
export type PageEditRoutingTraceStep = {
  source: 'rule' | 'context' | 'tool'
  outcome: 'resolved' | 'fallback' | 'error'
  reason: string
}
export type PageEditStatus = 'pending' | 'running' | 'routed' | 'completed' | 'clarification' | 'error'

export type PageEditGraphResult = SharedPageEditGraphResult

const pageData = z.custom<PageData>((value) => Boolean(value && typeof value === 'object'))
const conversationMessage = z.custom<AIConversationMessage>((value) => Boolean(value && typeof value === 'object'))
const conversationMemory = z.custom<AIConversationMemory>((value) => Boolean(value && typeof value === 'object'))
const pendingTask = z.custom<AIPendingTask>((value) => Boolean(value && typeof value === 'object'))
const editTask = z.custom<AIEditTaskState>((value) => Boolean(value && typeof value === 'object'))

export const PageEditState = new StateSchema({
  runId: z.string(),
  pageId: z.string(),
  baseRevision: z.number().int(),
  startedAt: z.string(),
  request: z.string(),
  originalRequest: z.string(),
  originalPage: pageData,
  draftPage: pageData,
  recentMessages: z.array(conversationMessage).default(() => []),
  conversationMemory: conversationMemory,
  pendingTask: pendingTask.nullable().default(null),
  task: editTask.nullable().default(null),
  routingDecision: z.custom<ModelRoutingDecision>().nullable().default(null),
  executionPolicy: z.custom<ExecutionPolicy>().nullable().default(null),
  authorizationEvidence: z.custom<UserAuthorizationEvidence>().nullable().default(null),
  pendingConfirmationEvidence: z.custom<PendingConfirmationEvidence>().nullable().default(null),
  clarificationProposals: z.array(z.custom<ClarificationProposal>()).default(() => []),
  appliedFallbacks: z.array(z.custom<AutonomousFallback>()).default(() => []),
  executionCheckpoint: z.custom<ExecutionCheckpoint>().nullable().default(null),
  brokerPass: z.number().int().min(0).default(0),
  handledProposalIds: z.array(z.string()).default(() => []),
  pendingIntegritySecret: z.string().default(''),
  intent: z.enum(['local_edit', 'large_edit', 'full_relayout', 'question', 'chat', 'cancel', 'unresolved']).default('unresolved'),
  routingSource: z.enum(['rule', 'context', 'tool']).nullable().default(null),
  routingReason: z.string().default(''),
  routingTrace: z.array(z.object({
    source: z.enum(['rule', 'context', 'tool']),
    outcome: z.enum(['resolved', 'fallback', 'error']),
    reason: z.string().default('')
  })).default(() => []),
  status: z.enum(['pending', 'running', 'routed', 'completed', 'clarification', 'error']).default('pending'),
  componentIndex: z.array(z.custom<RagComponentIndexItem>()).default(() => []),
  activeComponentIndex: z.array(z.custom<RagComponentIndexItem>()).default(() => []),
  selectedComponentIds: z.array(z.string()).default(() => []),
  editScope: z.enum(['components', 'page']).default('components'),
  currentPageContext: z.unknown().nullable().default(null),
  allowedOperationKinds: z.array(z.string()).default(() => []),
  operationLimit: z.number().int().min(1).max(12).default(12),
  plan: z.custom<AIPageEditPlan>().nullable().default(null),
  relayoutGroups: z.array(z.array(z.string())).default(() => []),
  relayoutAllowDeletion: z.boolean().default(false),
  relayoutSummary: z.string().default(''),
  stepIndex: z.number().int().min(0).default(0),
  currentPatch: z.custom<AIPagePatch>().nullable().default(null),
  previousPatch: z.custom<AIPagePatch>().nullable().default(null),
  validationError: z.string().nullable().default(null),
  modelAttempt: z.number().int().min(0).default(0),
  repairAttempt: z.number().int().min(0).default(0),
  noOpRetry: z.number().int().min(0).max(1).default(0),
  geometryRepairAttempt: z.number().int().min(0).max(1).default(0),
  needsRelocate: z.boolean().default(false),
  operationCount: z.number().int().min(0).default(0),
  warnings: z.array(z.string()).default(() => []),
  result: z.custom<PageEditGraphResult>().nullable().default(null)
})

export type PageEditStateValue = typeof PageEditState.State
export type PageEditStateUpdate = typeof PageEditState.Update

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const createInitialPageEditState = (input: {
  runId: string
  request: string
  page: PageData
  baseRevision: number
  recentMessages?: AIConversationMessage[]
  conversationMemory?: AIConversationMemory
  pendingTask?: AIPendingTask | null
  pendingIntegritySecret?: string
  startedAt?: string
}): PageEditStateUpdate => ({
  runId: input.runId,
  pageId: input.page.id,
  baseRevision: input.baseRevision,
  startedAt: input.startedAt || new Date().toISOString(),
  request: input.request,
  originalRequest: input.request,
  originalPage: clone(input.page),
  draftPage: clone(input.page),
  recentMessages: clone(input.recentMessages || []),
  conversationMemory: clone(input.conversationMemory || {
    userGoals: [],
    designConstraints: [],
    completedChanges: [],
    openQuestions: []
  }),
  pendingTask: clone(input.pendingTask || null),
  pendingIntegritySecret: input.pendingIntegritySecret || ''
})
