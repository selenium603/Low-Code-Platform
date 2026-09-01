import type {
  AIPendingTask,
  ModelRoutingDecision,
  NormalizedRoutingDecision,
  PageEditIntent,
  PendingRelation
} from '../../../src/types/aiPatch'

export const EXACT_CANCEL = /^(?:算了|取消|不用了|先不改了|保持现状)[。！!？?]*$/
export const EXACT_CONFIRM = /^(?:是|可以|行|好的|继续|同意|没问题)[。！!]*$/
export const EXACT_DELEGATE = /^(?:随便|随你|你决定|你看着办|都可以)[。！!]*$/

export const pendingQuickRelation = (message: string): PendingRelation | null => {
  const value = message.trim()
  if (EXACT_CANCEL.test(value)) return 'cancel'
  if (EXACT_CONFIRM.test(value)) return 'answer'
  if (EXACT_DELEGATE.test(value)) return 'delegate'
  return null
}

const editIntent = (intent: PageEditIntent): intent is 'local_edit' | 'large_edit' | 'full_relayout' => (
  intent === 'local_edit' || intent === 'large_edit' || intent === 'full_relayout'
)

export const normalizeRoutingDecision = (input: {
  decision: ModelRoutingDecision
  source: NormalizedRoutingDecision['source']
  pendingTask: AIPendingTask | null
  message: string
  currentPageId: string
  currentRevision: number
  existingComponentIds: Set<string>
}): { decision: NormalizedRoutingDecision; pendingTask: AIPendingTask | null } => {
  const quick = input.pendingTask ? pendingQuickRelation(input.message) : null
  const ids = input.pendingTask
    ? [...input.pendingTask.targetComponentIds, ...input.pendingTask.candidateComponentIds]
    : []
  const pendingValid = Boolean(input.pendingTask
    && input.pendingTask.pageId === input.currentPageId
    && input.pendingTask.pageRevision === input.currentRevision
    && ids.every((id) => input.existingComponentIds.has(id)))
  const pendingTask = pendingValid ? input.pendingTask : null
  let relation: PendingRelation = pendingTask ? input.decision.relationToPending : 'none'
  let intent = input.decision.intent
  if (quick) relation = quick
  if (!pendingTask) relation = 'none'
  if (pendingTask && quick === 'cancel') intent = 'cancel'
  if (pendingTask && editIntent(intent) && relation === 'cancel' && !EXACT_CANCEL.test(input.message.trim())) relation = 'replace'
  if (pendingTask && relation === 'unresolved' && input.decision.intent !== 'question' && input.decision.intent !== 'chat') {
    relation = pendingTask.clarification.used === 1 ? 'delegate' : 'unresolved'
  }
  if (!pendingTask && (intent === 'cancel' || intent === 'chat') && editIntent(input.decision.intent)) intent = input.decision.intent
  return {
    pendingTask,
    decision: { intent, relationToPending: relation, reason: input.decision.reason.slice(0, 300), source: input.source }
  }
}
