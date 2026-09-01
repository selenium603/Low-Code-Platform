import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import type { AIPendingTask } from '../../../src/types/aiPatch'
import { createAnswerQuestionNode } from '../graph/answerQuestion'
import { createInitialPageEditState, type PageEditStateValue } from '../graph/pageEditState'

const testPage: PageData = {
  id: 'page-1',
  meta: { title: '测试', description: '', createdAt: '', updatedAt: '', version: '1', scene: 'marketing' },
  style: { width: 1200, height: 820, backgroundColor: '#fff' },
  components: [{
    id: 'title', type: ComponentType.TEXT, name: '标题', props: { content: '你好' },
    style: { top: 40, left: 40, width: 200, height: 60, zIndex: 1, rotate: 0, opacity: 1 },
    events: [], schemaVersion: '1'
  }]
}

const pendingTask: AIPendingTask = {
  schemaVersion: 3,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 1,
  status: 'awaiting_user',
  taskIntent: 'local_edit',
  rootRequest: '优化标题',
  additionalInstructions: [],
  actionScopes: [{
    actionId: 'update-title', kind: 'update', instruction: '优化标题', targetScope: 'components',
    componentTypes: [ComponentType.TEXT], targetComponentIds: ['title'], candidateComponentIds: []
  }],
  clarification: { used: 1, max: 1, code: 'MISSING_EXECUTION_DATA', question: '希望什么风格？', source: 'patch_generator' },
  integrityToken: 'verified'
}

const state = () => ({
  ...createInitialPageEditState({
    runId: 'run-qa', request: '页面现在有几个组件？', page: testPage, baseRevision: 1, pendingTask
  }),
  pendingTask,
  recentMessages: [],
  conversationMemory: { userGoals: [], designConstraints: [], completedChanges: [], openQuestions: [] },
  validationError: null
}) as PageEditStateValue

describe('answerQuestion', () => {
  it('falls back to the primary model and preserves pending task', async () => {
    const node = createAnswerQuestionNode({
      contextModelClient: { completeStructured: async () => { throw new Error('context unavailable') } },
      modelClient: {
        completeStructured: async () => ({
          value: { type: 'assistant_reply', message: '当前页面有 1 个组件。' },
          content: '{"type":"assistant_reply"}'
        })
      }
    })
    const result = await node(state())
    expect(result.result).toMatchObject({ type: 'assistant_reply', pendingTask })
  })

  it('returns a retryable technical failure without consuming pending task', async () => {
    const failing = { completeStructured: async () => { throw new Error('model unavailable') } }
    const result = await createAnswerQuestionNode({ contextModelClient: failing, modelClient: failing })(state())
    expect(result.result).toMatchObject({
      type: 'execution_failed', code: 'QA_MODEL_FAILED', retryable: true, pendingTask
    })
  })
})
