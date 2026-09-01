import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import { createContextIntentNode } from '../graph/modelIntentRouter'
import { createInitialPageEditState, type PageEditStateValue } from '../graph/pageEditState'

const page: PageData = {
  id: 'page-1',
  meta: { title: '测试', description: '', createdAt: '', updatedAt: '', version: '2026.05', scene: 'marketing' },
  style: { width: 1200, height: 820, backgroundColor: '#fff' },
  components: [{
    id: 'button-1', type: ComponentType.BUTTON, name: '按钮',
    props: { content: '提交', type: 'primary' },
    style: { top: 40, left: 40, width: 160, height: 48, zIndex: 1, rotate: 0, opacity: 1 },
    events: [], schemaVersion: '2026.05'
  }]
}

describe('context intent fallback', () => {
  it('uses the primary Qwen client in the same node when DeepSeek is not configured', async () => {
    let calls = 0
    const node = createContextIntentNode({
      modelClient: {
        completeStructured: async () => {
          calls += 1
          return {
            value: { intent: 'local_edit', relationToPending: 'none', reason: '用户要求修改现有按钮。' },
            content: '{}'
          }
        }
      }
    })
    const state = createInitialPageEditState({
      runId: 'run-route', request: '整得更醒目一点', page, baseRevision: 1
    })

    const result = await node(state as PageEditStateValue)

    expect(calls).toBe(1)
    expect(result).toMatchObject({
      intent: 'local_edit',
      routingSource: 'tool',
      routingDecision: { relationToPending: 'none' }
    })
  })
})
