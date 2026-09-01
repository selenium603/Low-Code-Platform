import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AIConversationMemory,
  AIConversationMessage,
  AIConversationRole,
  AIConversationSession,
  AIMessageStatus,
  AIEditActionScope,
  AIPendingTask
} from '@/types/aiPatch'

const STORAGE_KEY = 'marketing-editor-ai-sessions'
const MAX_RECENT_MESSAGES = 8
const MEMORY_LIMITS = {
  userGoals: { count: 4, length: 220 },
  designConstraints: { count: 5, length: 180 },
  completedChanges: { count: 6, length: 180 },
  openQuestions: { count: 3, length: 220 }
} as const
const DESIGN_CONSTRAINT_PATTERN = /颜色|配色|色调|字体|字号|风格|布局|对齐|间距|圆角|阴影|留白|宽度|高度|位置|层级|移动端|手机端|PC端|桌面端|响应式|不要|必须|保持|统一|color|font|style|layout|spacing|mobile|desktop|responsive/i

const now = () => new Date().toISOString()
const createMemory = (): AIConversationMemory => ({
  userGoals: [],
  designConstraints: [],
  completedChanges: [],
  openQuestions: []
})

const cleanMemoryItem = (value: unknown, maxLength: number) => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : ''
)

const normalizeMemoryList = (
  value: unknown,
  limit: { count: number; length: number }
) => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanMemoryItem(item, limit.length)).filter(Boolean))].slice(-limit.count)
}

const normalizeMemory = (value: unknown): AIConversationMemory => {
  const memory = value && typeof value === 'object' ? value as Partial<AIConversationMemory> : {}
  return {
    userGoals: normalizeMemoryList(memory.userGoals, MEMORY_LIMITS.userGoals),
    designConstraints: normalizeMemoryList(memory.designConstraints, MEMORY_LIMITS.designConstraints),
    completedChanges: normalizeMemoryList(memory.completedChanges, MEMORY_LIMITS.completedChanges),
    openQuestions: normalizeMemoryList(memory.openQuestions, MEMORY_LIMITS.openQuestions)
  }
}

const normalizePendingTask = (value: unknown): AIPendingTask | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const clarification = raw.clarification && typeof raw.clarification === 'object'
    ? raw.clarification as Record<string, unknown>
    : null
  const sources = ['rule_router', 'context_router', 'tool_router', 'semantic_analyzer', 'component_locator', 'patch_generator', 'large_edit_planner', 'geometry_validator']
  const codes = ['TARGET_AMBIGUOUS', 'DELETION_AUTH_REQUIRED', 'GEOMETRY_RELAYOUT_AUTH_REQUIRED', 'CONFLICTING_REQUIREMENTS', 'MISSING_EXECUTION_DATA']
  const intents = ['local_edit', 'large_edit', 'full_relayout']
  if (raw.schemaVersion !== 2 || raw.status !== 'awaiting_user'
    || typeof raw.taskId !== 'string' || typeof raw.pageId !== 'string'
    || !Number.isInteger(raw.pageRevision) || !intents.includes(String(raw.taskIntent))
    || typeof raw.rootRequest !== 'string' || typeof raw.integrityToken !== 'string'
    || clarification?.used !== 1 || clarification.max !== 1
    || !codes.includes(String(clarification.code)) || !sources.includes(String(clarification.source))
    || typeof clarification.question !== 'string') return null
  const cleanIds = (input: unknown) => Array.isArray(input)
    ? [...new Set(input.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))].slice(0, 12)
    : []
  const kinds = ['add', 'update', 'replace', 'delete', 'preserve']
  const componentTypes = ['Text', 'Image', 'Button', 'Input', 'Form', 'Chart']
  const actionScopes: AIEditActionScope[] = Array.isArray(raw.actionScopes)
    ? raw.actionScopes.slice(0, 8).flatMap((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const action = item as Record<string, unknown>
        if (!kinds.includes(String(action.kind))
          || (action.targetScope !== 'page' && action.targetScope !== 'components')
          || typeof action.instruction !== 'string' || !action.instruction.trim()) return []
        return [{
          actionId: typeof action.actionId === 'string' && action.actionId.trim()
            ? action.actionId.trim().slice(0, 80)
            : `action-${index + 1}`,
          kind: action.kind as AIEditActionScope['kind'],
          instruction: action.instruction.trim().replace(/\s+/g, ' ').slice(0, 500),
          targetScope: action.targetScope,
          componentTypes: Array.isArray(action.componentTypes)
            ? [...new Set(action.componentTypes.filter((type): type is AIEditActionScope['componentTypes'][number] => componentTypes.includes(String(type))))]
            : [],
          targetComponentIds: cleanIds(action.targetComponentIds)
        }]
      })
    : []
  return {
    schemaVersion: 2,
    taskId: raw.taskId.trim().slice(0, 160),
    pageId: raw.pageId.trim().slice(0, 160),
    pageRevision: Number(raw.pageRevision),
    status: 'awaiting_user',
    taskIntent: raw.taskIntent as AIPendingTask['taskIntent'],
    rootRequest: raw.rootRequest.trim().replace(/\s+/g, ' ').slice(0, 1000),
    additionalInstructions: Array.isArray(raw.additionalInstructions)
      ? [...new Set(raw.additionalInstructions
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().replace(/\s+/g, ' ').slice(0, 500))
          .filter(Boolean))].slice(-6)
      : [],
    targetComponentIds: cleanIds(raw.targetComponentIds),
    candidateComponentIds: cleanIds(raw.candidateComponentIds),
    actionScopes,
    clarification: {
      used: 1,
      max: 1,
      code: clarification.code as AIPendingTask['clarification']['code'],
      question: clarification.question.trim().slice(0, 500),
      source: clarification.source as AIPendingTask['clarification']['source']
    },
    integrityToken: raw.integrityToken.slice(0, 128)
  }
}

