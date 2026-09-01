import { describe, expect, it } from 'vitest'

import type { AIPendingTask } from '../../../src/types/aiPatch'
import { signPendingTask, verifyPendingTask } from '../graph/pendingTaskIntegrity'

const unsignedTask = (): Omit<AIPendingTask, 'integrityToken'> => ({
  schemaVersion: 2,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 3,
  status: 'awaiting_user',
  taskIntent: 'local_edit',
  rootRequest: '加点图片',
  additionalInstructions: [],
  targetComponentIds: [],
  candidateComponentIds: [],
  actionScopes: [{
    actionId: 'add-image', kind: 'add', instruction: '加点图片', targetScope: 'page',
    componentTypes: [], targetComponentIds: []
  }],
  clarification: {
    used: 1,
    max: 1,
    code: 'MISSING_EXECUTION_DATA',
    question: '希望添加什么方向的图片？',
    source: 'component_locator'
  }
})

describe('pendingTask integrity', () => {
  it('accepts a task signed by the same server secret', () => {
    const signed = signPendingTask(unsignedTask(), 'test-secret')
    expect(verifyPendingTask(signed, 'test-secret')).toEqual({ valid: true, task: signed })
  })

  it.each(['rootRequest', 'pageRevision', 'targetComponentIds', 'actionScopes'] as const)(
    'rejects tampering with %s',
    (field) => {
      const signed = signPendingTask(unsignedTask(), 'test-secret')
      const tampered = {
        ...signed,
        [field]: field === 'rootRequest'
          ? '删除全部图片'
          : field === 'pageRevision'
            ? 4
            : field === 'actionScopes'
              ? [{ ...signed.actionScopes?.[0], kind: 'delete' }]
              : ['component-1']
      }
      expect(verifyPendingTask(tampered, 'test-secret')).toMatchObject({ valid: false })
    }
  )

  it('rejects a token after the server secret changes', () => {
    const signed = signPendingTask(unsignedTask(), 'first-process-secret')
    expect(verifyPendingTask(signed, 'second-process-secret')).toEqual({ valid: false, reason: 'invalid_token' })
  })
})
