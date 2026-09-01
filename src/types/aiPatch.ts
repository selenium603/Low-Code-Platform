import type { ComponentProps, ComponentStyle, PageData, PageStyle } from './index'
import type { ComponentType, DeviceType } from './index'

export type AIConversationRole = 'user' | 'assistant'
export type AIMessageStatus = 'processing' | 'completed' | 'failed' | 'cancelled'

export interface AIConversationMessage {
  id: string
  role: AIConversationRole
  content: string
  createdAt: string
  patchSummary?: string
  status: AIMessageStatus
  taskId?: string
  retryable?: boolean
  errorCode?: string
}

export type PageEditIntent =
  | 'local_edit'
  | 'large_edit'
  | 'full_relayout'
  | 'question'
  | 'chat'
  | 'cancel'
  | 'unresolved'

export type PendingRelation =
  | 'none'
  | 'answer'
  | 'supplement'
  | 'delegate'
  | 'replace'
  | 'cancel'
  | 'question'
  | 'chat'
  | 'unresolved'

export interface ModelRoutingDecision {
  intent: PageEditIntent
  relationToPending: PendingRelation
  reason: string
}

export interface NormalizedRoutingDecision extends ModelRoutingDecision {
  source: 'rule' | 'context' | 'tool'
}

export interface AIConversationMemory {
  userGoals: string[]
  designConstraints: string[]
  completedChanges: string[]
  openQuestions: string[]
}

export type AIEditActionKind = 'add' | 'update' | 'replace' | 'delete' | 'preserve'

/**
 * 服务端验证后的动作级作用域。LLM 只解释用户语义；组件 ID 必须来自当前页面，
 * 最终操作权限由服务端根据这些作用域派生。
 */
export interface AIEditActionScope {
  actionId: string
  kind: AIEditActionKind
  instruction: string
  targetScope: 'page' | 'components'
  componentTypes: ComponentType[]
  targetComponentIds: string[]
  candidateComponentIds: string[]
}

export type AIClarificationSource =
  | 'component_locator'
  | 'semantic_analyzer'
  | 'patch_generator'
  | 'geometry_validator'

export type AIClarificationCode =
  | 'TARGET_AMBIGUOUS'
  | 'DELETION_AUTH_REQUIRED'
  | 'GEOMETRY_RELAYOUT_AUTH_REQUIRED'
  | 'CONFLICTING_REQUIREMENTS'
  | 'MISSING_EXECUTION_DATA'

export type AIBusinessClarificationCode = AIClarificationCode

export interface AIEditTaskState {
  taskId: string
  pageId: string
  pageRevision: number
  intent: 'local_edit' | 'large_edit' | 'full_relayout'
  rootRequest: string
  additionalInstructions: string[]
  actionScopes: AIEditActionScope[]
  clarificationUsed: 0 | 1
  resumedFromPending: boolean
  delegatedToModel: boolean
}

export interface AIPendingTask {
  schemaVersion: 3
  taskId: string
  pageId: string
  pageRevision: number
  status: 'awaiting_user'
  taskIntent: 'local_edit' | 'large_edit' | 'full_relayout'
  rootRequest: string
  additionalInstructions: string[]
  actionScopes: AIEditActionScope[]
  clarification: {
    used: 1
    max: 1
    code: AIBusinessClarificationCode
    question: string
    source: AIClarificationSource
  }
  integrityToken: string
}

export type AutonomousFallback =
  | { kind: 'select_best_candidate'; orderedCandidateIds: string[]; evidence: Array<'stable_id' | 'exact_name' | 'exact_text' | 'unique_type' | 'rag' | 'lexical' | 'spatial_order'> }
  | { kind: 'use_model_defaults'; allowedComponentIds: string[] }
  | { kind: 'limit_execution'; operationLimit: number }
  | { kind: 'limit_geometry_scope'; allowedComponentIds: string[]; maxAffectedComponents: 12 }
  | { kind: 'return_no_change'; message: string }

export interface ClarificationProposal {
  proposalId: string
  source: 'semantic_analyzer' | 'component_locator' | 'patch_generator' | 'geometry_validator'
  code: AIBusinessClarificationCode
  question: string
  blocking: boolean
  hasSafeFallback: boolean
  affectedComponentCount: number
  fallback: AutonomousFallback
}

