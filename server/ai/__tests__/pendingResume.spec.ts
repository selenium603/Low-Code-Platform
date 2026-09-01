import { describe, expect, it } from 'vitest'

import type { AIPendingTask } from '../../../src/types/aiPatch'
import { deriveResumeFallbacks, pendingConfirmationEvidenceFrom } from '../graph/pendingResume'

const pending = (source: AIPendingTask['clarification']['source'], code: AIPendingTask['clarification']['code']): AIPendingTask => ({
  schemaVersion: 3,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 2,
  status: 'awaiting_user',
  taskIntent: 'large_edit',
  rootRequest: '丰富整个营销页',
  additionalInstructions: [],
  actionScopes: [{
    actionId: 'update-image', kind: 'update', instruction: '修改图片', targetScope: 'components',
    componentTypes: [], targetComponentIds: ['hero-image'], candidateComponentIds: ['hero-image', 'footer-image']
  }],
  clarification: { used: 1, max: 1, code, question: '希望按什么方向继续？', source },
  integrityToken: 'verified'
})

describe('pending resume derivation', () => {
  it('derives model defaults from the signed action scope for an uninformative reply', () => {
    expect(deriveResumeFallbacks({
      pendingTask: pending('semantic_analyzer', 'MISSING_EXECUTION_DATA'),
      relation: 'delegate',
      currentMessage: '随便'
    })).toEqual([{ kind: 'use_model_defaults', allowedComponentIds: ['hero-image'] }])
  })

  it('does not force model defaults for a concrete semantic answer', () => {
    expect(deriveResumeFallbacks({
      pendingTask: pending('semantic_analyzer', 'MISSING_EXECUTION_DATA'),
      relation: 'supplement',
      currentMessage: '重点补充产品卖点和客户案例，不新增表单'
    })).toEqual([])
  })

  it('preserves signed clarification provenance as server-only evidence', () => {
    expect(pendingConfirmationEvidenceFrom({
      pendingTask: pending('patch_generator', 'DELETION_AUTH_REQUIRED'),
      relation: 'answer',
      currentMessage: '可以'
    })).toMatchObject({
      clarificationCode: 'DELETION_AUTH_REQUIRED',
      signedActionScopes: [{ targetComponentIds: ['hero-image'] }],
      relation: 'answer',
      rawUserReply: '可以'
    })
  })
})
