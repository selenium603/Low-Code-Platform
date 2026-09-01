import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import type { ModelRoutingDecision, NormalizedRoutingDecision } from '../../../src/types/aiPatch'
import { createAnswerQuestionNode } from './answerQuestion'
import {
  createProposal,
  fallbackForAmbiguousCandidates,
  rankComponentCandidates
} from './autonomousFallback'
import { clarificationBroker } from './clarificationBroker'
import { createFullRelayoutGraph, type FullRelayoutGraphDependencies } from './fullRelayoutGraph'
import { classifyPageEditIntent } from './intentRouter'
import { createLargeEditGraph, type LargeEditGraphDependencies } from './largeEditGraph'
import { createLocalEditGraph } from './localEditGraph'
import { createContextIntentNode, createToolIntentNode, type ModelIntentRouterDependencies } from './modelIntentRouter'
import { hasEffectivePageChange } from './pageChange'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'
import { deriveExecutionPolicy } from './executionPolicy'
import { analyzeEditActions, isPureAddRequest } from './editActionAnalysis'
import {
  contextTargetIdsFor,
  createEditSemanticAnalysisNode
} from './editSemanticAnalysis'
import { buildAIComponentIndex } from '../context/componentIndex'
import { normalizeRoutingDecision, pendingQuickRelation } from './routingDecision'
import { effectiveTaskRequest, reduceTaskState } from './taskReducer'

export interface PageEditAgentDependencies extends FullRelayoutGraphDependencies, LargeEditGraphDependencies, ModelIntentRouterDependencies {}

const isVagueImageAddition = (request: string) => (
  isPureAddRequest(request)
  && /图片|图像|image/i.test(request)
  && request.trim().length <= 16
  && !/产品|人物|场景|背景|装饰|截图|照片|风格|主题|品牌|URL|https?:/i.test(request)
)