const appendUnique = (items: string[], value: string, limit: { count: number; length: number }) => {
  const next = cleanMemoryItem(value, limit.length)
  if (!next) return
  const duplicateIndex = items.findIndex((item) => item === next)
  if (duplicateIndex >= 0) items.splice(duplicateIndex, 1)
  items.push(next)
  if (items.length > limit.count) items.splice(0, items.length - limit.count)
}

const migrateLegacySummary = (summary: unknown) => {
  const memory = createMemory()
  if (typeof summary !== 'string') return memory
  summary.split(/\r?\n/).forEach((line) => {
    const value = line.trim()
    if (!value) return
    if (value.startsWith('用户：')) {
      const content = value.slice(3)
      appendUnique(memory.userGoals, content, MEMORY_LIMITS.userGoals)
      if (DESIGN_CONSTRAINT_PATTERN.test(content)) {
        appendUnique(memory.designConstraints, content, MEMORY_LIMITS.designConstraints)
      }
    } else if (/[？?]$/.test(value)) {
      appendUnique(memory.openQuestions, value.replace(/^AI：/, ''), MEMORY_LIMITS.openQuestions)
    } else {
      appendUnique(memory.completedChanges, value.replace(/^AI：/, ''), MEMORY_LIMITS.completedChanges)
    }
  })
  return memory
}

