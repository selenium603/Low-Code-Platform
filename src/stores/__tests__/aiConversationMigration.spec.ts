import { describe, expect, it } from 'vitest'

import { normalizeStoredAIConversationSession } from '../aiConversation'

describe('AI conversation migration', () => {
  it('preserves history and memory but invalidates legacy pending clarification state', () => {
    const session = normalizeStoredAIConversationSession('page-1', {
      memory: {
        userGoals: ['加点图片'],
        designConstraints: [],
        completedChanges: ['生成页面'],
        openQuestions: ['添加什么图片？']
      },
      recentMessages: [
        { id: 'm1', role: 'user', content: '加点图片', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: '添加什么图片？', createdAt: '2026-01-01T00:00:01.000Z' }
      ],
      pendingClarification: { id: 'legacy-untrusted' },
      pageRevision: 1
    })

    expect(session.pendingTask).toBeNull()
    expect(session.memory.userGoals).toEqual(['加点图片'])
    expect(session.memory.completedChanges).toEqual(['生成页面'])
    expect(session.memory.openQuestions).toEqual([])
    expect(session.recentMessages).toHaveLength(2)
    expect(session.recentMessages.every((message) => message.status === 'completed')).toBe(true)
  })
})
