import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { AIBusinessClarificationCode, AIClarificationSource, AIEditActionScope, AIPendingTask } from '../../../src/types/aiPatch'

const MAX_TOKEN_LENGTH = 128
const MAX_ROOT_REQUEST_LENGTH = 1_000
const MAX_INSTRUCTION_LENGTH = 500
const MAX_QUESTION_LENGTH = 500
const MAX_ID_LENGTH = 160
const MAX_INSTRUCTIONS = 6
const MAX_COMPONENT_IDS = 12
const MAX_ACTIONS = 8

const clarificationCodes = new Set<AIBusinessClarificationCode>([
  'TARGET_AMBIGUOUS',
  'DELETION_AUTH_REQUIRED',
  'GEOMETRY_RELAYOUT_AUTH_REQUIRED',
  'CONFLICTING_REQUIREMENTS',
  'MISSING_EXECUTION_DATA'
])

const clarificationSources = new Set<AIClarificationSource>([
  'rule_router',
  'context_router',
  'tool_router',
  'component_locator',
  'semantic_analyzer',
  'patch_generator',
  'large_edit_planner',
  'geometry_validator'
])

const taskIntents = new Set<AIPendingTask['taskIntent']>(['local_edit', 'large_edit', 'full_relayout'])

let processSecret: string | null = null

const cleanString = (value: unknown, max: number) => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : ''
)

const cleanIds = (value: unknown) => Array.isArray(value)
  ? [...new Set(value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => cleanString(item, MAX_ID_LENGTH))
      .filter(Boolean))].slice(0, MAX_COMPONENT_IDS)
  : []

const cleanInstructions = (value: unknown) => Array.isArray(value)
  ? [...new Set(value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => cleanString(item, MAX_INSTRUCTION_LENGTH))
      .filter(Boolean))].slice(-MAX_INSTRUCTIONS)
  : []

const cleanActionScopes = (value: unknown): AIEditActionScope[] => Array.isArray(value)
  ? value.slice(0, MAX_ACTIONS).flatMap((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const raw = item as Record<string, unknown>
      const kinds = new Set<AIEditActionScope['kind']>(['add', 'update', 'replace', 'delete', 'preserve'])
      const types = new Set(['Text', 'Image', 'Button', 'Input', 'Form', 'Chart'])
      const kind = kinds.has(raw.kind as AIEditActionScope['kind']) ? raw.kind as AIEditActionScope['kind'] : null
      const targetScope = raw.targetScope === 'page' || raw.targetScope === 'components' ? raw.targetScope : null
      const instruction = cleanString(raw.instruction, MAX_INSTRUCTION_LENGTH)
      if (!kind || !targetScope || !instruction) return []
      return [{
        actionId: cleanString(raw.actionId, 80) || `action-${index + 1}`,
        kind,
        instruction,
        targetScope,
        componentTypes: Array.isArray(raw.componentTypes)
          ? [...new Set(raw.componentTypes.filter((type): type is AIEditActionScope['componentTypes'][number] => types.has(String(type))))]
          : [],
        targetComponentIds: cleanIds(raw.targetComponentIds)
      }]
    })
  : []

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)])
  )
}

export const canonicalizePendingTask = (task: Omit<AIPendingTask, 'integrityToken'>) => (
  JSON.stringify(canonicalValue(task))
)

export const getPendingTaskSecret = (configuredSecret?: string) => {
  const configured = configuredSecret?.trim()
  if (configured) return configured
  processSecret ||= randomBytes(32).toString('base64url')
  return processSecret
}

export const resetEphemeralPendingTaskSecretForTests = () => {
  processSecret = null
}

export const signPendingTask = (
  task: Omit<AIPendingTask, 'integrityToken'>,
  secret: string
): AIPendingTask => {
  const normalized = normalizeUnsignedPendingTask(task)
  if (!normalized) throw new Error('Cannot sign an invalid pending task.')
  return {
    ...normalized,
    integrityToken: createHmac('sha256', secret).update(canonicalizePendingTask(normalized)).digest('base64url')
  }
}

const normalizeUnsignedPendingTask = (value: unknown): Omit<AIPendingTask, 'integrityToken'> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const clarification = raw.clarification && typeof raw.clarification === 'object' && !Array.isArray(raw.clarification)
    ? raw.clarification as Record<string, unknown>
    : null
  const taskId = cleanString(raw.taskId, MAX_ID_LENGTH)
  const pageId = cleanString(raw.pageId, MAX_ID_LENGTH)
  const rootRequest = cleanString(raw.rootRequest, MAX_ROOT_REQUEST_LENGTH)
  const question = cleanString(clarification?.question, MAX_QUESTION_LENGTH)
  if (raw.schemaVersion !== 2 || raw.status !== 'awaiting_user' || !taskId || !pageId || !rootRequest || !question) return null
  if (!Number.isInteger(raw.pageRevision) || Number(raw.pageRevision) < 0) return null
  if (!taskIntents.has(raw.taskIntent as AIPendingTask['taskIntent'])) return null
  if (clarification?.used !== 1 || clarification.max !== 1) return null
  if (!clarificationCodes.has(clarification.code as AIBusinessClarificationCode)) return null
  if (!clarificationSources.has(clarification.source as AIClarificationSource)) return null
  return {
    schemaVersion: 2,
    taskId,
    pageId,
    pageRevision: Number(raw.pageRevision),
    status: 'awaiting_user',
    taskIntent: raw.taskIntent as AIPendingTask['taskIntent'],
    rootRequest,
    additionalInstructions: cleanInstructions(raw.additionalInstructions),
    targetComponentIds: cleanIds(raw.targetComponentIds),
    candidateComponentIds: cleanIds(raw.candidateComponentIds),
    actionScopes: cleanActionScopes(raw.actionScopes),
    clarification: {
      used: 1,
      max: 1,
      code: clarification.code as AIBusinessClarificationCode,
      question,
      source: clarification.source as AIClarificationSource
    }
  }
}

export type PendingTaskValidationResult =
  | { valid: true; task: AIPendingTask }
  | { valid: false; reason: 'missing' | 'invalid_shape' | 'invalid_token' }

export const verifyPendingTask = (value: unknown, secret: string): PendingTaskValidationResult => {
  if (value == null) return { valid: false, reason: 'missing' }
  const unsigned = normalizeUnsignedPendingTask(value)
  const rawToken = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).integrityToken
    : null
  if (!unsigned || typeof rawToken !== 'string' || !rawToken || rawToken.length > MAX_TOKEN_LENGTH) {
    return { valid: false, reason: 'invalid_shape' }
  }
  const expected = createHmac('sha256', secret).update(canonicalizePendingTask(unsigned)).digest()
  let received: Buffer
  try {
    received = Buffer.from(rawToken, 'base64url')
  } catch {
    return { valid: false, reason: 'invalid_token' }
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { valid: false, reason: 'invalid_token' }
  }
  return { valid: true, task: { ...unsigned, integrityToken: rawToken } }
}
