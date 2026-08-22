import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AIConversationMemory,
  AIConversationMessage,
  AIConversationRole,
  AIConversationSession
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

const normalizeSession = (pageId: string, value: unknown): AIConversationSession => {
  const raw = value && typeof value === 'object'
    ? value as Partial<AIConversationSession> & { summary?: unknown }
    : {}
  const memory = raw.memory ? normalizeMemory(raw.memory) : migrateLegacySummary(raw.summary)
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
          ...(typeof message.patchSummary === 'string' ? { patchSummary: message.patchSummary.slice(0, 300) } : {})
        } satisfies AIConversationMessage]
      }).slice(-MAX_RECENT_MESSAGES)
    : []
  return {
    pageId,
    memory,
    recentMessages,
    pageRevision: Number.isFinite(raw.pageRevision) ? Number(raw.pageRevision) : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now()
  }
}

const createSession = (pageId: string, pageRevision: number): AIConversationSession => ({
  pageId,
  memory: createMemory(),
  recentMessages: [],
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
          Object.entries(parsed).map(([pageId, session]) => [pageId, normalizeSession(pageId, session)])
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
    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
  }

  const appendMessage = (
    pageId: string,
    pageRevision: number,
    role: AIConversationRole,
    content: string,
    patchSummary?: string
  ) => {
    const session = getSession(pageId, pageRevision)
    const message: AIConversationMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      role,
      content,
      createdAt: now(),
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

  const rememberOpenQuestion = (pageId: string, pageRevision: number, question: string) => {
    const session = getSession(pageId, pageRevision)
    appendUnique(session.memory.openQuestions, question, MEMORY_LIMITS.openQuestions)
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

  const removeMessage = (pageId: string, messageId: string) => {
    const session = sessions.value[pageId]
    if (!session) return
    session.recentMessages = session.recentMessages.filter((message) => message.id !== messageId)
    session.updatedAt = now()
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
    rememberOpenQuestion,
    forgetLastCompletedChange,
    removeMessage,
    clearSession
  }
})
