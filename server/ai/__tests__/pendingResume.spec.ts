import { describe, expect, it } from 'vitest'

import type { AIPendingTask } from '../../../src/types/aiPatch'
import { deriveResumeFallbacks, pendingConfirmationEvidenceFrom } from '../graph/pendingResume'

const pending = (source: AIPendingTask['clarification']['source'], code: AIPendingTask['clarification']['code']): AIPendingTask => ({
  schemaVersion: 2,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 2,
  status: 'awaiting_user',
  taskIntent: 'large_edit',
  rootRequest: '丰富整个营销页',
  additionalInstructions: [],
  targetComponentIds: ['hero-image'],
  candidateComponentIds: ['hero-image', 'footer-image'],
  clarification: { used: 1, max: 1, code, question: '希望按什么方向继续？', source },
  integrityToken: 'verified'
})

describe('pending resume derivation', () => {
  it('derives a conservative plan for an uninformative planner reply', () => {
    expect(deriveResumeFallbacks({
      pendingTask: pending('large_edit_planner', 'MISSING_EXECUTION_DATA'),
      relation: 'delegate',
      currentMessage: '随便'
    })).toEqual([{ kind: 'use_conservative_plan', maxSteps: 2, operationLimit: 8 }])
  })

  it('does not force a conservative plan for a concrete planner answer', () => {
    expect(deriveResumeFallbacks({
      pendingTask: pending('large_edit_planner', 'MISSING_EXECUTION_DATA'),
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
      signedTargetComponentIds: ['hero-image'],
      relation: 'answer',
      rawUserReply: '可以'
    })
  })
})
