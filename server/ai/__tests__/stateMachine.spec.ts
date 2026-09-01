import { describe, expect, it } from 'vitest'

import type { AIEditTaskState, AIPendingTask, ClarificationProposal } from '../../../src/types/aiPatch'
import { clarificationBroker } from '../graph/clarificationBroker'
import { deriveExecutionPolicy } from '../graph/executionPolicy'
import { normalizeRoutingDecision, pendingQuickRelation } from '../graph/routingDecision'
import { reduceTaskState } from '../graph/taskReducer'

const pending = (): AIPendingTask => ({
  schemaVersion: 2,
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 2,
  status: 'awaiting_user',
  taskIntent: 'local_edit',
  rootRequest: '加点图片',
  additionalInstructions: [],
  targetComponentIds: [],
  candidateComponentIds: [],
  clarification: { used: 1, max: 1, code: 'MISSING_EXECUTION_DATA', question: '添加什么图片？', source: 'component_locator' },
  integrityToken: 'verified-by-handler'
})

const task = (clarificationUsed: 0 | 1): AIEditTaskState => ({
  taskId: 'task-1',
  pageId: 'page-1',
  pageRevision: 2,
  intent: 'local_edit',
  rootRequest: '加点图片',
  additionalInstructions: [],
  targetComponentIds: [],
  candidateComponentIds: [],
  clarificationUsed,
  resumedFromPending: clarificationUsed === 1,
  delegatedToModel: clarificationUsed === 1
})

describe('routing normalization and task reduction', () => {
  it('does not treat cancellation words inside a new edit as exact cancellation', () => {
    expect(pendingQuickRelation('算了，把按钮改成红色')).toBeNull()
    expect(pendingQuickRelation('算了')).toBe('cancel')
  })

  it('forces relation to none when no pending task exists', () => {
    const result = normalizeRoutingDecision({
      decision: { intent: 'local_edit', relationToPending: 'answer', reason: 'model hallucination' },
      source: 'context',
      pendingTask: null,
      message: '按钮改红色',
      currentPageId: 'page-1',
      currentRevision: 2,
      existingComponentIds: new Set()
    })
    expect(result.decision.relationToPending).toBe('none')
  })

  it('normalizes an unresolved answer after the single clarification to delegation', () => {
    const result = normalizeRoutingDecision({
      decision: { intent: 'unresolved', relationToPending: 'unresolved', reason: 'short reply' },
      source: 'tool',
      pendingTask: pending(),
      message: '随便',
      currentPageId: 'page-1',
      currentRevision: 2,
      existingComponentIds: new Set()
    })
    expect(result.decision.relationToPending).toBe('delegate')
    const reduction = reduceTaskState({
      decision: result.decision,
      pendingTask: result.pendingTask,
      message: '随便',
      pageId: 'page-1',
      pageRevision: 2
    })
    expect(reduction.action).toBe('edit')
    expect(reduction.action === 'edit' && reduction.task.delegatedToModel).toBe(true)
  })
})

describe('execution authorization', () => {
  it('does not grant deletion from a synthesized plan', () => {
    const policy = deriveExecutionPolicy({
      task: task(1),
      authorizationEvidence: { rootUserMessage: '优化页面', additionalUserMessages: [] },
      appliedFallbacks: [{ kind: 'use_conservative_plan', maxSteps: 2, operationLimit: 4 }]
    })
    expect(policy.allowDelete).toBe(false)
  })

  it('keeps delete disabled for 删除动画但不要删除组件', () => {
    const policy = deriveExecutionPolicy({
      task: task(0),
      authorizationEvidence: { rootUserMessage: '删除动画但不要删除组件', additionalUserMessages: [] }
    })
    expect(policy.allowDelete).toBe(false)
  })

  it('authorizes only signed targets after an affirmative deletion confirmation', () => {
    const policy = deriveExecutionPolicy({
      task: { ...task(1), targetComponentIds: ['button-1'] },
      authorizationEvidence: { rootUserMessage: '整理这个区域', additionalUserMessages: ['可以'] },
      pendingConfirmationEvidence: {
        clarificationCode: 'DELETION_AUTH_REQUIRED',
        clarificationSource: 'patch_generator',
        signedTargetComponentIds: ['button-1'],
        signedCandidateComponentIds: [],
        relation: 'answer',
        rawUserReply: '可以'
      }
    })
    expect(policy.deleteAuthorization).toEqual({
      authorized: true,
      source: 'signed_pending_confirmation',
      componentIds: ['button-1']
    })
  })

  it('keeps deletion disabled after a signed rejection', () => {
    const policy = deriveExecutionPolicy({
      task: { ...task(1), targetComponentIds: ['button-1'] },
      authorizationEvidence: { rootUserMessage: '整理这个区域', additionalUserMessages: ['不可以'] },
      pendingConfirmationEvidence: {
        clarificationCode: 'DELETION_AUTH_REQUIRED',
        clarificationSource: 'patch_generator',
        signedTargetComponentIds: ['button-1'],
        signedCandidateComponentIds: [],
        relation: 'answer',
        rawUserReply: '不可以'
      }
    })
    expect(policy.allowDelete).toBe(false)
    expect(policy.deleteAuthorization.componentIds).toEqual([])
  })

  it('uses the strictest limits from all conservative fallbacks', () => {
    const policy = deriveExecutionPolicy({
      task: task(1),
      authorizationEvidence: { rootUserMessage: '优化页面', additionalUserMessages: [] },
      appliedFallbacks: [
        { kind: 'use_conservative_plan', maxSteps: 4, operationLimit: 8 },
        { kind: 'use_conservative_plan', maxSteps: 2, operationLimit: 4 }
      ]
    })
    expect(policy.maxPlanSteps).toBe(2)
    expect(policy.operationLimit).toBe(4)
  })
})

describe('clarification broker', () => {
  const proposal: ClarificationProposal = {
    proposalId: 'proposal-1',
    source: 'component_locator',
    code: 'MISSING_EXECUTION_DATA',
    question: '希望添加什么方向的图片？',
    blocking: true,
    hasSafeFallback: true,
    affectedComponentCount: 0,
    fallback: { kind: 'use_model_defaults', allowedComponentIds: [] }
  }

  it('asks once and signs a pending task', () => {
    const decision = clarificationBroker({ task: task(0), proposals: [proposal], integritySecret: 'test-secret' })
    expect(decision.type).toBe('ask')
    expect(decision.type === 'ask' && decision.pendingTask.clarification.used).toBe(1)
  })

  it('uses deterministic fallback after the budget is consumed', () => {
    const decision = clarificationBroker({ task: task(1), proposals: [proposal], integritySecret: 'test-secret' })
    expect(decision).toEqual({ type: 'continue', appliedFallbacks: [proposal.fallback] })
  })

  it('stops a repeated late proposal instead of looping', () => {
    const decision = clarificationBroker({
      task: task(1),
      proposals: [proposal],
      integritySecret: 'test-secret',
      handledProposalIds: new Set(['proposal-1'])
    })
    expect(decision.type).toBe('no_change')
  })

  it('fails safely when an ambiguous target has no deterministic candidate', () => {
    const ambiguous: ClarificationProposal = {
      ...proposal,
      proposalId: 'proposal-empty-target',
      code: 'TARGET_AMBIGUOUS',
      fallback: { kind: 'select_best_candidate', orderedCandidateIds: [], evidence: [] }
    }
    const decision = clarificationBroker({ task: task(1), proposals: [ambiguous], integritySecret: 'test-secret' })
    expect(decision).toMatchObject({ type: 'execution_failed', code: 'NO_SAFE_TARGET_CANDIDATE' })
  })
})