export const normalizeStoredAIConversationSession = (pageId: string, value: unknown): AIConversationSession => {
  const raw = value && typeof value === 'object'
    ? value as Partial<AIConversationSession> & { summary?: unknown }
    : {}
  const memory = raw.memory ? normalizeMemory(raw.memory) : migrateLegacySummary(raw.summary)
  // openQuestions is derived only from a verifiable v2 pendingTask. Legacy
  // questions cannot be upgraded into resumable authorization.
  memory.openQuestions = []
  const recentMessages = Array.isArray(raw.recentMessages)
    ? raw.recentMessages.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const message = item as Partial<AIConversationMessage>
        if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return []
        return [{
          id: typeof message.id === 'string' ? message.id : `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          role: message.role,
          content: message.content.slice(0, 2000),
          createdAt: typeof message.createdAt === 'string' ? message.createdAt : now(),
          status: ['processing', 'completed', 'failed', 'cancelled'].includes(String(message.status))
            ? message.status as AIMessageStatus
            : 'completed',
          ...(typeof message.taskId === 'string' ? { taskId: message.taskId.slice(0, 160) } : {}),
          ...(typeof message.retryable === 'boolean' ? { retryable: message.retryable } : {}),
          ...(typeof message.errorCode === 'string' ? { errorCode: message.errorCode.slice(0, 100) } : {}),
          ...(typeof message.patchSummary === 'string' ? { patchSummary: message.patchSummary.slice(0, 300) } : {})
        } satisfies AIConversationMessage]
      }).slice(-MAX_RECENT_MESSAGES)
    : []
  const pendingTask = normalizePendingTask((raw as { pendingTask?: unknown }).pendingTask)
  if (pendingTask) memory.openQuestions = [pendingTask.clarification.question]
  return {
    pageId,
    memory,
    recentMessages,
    pendingTask,
    pageRevision: Number.isFinite(raw.pageRevision) ? Number(raw.pageRevision) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now()
  }
}

const createSession = (pageId: string, pageRevision: number): AIConversationSession => ({
  pageId,
  memory: createMemory(),
  recentMessages: [],
  pendingTask: null,
  pageRevision,
  updatedAt: now()
})

export const useAIConversationStore = defineStore('aiConversation', () => {
  const sessions = ref<Record<string, AIConversationSession>>({})
  const loaded = ref(false)

  const persist = () => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.value))
  }

  const load = () => {
    if (loaded.value || typeof window === 'undefined') return
    loaded.value = true
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        sessions.value = Object.fromEntries(
          Object.entries(parsed).map(([pageId, session]) => [pageId, normalizeStoredAIConversationSession(pageId, session)])
        )
        persist()
      }
    } catch {
      sessions.value = {}
    }
  }

  const getSession = (pageId: string, pageRevision = 0) => {
    load()
    if (!sessions.value[pageId]) {
      sessions.value[pageId] = createSession(pageId, pageRevision)
      persist()
    }
    return sessions.value[pageId]
  }

  const syncRevision = (pageId: string, pageRevision: number) => {
    const session = getSession(pageId, pageRevision)
    if (session.pendingTask && session.pendingTask.pageRevision !== pageRevision) {
      session.pendingTask = null
      session.memory.openQuestions = []
    }
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const appendMessage = (
    pageId: string,
    pageRevision: number,
    role: AIConversationRole,
    content: string,
    patchSummary?: string,
    options: { status?: AIMessageStatus; taskId?: string } = {}
  ) => {
    const session = getSession(pageId, pageRevision)
    const message: AIConversationMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      role,
      content,
      createdAt: now(),
      status: options.status || 'completed',
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(patchSummary ? { patchSummary } : {})
    }
    session.recentMessages.push(message)

    if (session.recentMessages.length > MAX_RECENT_MESSAGES) {
      session.recentMessages.splice(0, session.recentMessages.length - MAX_RECENT_MESSAGES)
    }

    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
    return message
  }

  const rememberUserIntent = (pageId: string, pageRevision: number, content: string) => {
    const session = getSession(pageId, pageRevision)
    appendUnique(session.memory.userGoals, content, MEMORY_LIMITS.userGoals)
    content.split(/[。！？!\n]+/).forEach((part) => {
      if (DESIGN_CONSTRAINT_PATTERN.test(part)) {
        appendUnique(session.memory.designConstraints, part, MEMORY_LIMITS.designConstraints)
      }
    })
    session.memory.openQuestions = []
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const rememberCompletedChange = (pageId: string, pageRevision: number, summary: string) => {
    const session = getSession(pageId, pageRevision)
    appendUnique(session.memory.completedChanges, summary, MEMORY_LIMITS.completedChanges)
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const setPendingTask = (
    pageId: string,
    pageRevision: number,
    value: AIPendingTask
  ) => {
    const session = getSession(pageId, pageRevision)
    session.pendingTask = normalizePendingTask(value)
    session.memory.openQuestions = session.pendingTask ? [session.pendingTask.clarification.question] : []
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const clearPendingTask = (pageId: string, pageRevision: number) => {
    const session = getSession(pageId, pageRevision)
    session.pendingTask = null
    session.memory.openQuestions = []
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const updateMessageStatus = (
    pageId: string,
    messageId: string,
    status: AIMessageStatus,
    details: { retryable?: boolean; errorCode?: string } = {}
  ) => {
    const session = sessions.value[pageId]
    const message = session?.recentMessages.find((item) => item.id === messageId)
    if (!session || !message) return
    message.status = status
    if (details.retryable === undefined) delete message.retryable
    else message.retryable = details.retryable
    if (!details.errorCode) delete message.errorCode
    else message.errorCode = details.errorCode.slice(0, 100)
    session.updatedAt = now()
    persist()
  }

  const forgetLastCompletedChange = (pageId: string, pageRevision: number) => {
    const session = getSession(pageId, pageRevision)
    session.memory.completedChanges.pop()
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const clearSession = (pageId: string, pageRevision = 0) => {
    sessions.value[pageId] = createSession(pageId, pageRevision)
    persist()
  }

  return {
    sessions,
    load,
    getSession,
    syncRevision,
    appendMessage,
    rememberUserIntent,
    rememberCompletedChange,
    setPendingTask,
    clearPendingTask,
    updateMessageStatus,
    forgetLastCompletedChange,
    clearSession
  }
})