export interface ExecutionPolicy {
  canClarify: boolean
  useModelDefaults: boolean
  allowDelete: boolean
  deleteAuthorization: DeleteAuthorization
  allowRegionalRelayout: boolean
  maxAffectedComponents: number
  operationLimit: number
}

export interface ExecutionUnit {
  id: string
  actionIds: string[]
  componentIds: string[]
  allowAdd: boolean
  allowPageStyle: boolean
  operationBudget: number
}

export interface DeleteAuthorization {
  authorized: boolean
  source: 'none' | 'explicit_user_request' | 'signed_pending_confirmation'
  componentIds: string[]
}

export interface UserAuthorizationEvidence {
  rootUserMessage: string
  additionalUserMessages: string[]
}

export interface PendingConfirmationEvidence {
  clarificationCode: AIBusinessClarificationCode
  clarificationSource: AIClarificationSource
  signedActionScopes: AIEditActionScope[]
  relation: PendingRelation
  rawUserReply: string
}

export interface AIConversationSession {
  pageId: string
  memory: AIConversationMemory
  recentMessages: AIConversationMessage[]
  pendingTask: AIPendingTask | null
  pageRevision: number
  updatedAt: string
}

export type RelativePosition = 'above' | 'below' | 'left' | 'right'
export type RelativeAlign = 'start' | 'center' | 'end'

export type AIPageOperation =
  | {
      op: 'updateProps'
      componentId: string
      changes: Partial<ComponentProps> | Record<string, unknown>
    }
  | {
      op: 'updateStyle'
      componentId: string
      device: DeviceType
      changes: Partial<ComponentStyle>
    }
  | {
      op: 'updatePageStyle'
      device: DeviceType
      changes: Partial<PageStyle>
    }
  | {
      op: 'placeRelative'
      componentId: string
      targetId: string
      device: DeviceType
      relation: RelativePosition
      gap?: number
      align?: RelativeAlign
    }
  | {
      op: 'addComponent'
      componentType: ComponentType
      name?: string
      props?: Record<string, unknown>
      style?: Partial<ComponentStyle>
      mobileStyle?: Partial<ComponentStyle>
      device?: DeviceType
    }
  | {
      op: 'removeComponent'
      componentId: string
    }
  | {
      op: 'moveLayer'
      componentId: string
      direction: 'up' | 'down' | 'top' | 'bottom'
    }

export interface AIPagePatch {
  type: 'page_patch'
  baseRevision: number
  summary: string
  operations: AIPageOperation[]
}

export interface AIClarification {
  type: 'need_clarification'
  question: string
  clarificationCode: AIClarificationCode
}

export interface AIPageEditCompleted {
  type: 'page_edit_completed'
  runId: string
  baseRevision: number
  summary: string
  page: PageData
  operationCount: number
  stepCount: number
  warnings: string[]
  executedRequest?: string
}

export interface AIClarificationRequested {
  type: 'clarification_requested'
  runId: string
  question: string
  pendingTask: AIPendingTask
}

export interface AIAssistantReply {
  type: 'assistant_reply'
  runId: string
  message: string
  pendingTask: AIPendingTask | null
}

export interface AITaskCancelled {
  type: 'task_cancelled'
  runId: string
  message: string
}

export interface AINoChange {
  type: 'no_change'
  runId: string
  message: string
  retryable: boolean
}

export interface AIExecutionFailed {
  type: 'execution_failed'
  runId: string
  code: string
  message: string
  retryable: boolean
  pendingTask?: AIPendingTask | null
}

export type PageEditGraphResult =
  | AIClarificationRequested
  | AIPageEditCompleted
  | AIAssistantReply
  | AITaskCancelled
  | AINoChange
  | AIExecutionFailed

export type AIEditResponse = AIPagePatch | AIClarification | PageEditGraphResult

export interface AIEditRequest {
  message: string
  page: PageData
  baseRevision: number
  recentMessages: AIConversationMessage[]
  conversationMemory: AIConversationMemory
  pendingTask: AIPendingTask | null
}