export const createPageEditAgent = (dependencies: PageEditAgentDependencies) => {
  const localGraph = createLocalEditGraph(dependencies)
  const largeGraph = createLargeEditGraph(dependencies)
  const fullGraph = createFullRelayoutGraph(dependencies)
  const invoke = (graph: { invoke(state: PageEditStateValue, config?: RunnableConfig): Promise<PageEditStateValue> }) => (
    state: PageEditStateValue,
    config?: RunnableConfig
  ) => graph.invoke(state, config)

  const ruleIntentNode = (state: PageEditStateValue): PageEditStateUpdate => {
    const quick = state.pendingTask ? pendingQuickRelation(state.originalRequest) : null
    if (quick) {
      const decision: ModelRoutingDecision = {
        intent: quick === 'cancel' ? 'cancel' : state.pendingTask!.taskIntent,
        relationToPending: quick,
        reason: `整句规则命中 pending ${quick}。`
      }
      return {
        routingDecision: decision,
        intent: decision.intent,
        routingSource: 'rule',
        routingReason: decision.reason,
        status: 'running',
        routingTrace: [...state.routingTrace, { source: 'rule', outcome: 'resolved', reason: decision.reason }]
      }
    }
    if (state.pendingTask) {
      return {
        routingDecision: null,
        intent: 'unresolved',
        status: 'running',
        routingSource: null,
        routingReason: '存在未决任务，整句规则未命中，交给上下文关系分类。',
        routingTrace: [...state.routingTrace, {
          source: 'rule', outcome: 'fallback', reason: 'pending 消息需要判断与旧任务的关系。'
        }]
      }
    }
    const intent = isPureAddRequest(state.originalRequest)
      ? 'local_edit' as const
      : classifyPageEditIntent(state.originalRequest, state.draftPage.components.length)
    if (intent === 'unresolved') {
      return {
        routingDecision: null,
        intent,
        status: 'running',
        routingSource: null,
        routingReason: '确定性规则未获得足够证据。',
        routingTrace: [...state.routingTrace, { source: 'rule', outcome: 'fallback', reason: '确定性规则未获得足够证据。' }]
      }
    }
    const decision: ModelRoutingDecision = {
      intent,
      relationToPending: state.pendingTask && intent !== 'question' ? 'replace' : state.pendingTask ? 'question' : 'none',
      reason: `确定性规则命中 ${intent}。`
    }
    return {
      routingDecision: decision,
      intent,
      status: 'running',
      routingSource: 'rule',
      routingReason: decision.reason,
      routingTrace: [...state.routingTrace, { source: 'rule', outcome: 'resolved', reason: decision.reason }]
    }
  }

  const normalizeRoutingNode = (state: PageEditStateValue): PageEditStateUpdate => {
    if (!state.routingDecision || !state.routingSource) {
      return {
        status: 'error',
        result: {
          type: 'execution_failed', runId: state.runId, code: 'MISSING_ROUTING_DECISION',
          message: '没有获得有效的意图路由结果。', retryable: true, pendingTask: state.pendingTask
        }
      }
    }
    const normalized = normalizeRoutingDecision({
      decision: state.routingDecision,
      source: state.routingSource,
      pendingTask: state.pendingTask,
      message: state.originalRequest,
      currentPageId: state.pageId,
      currentRevision: state.baseRevision,
      existingComponentIds: new Set(state.draftPage.components.map((component) => component.id))
    })
    return {
      routingDecision: normalized.decision,
      pendingTask: normalized.pendingTask,
      intent: normalized.decision.intent,
      routingReason: normalized.decision.reason
    }
  }

  const reduceTaskNode = (state: PageEditStateValue): PageEditStateUpdate => {
    const decision = state.routingDecision as NormalizedRoutingDecision | null
    if (!decision) return {}
    const reduction = reduceTaskState({
      decision,
      pendingTask: state.pendingTask,
      message: state.originalRequest,
      pageId: state.pageId,
      pageRevision: state.baseRevision
    })
    if (reduction.action === 'cancel') {
      return {
        task: null,
        pendingTask: null,
        status: 'completed',
        result: { type: 'task_cancelled', runId: state.runId, message: '已取消上一轮未完成的页面修改。' }
      }
    }
    if (reduction.action === 'question' || reduction.action === 'chat') {
      return { task: null, pendingTask: reduction.pendingTask, intent: reduction.action }
    }
    if (reduction.action === 'failed') {
      return {
        task: null,
        pendingTask: reduction.pendingTask,
        status: 'error',
        result: {
          type: 'execution_failed', runId: state.runId, code: 'UNRESOLVED_EDIT_INTENT',
          message: reduction.message, retryable: true, pendingTask: reduction.pendingTask
        }
      }
    }
    if (reduction.action !== 'edit') return {}
    return {
      task: reduction.task,
      pendingTask: reduction.pendingTask,
      intent: reduction.task.intent,
      request: effectiveTaskRequest(reduction.task),
      authorizationEvidence: {
        rootUserMessage: reduction.task.rootRequest,
        additionalUserMessages: [...reduction.task.additionalInstructions]
      },
      pendingConfirmationEvidence: reduction.pendingConfirmationEvidence,
      selectedComponentIds: [...reduction.task.targetComponentIds],
      clarificationProposals: [],
      appliedFallbacks: reduction.resumeFallbacks,
      result: null
    }
  }

  const preflightNode = (state: PageEditStateValue): PageEditStateUpdate => {
    if (!state.task) return {}
    const proposals = []
    let task = state.task
    if (isVagueImageAddition(state.task.rootRequest)) {
      proposals.push(createProposal({
        source: 'component_locator',
        code: 'MISSING_EXECUTION_DATA',
        question: '希望添加什么内容或风格的图片？如果没有偏好，也可以告诉我“随便”。',
        blocking: true,
        hasSafeFallback: true,
        affectedComponentCount: 0,
        fallback: { kind: 'use_model_defaults', allowedComponentIds: [] }
      }))
    }

    const actionAnalysis = analyzeEditActions(state.request)
    const positiveDelete = actionAnalysis.mentions.filter((mention) => mention.kind === 'delete' && !mention.negated)
    const hasDeleteRejection = actionAnalysis.mentions.some((mention) => mention.kind === 'delete' && mention.negated)
    if (positiveDelete.length && !hasDeleteRejection && !task.targetComponentIds.length && !task.actionScopes?.length) {
      const componentIndex = buildAIComponentIndex(state.draftPage)
      const hintedTypes = new Set(positiveDelete.flatMap((mention) => mention.componentTypes))
      const candidates = hintedTypes.size
        ? componentIndex.filter((candidate) => hintedTypes.has(candidate.type as never))
        : componentIndex
      const requestsAll = /(?:全部|所有|每个).{0,8}(?:组件|按钮|图片|图像|文本|标题|表单|图表|输入框)/i.test(state.request)
      const ranked = rankComponentCandidates(state.request, candidates)
      const best = ranked[0]
      const runnerUp = ranked[1]
      const hasUniqueEvidence = Boolean(best?.evidence.some((evidence) => (
        evidence === 'stable_id' || evidence === 'exact_name' || evidence === 'exact_text' || evidence === 'unique_type'
      ))) && (!runnerUp || best!.score > runnerUp.score)
      const targetIds = requestsAll && candidates.length <= 12
        ? candidates.map((candidate) => candidate.id)
        : hasUniqueEvidence && best ? [best.id] : []
      if (targetIds.length) {
        task = {
          ...task,
          candidateComponentIds: [],
          actionScopes: [{
            actionId: 'delete-1',
            kind: 'delete',
            instruction: state.request.slice(0, 500),
            targetScope: 'components',
            componentTypes: [...hintedTypes],
            targetComponentIds: targetIds
          }]
        }
      } else {
        const fallback = fallbackForAmbiguousCandidates(state.request, candidates)
        task = { ...task, candidateComponentIds: ranked.slice(0, 12).map((candidate) => candidate.id) }
        proposals.push(createProposal({
          source: 'router',
          code: 'TARGET_AMBIGUOUS',
          question: '请说明需要删除的具体组件名称、当前文案或所在区域。',
          blocking: true,
          hasSafeFallback: fallback.kind === 'select_best_candidate' && fallback.orderedCandidateIds.length > 0,
          affectedComponentCount: candidates.length,
          fallback
        }))
      }
    }

    return {
      task,
      selectedComponentIds: task.actionScopes?.length ? contextTargetIdsFor(task) : [...task.targetComponentIds],
      clarificationProposals: proposals
    }
  }

  const brokerNode = (state: PageEditStateValue): PageEditStateUpdate => {
    if (!state.task) return {}
    const decision = clarificationBroker({
      task: state.task,
      proposals: state.clarificationProposals,
      integritySecret: state.pendingIntegritySecret,
      handledProposalIds: new Set(state.handledProposalIds)
    })
    if (decision.type === 'ask') {
      return {
        draftPage: state.originalPage,
        pendingTask: decision.pendingTask,
        status: 'clarification',
        result: {
          type: 'clarification_requested',
          runId: state.runId,
          question: decision.question,
          pendingTask: decision.pendingTask
        }
      }
    }
    if (decision.type === 'no_change') {
      return {
        draftPage: state.originalPage,
        status: 'completed',
        result: { type: 'no_change', runId: state.runId, message: decision.message, retryable: true }
      }
    }
    if (decision.type === 'execution_failed') {
      return {
        draftPage: state.originalPage,
        status: 'error',
        result: { ...decision, type: 'execution_failed', runId: state.runId, pendingTask: state.pendingTask }
      }
    }
    const selection = decision.appliedFallbacks.find((fallback) => fallback.kind === 'select_best_candidate')
    const geometry = decision.appliedFallbacks.find((fallback) => fallback.kind === 'limit_geometry_scope')
    const useDefaults = decision.appliedFallbacks.some((fallback) => fallback.kind === 'use_model_defaults')
    const targetIds = selection?.kind === 'select_best_candidate'
      ? selection.orderedCandidateIds.slice(0, 1)
      : geometry?.kind === 'limit_geometry_scope'
        ? geometry.allowedComponentIds.slice(0, geometry.maxAffectedComponents)
        : state.task.targetComponentIds
    const selectedDeleteIds = selection?.kind === 'select_best_candidate'
      && analyzeEditActions(state.request).mentions.some((mention) => mention.kind === 'delete' && !mention.negated)
      ? targetIds
      : []
    const actionScopes = selectedDeleteIds.length && !state.task.actionScopes?.length
      ? [{
          actionId: 'delete-1', kind: 'delete' as const, instruction: state.request.slice(0, 500),
          targetScope: 'components' as const, componentTypes: [], targetComponentIds: selectedDeleteIds
        }]
      : state.task.actionScopes
    return {
      task: {
        ...state.task,
        targetComponentIds: actionScopes?.length ? state.task.targetComponentIds : targetIds,
        actionScopes,
        delegatedToModel: state.task.delegatedToModel || useDefaults
      },
      selectedComponentIds: actionScopes?.length ? contextTargetIdsFor({ ...state.task, actionScopes }) : targetIds,
      appliedFallbacks: [...state.appliedFallbacks, ...decision.appliedFallbacks],
      handledProposalIds: [...new Set([...state.handledProposalIds, ...state.clarificationProposals.map((proposal) => proposal.proposalId)])],
      clarificationProposals: [],
      brokerPass: state.brokerPass + 1,
      result: null
    }
  }

  const derivePolicyNode = (state: PageEditStateValue): PageEditStateUpdate => {
    if (!state.task || !state.authorizationEvidence) return {}
    const executionPolicy = deriveExecutionPolicy({
      task: state.task,
      authorizationEvidence: state.authorizationEvidence,
      appliedFallbacks: state.appliedFallbacks,
      pendingConfirmationEvidence: state.pendingConfirmationEvidence
    })
    return {
      executionPolicy,
      operationLimit: Math.min(12, executionPolicy.operationLimit)
    }
  }

  const verifyEffectiveChange = (state: PageEditStateValue): PageEditStateUpdate => {
    if (state.result?.type !== 'page_edit_completed') return {}
    if (hasEffectivePageChange(state.originalPage, state.draftPage)) {
      return { result: { ...state.result, executedRequest: state.request } }
    }
    return {
      draftPage: state.originalPage,
      status: 'completed',
      result: {
        type: 'no_change', runId: state.runId,
        message: '本次 AI 操作没有产生有效页面修改，页面保持不变。', retryable: true
      }
    }
  }

  return new StateGraph(PageEditState)
    .addNode('ruleIntent', ruleIntentNode)
    .addNode('contextIntent', createContextIntentNode(dependencies))
    .addNode('toolIntent', createToolIntentNode(dependencies))
    .addNode('normalizeRouting', normalizeRoutingNode)
    .addNode('reduceTask', reduceTaskNode)
    .addNode('analyzeActions', createEditSemanticAnalysisNode(dependencies))
    .addNode('answerQuestion', createAnswerQuestionNode(dependencies))
    .addNode('preflight', preflightNode)
    .addNode('broker', brokerNode)
    .addNode('derivePolicy', derivePolicyNode)
    .addNode('localEdit', invoke(localGraph))
    .addNode('largeEdit', invoke(largeGraph))
    .addNode('fullRelayout', invoke(fullGraph))
    .addNode('verifyEffectiveChange', verifyEffectiveChange)
    .addEdge(START, 'ruleIntent')
    .addConditionalEdges('ruleIntent', (state) => state.routingDecision ? 'normalize' : 'context', {
      normalize: 'normalizeRouting', context: 'contextIntent'
    })
    .addConditionalEdges('contextIntent', (state) => state.routingDecision ? 'normalize' : 'tool', {
      normalize: 'normalizeRouting', tool: 'toolIntent'
    })
    .addConditionalEdges('toolIntent', (state) => state.result ? 'done' : 'normalize', {
      done: END, normalize: 'normalizeRouting'
    })
    .addEdge('normalizeRouting', 'reduceTask')
    .addConditionalEdges('reduceTask', (state) => {
      if (state.result) return 'done'
      if (state.intent === 'question' || state.intent === 'chat') return 'qa'
      return 'edit'
    }, { done: END, qa: 'answerQuestion', edit: 'analyzeActions' })
    .addEdge('answerQuestion', END)
    .addConditionalEdges('analyzeActions', (state) => {
      if (state.result) return 'done'
      return state.clarificationProposals.length ? 'broker' : 'preflight'
    }, { done: END, broker: 'broker', preflight: 'preflight' })
    .addConditionalEdges('preflight', (state) => state.clarificationProposals.length ? 'broker' : 'policy', {
      broker: 'broker', policy: 'derivePolicy'
    })
    .addConditionalEdges('broker', (state) => state.result ? 'done' : 'policy', {
      done: END, policy: 'derivePolicy'
    })
    .addConditionalEdges('derivePolicy', (state) => state.intent, {
      local_edit: 'localEdit', large_edit: 'largeEdit', full_relayout: 'fullRelayout',
      question: 'answerQuestion', chat: 'answerQuestion', cancel: END, unresolved: END
    })
    .addConditionalEdges('localEdit', (state) => state.clarificationProposals.length ? 'broker' : 'verify', { broker: 'broker', verify: 'verifyEffectiveChange' })
    .addConditionalEdges('largeEdit', (state) => state.clarificationProposals.length ? 'broker' : 'verify', { broker: 'broker', verify: 'verifyEffectiveChange' })
    .addConditionalEdges('fullRelayout', (state) => state.clarificationProposals.length ? 'broker' : 'verify', { broker: 'broker', verify: 'verifyEffectiveChange' })
    .addEdge('verifyEffectiveChange', END)
    .compile()
}
