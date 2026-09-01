import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import type { AIEditTaskState, AIPendingTask, ExecutionPolicy } from '../../../src/types/aiPatch'
import { createInitialPageEditState, type PageEditStateValue } from '../graph/pageEditState'
import { createLocateComponentsNode } from '../graph/locateComponents'
import { OpenRouterError } from '../model/openRouterClient'

const page: PageData = {
  id: 'page-1',
  meta: { title: '测试', description: '', createdAt: '', updatedAt: '', version: '2026.05', scene: 'marketing' },
  style: { width: 1200, height: 820, backgroundColor: '#fff' },
  components: [
    {
      id: 'hero-image', type: ComponentType.IMAGE, name: '英雄区图片',
      props: { src: '', alt: '英雄区', objectFit: 'cover' },
      style: { top: 40, left: 40, width: 300, height: 180, zIndex: 1, rotate: 0, opacity: 1 },
      events: [], schemaVersion: '2026.05'
    },
    {
      id: 'footer-image', type: ComponentType.IMAGE, name: '页脚图片',
      props: { src: '', alt: '页脚', objectFit: 'cover' },
      style: { top: 500, left: 40, width: 300, height: 180, zIndex: 2, rotate: 0, opacity: 1 },
      events: [], schemaVersion: '2026.05'
    }
  ]
}

const task: AIEditTaskState = {
  taskId: 'task-1', pageId: 'page-1', pageRevision: 1, intent: 'local_edit',
  rootRequest: '修改图片', additionalInstructions: ['英雄区图片'], targetComponentIds: [],
  candidateComponentIds: ['hero-image', 'footer-image'], clarificationUsed: 1,
  resumedFromPending: true, delegatedToModel: false
}

const policy: ExecutionPolicy = {
  canClarify: false, useModelDefaults: false, allowDelete: false,
  deleteAuthorization: { authorized: false, source: 'none', componentIds: [] },
  allowRegionalRelayout: false, maxAffectedComponents: 12, operationLimit: 12, maxPlanSteps: 6
}

const pendingTask: AIPendingTask = {
  schemaVersion: 2,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 1,
  status: 'awaiting_user',
  taskIntent: 'local_edit',
  rootRequest: '修改图片',
  additionalInstructions: [],
  targetComponentIds: [],
  candidateComponentIds: ['hero-image', 'footer-image'],
  clarification: {
    used: 1,
    max: 1,
    code: 'TARGET_AMBIGUOUS',
    question: '修改哪张图片？',
    source: 'component_locator'
  },
  integrityToken: 'verified'
}

const stateFor = (answer: string) => ({
  ...createInitialPageEditState({ runId: 'run-1', request: answer, page, baseRevision: 1, pendingTask }),
  task,
  pendingTask,
  intent: 'local_edit',
  request: `修改图片\n补充要求：${answer}`,
  originalRequest: answer,
  executionPolicy: policy,
  appliedFallbacks: [],
  selectedComponentIds: [],
  plan: null,
  stepIndex: 0,
  relayoutAllowDeletion: false
}) as PageEditStateValue

describe('pending candidate recovery', () => {
  it('uses the current answer to select within signed candidates instead of proposing again', async () => {
    const node = createLocateComponentsNode({
      modelClient: { completeStructured: async () => { throw new Error('model should not be called') } },
      retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] })
    })
    const result = await node(stateFor('英雄区图片'))
    expect(result.selectedComponentIds).toEqual(['hero-image'])
    expect(result.clarificationProposals).toBeUndefined()
  })

  it('retries an invalid protocol result and accepts the second selection', async () => {
    let calls = 0
    const node = createLocateComponentsNode({
      modelClient: {
        completeStructured: async () => {
          calls += 1
          return calls === 1
            ? { value: { type: 'invalid' }, content: '{}' }
            : {
                value: { type: 'selection', scope: 'components', componentIds: ['footer-image'], reason: '页脚区域' },
                content: '{}'
              }
        }
      },
      retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] })
    })

    const result = await node(stateFor('下面那张'))
    expect(calls).toBe(2)
    expect(result.selectedComponentIds).toEqual(['footer-image'])
  })

  it('returns a technical failure after two model failures and preserves pending task', async () => {
    let calls = 0
    const node = createLocateComponentsNode({
      modelClient: { completeStructured: async () => { calls += 1; throw new Error('model unavailable') } },
      retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] })
    })

    const result = await node(stateFor('下面那个'))
    expect(calls).toBe(2)
    expect(result.result).toMatchObject({
      type: 'execution_failed',
      code: 'LOCATOR_MODEL_FAILED',
      pendingTask
    })
    expect(result.clarificationProposals).toBeUndefined()
  })

  it('does not retry a user abort', async () => {
    let calls = 0
    const node = createLocateComponentsNode({
      modelClient: {
        completeStructured: async () => {
          calls += 1
          throw new OpenRouterError('ABORTED', 'cancelled')
        }
      },
      retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] })
    })

    await expect(node(stateFor('下面那个'))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(calls).toBe(1)
  })
})
