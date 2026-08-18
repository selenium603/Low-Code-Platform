import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AIConversationMessage, AIConversationRole, AIConversationSession } from '@/types/aiPatch'

const STORAGE_KEY = 'marketing-editor-ai-sessions'
const MAX_RECENT_MESSAGES = 8
const MAX_SUMMARY_LENGTH = 1600

const now = () => new Date().toISOString()

const createSession = (pageId: string, pageRevision: number): AIConversationSession => ({
  pageId,
  summary: '',
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
      const parsed = JSON.parse(raw) as Record<string, AIConversationSession>
      if (parsed && typeof parsed === 'object') sessions.value = parsed
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
      const archived = session.recentMessages.splice(0, session.recentMessages.length - MAX_RECENT_MESSAGES)
      const addition = archived
        .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${item.content.slice(0, 180)}`)
        .join('\n')
      session.summary = `${session.summary}${session.summary ? '\n' : ''}${addition}`.slice(-MAX_SUMMARY_LENGTH)
    }

    session.pageRevision = pageRevision
    session.updatedAt = now()
    persist()
    return message
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
    removeMessage,
    clearSession
  }
})
