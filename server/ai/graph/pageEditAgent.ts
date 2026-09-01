import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { ComponentType } from '../../../src/types'
import type { AIEditActionScope, ModelRoutingDecision } from '../../../src/types/aiPatch'
import { createAnswerQuestionNode } from './answerQuestion'
import {
  createProposal,
  fallbackForAmbiguousCandidates,
  rankComponentCandidates
} from './autonomousFallback'
import { clarificationBroker } from './clarificationBroker'
import { classifyPageEditIntent } from './intentRouter'
import { createContextIntentNode, type ModelIntentRouterDependencies } from './modelIntentRouter'
import { hasEffectivePageChange } from './pageChange'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'
import { deriveExecutionPolicy } from './executionPolicy'
import { analyzeEditActions, detectComponentTypes, isPureAddRequest } from './editActionAnalysis'
import {
  contextTargetIdsFor,
  createEditSemanticAnalysisNode
} from './editSemanticAnalysis'
import { buildAIComponentIndex } from '../context/componentIndex'
import { normalizeRoutingDecision, pendingQuickRelation } from './routingDecision'
import { effectiveTaskRequest, reduceTaskState } from './taskReducer'
import { createExecutionUnits } from './executionUnits'
import { createUnitExecutorGraph, type UnitExecutorDependencies } from './unitExecutorGraph'

export interface PageEditAgentDependencies extends UnitExecutorDependencies, ModelIntentRouterDependencies {}

const isVagueImageAddition = (request: string) => (
  isPureAddRequest(request)
  && /图片|图像|image/i.test(request)
  && request.trim().length <= 16
  && !/产品|人物|场景|背景|装饰|截图|照片|风格|主题|品牌|URL|https?:/i.test(request)
)

export const createPageEditAgent = (dependencies: PageEditAgentDependencies) => {
  const unitExecutor = createUnitExecutorGraph(dependencies)
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

  const materializeTaskNode = (state: PageEditStateValue): PageEditStateUpdate => {
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
    const reduction = reduceTaskState({
      decision: normalized.decision,
      pendingTask: normalized.pendingTask,
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
      selectedComponentIds: contextTargetIdsFor(reduction.task),
      clarificationProposals: [],
      appliedFallbacks: reduction.resumeFallbacks,
      result: null
    }
  }

  const prepareExecutionNode = (state: PageEditStateValue): PageEditStateUpdate => {
    if (!state.task || !state.authorizationEvidence) return {}
    const componentIndex = buildAIComponentIndex(state.originalPage)
    const typeById = new Map(componentIndex.map((component) => [component.id, component.type as ComponentType]))
    const proposals = []
    let task = state.task

    if (!task.actionScopes.length) {
      const analysis = analyzeEditActions(state.request)
      const positiveDelete = analysis.mentions.filter((mention) => mention.kind === 'delete' && !mention.negated)
      const positiveReplace = analysis.mentions.filter((mention) => mention.kind === 'replace' && !mention.negated)
      if (analysis.isPureAdd) {
        task = {
          ...task,
          actionScopes: [{
            actionId: 'add-1',
            kind: 'add',
            instruction: state.request.slice(0, 500),
            targetScope: 'page',
            componentTypes: analysis.positiveAddTypes,
            targetComponentIds: [],
            candidateComponentIds: []
          }]
        }
      } else if (/(?:页面|画布).{0,8}(?:背景|颜色|宽度|高度|尺寸)|(?:页面背景|画布背景)/i.test(state.request)) {
        task = {
          ...task,
          actionScopes: [{
            actionId: 'page-update-1',
            kind: 'update',
            instruction: state.request.slice(0, 500),
            targetScope: 'page',
            componentTypes: [],
            targetComponentIds: [],
            candidateComponentIds: []
          }]
        }
      } else {
        const kind: AIEditActionScope['kind'] = positiveDelete.length
          ? 'delete'
          : positiveReplace.length ? 'replace' : 'update'
        const hintedTypes = kind === 'delete'
          ? [...new Set(positiveDelete.flatMap((mention) => mention.componentTypes))]
          : detectComponentTypes(state.request)
        task = {
          ...task,
          actionScopes: [{
            actionId: `${kind}-1`,
            kind,
            instruction: state.request.slice(0, 500),
            targetScope: 'components',
            componentTypes: hintedTypes,
            targetComponentIds: [],
            candidateComponentIds: []
          }]
        }
      }
    }

    if (isVagueImageAddition(task.rootRequest) && !task.delegatedToModel) {
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

    const requestsAll = /(?:全部|所有|每个).{0,8}(?:组件|按钮|图片|图像|文本|标题|表单|图表|输入框)/i.test(state.request)
    const actionScopes = task.actionScopes.map((action) => {
      if (action.targetScope === 'page' || action.targetComponentIds.length) return action
      const signedCandidates = action.candidateComponentIds.length
        ? new Set(action.candidateComponentIds)
        : null
      const candidates = componentIndex.filter((candidate) => (
        (!signedCandidates || signedCandidates.has(candidate.id))
        && (!action.componentTypes.length || action.componentTypes.includes(candidate.type as ComponentType))
      ))
      const ranked = rankComponentCandidates(state.request, candidates)
      const best = ranked[0]
      const runnerUp = ranked[1]
      const hasUniqueEvidence = Boolean(best?.evidence.some((evidence) => (
        evidence === 'stable_id' || evidence === 'exact_name' || evidence === 'exact_text' || evidence === 'unique_type'
      ))) && (!runnerUp || best!.score > runnerUp.score)
      const targetComponentIds = requestsAll && candidates.length > 0 && candidates.length <= 12
        ? candidates.map((candidate) => candidate.id)
        : hasUniqueEvidence && best ? [best.id] : []
      if (targetComponentIds.length) {
        return {
          ...action,
          componentTypes: [...new Set(targetComponentIds.map((id) => typeById.get(id)!).filter(Boolean))],
          targetComponentIds,
          candidateComponentIds: []
        }
      }
      const candidateComponentIds = ranked.slice(0, 12).map((candidate) => candidate.id)
      const fallback = fallbackForAmbiguousCandidates(state.request, candidates)
      proposals.push(createProposal({
        source: 'component_locator',
        code: 'TARGET_AMBIGUOUS',
        question: action.kind === 'delete'
          ? '请说明需要删除的具体组件名称、当前文案或所在区域。'
          : '请说明需要修改的具体组件名称、当前文案或所在区域。',
        blocking: true,
        hasSafeFallback: fallback.kind === 'select_best_candidate' && fallback.orderedCandidateIds.length > 0,
        affectedComponentCount: candidates.length,
        fallback
      }))
      return { ...action, candidateComponentIds }
    })
    task = { ...task, actionScopes }

    const executionPolicy = deriveExecutionPolicy({
      task,
      authorizationEvidence: state.authorizationEvidence,
      appliedFallbacks: state.appliedFallbacks,
      pendingConfirmationEvidence: state.pendingConfirmationEvidence
    })
    const executionUnits = createExecutionUnits({ task, page: state.originalPage, policy: executionPolicy })
    if (!proposals.length && !executionUnits.length) {
      return {
        task,
        executionPolicy,
        status: 'error',
        result: {
          type: 'execution_failed', runId: state.runId, code: 'MISSING_EXECUTION_UNITS',
          message: '服务端无法为当前任务生成安全的 Execution Units。', retryable: true, pendingTask: state.pendingTask
        }
      }
    }
    const currentUnitId = state.executionUnits[state.unitIndex]?.id
    const matchedUnitIndex = currentUnitId
      ? executionUnits.findIndex((unit) => unit.id === currentUnitId)
      : -1
    const resumedUnitIndex = state.brokerPass > 0
      ? matchedUnitIndex >= 0
        ? matchedUnitIndex
        : Math.min(state.unitIndex, Math.max(0, executionUnits.length - 1))
      : 0
    return {
      task,
      selectedComponentIds: contextTargetIdsFor(task),
      clarificationProposals: proposals,
      executionPolicy,
      executionUnits,
      unitIndex: resumedUnitIndex,
      unitSummaries: state.brokerPass > 0 ? state.unitSummaries : [],
      operationLimit: Math.min(12, executionPolicy.operationLimit),
      currentPatch: null,
      previousPatch: null,
      validationError: null,
      modelAttempt: 0,
      repairAttempt: 0,
      noOpRetry: 0,
      geometryRepairAttempt: 0,
      needsRelocate: false
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
    let actionScopes = state.task.actionScopes
    if (selection?.kind === 'select_best_candidate') {
      const selectedIds = selection.orderedCandidateIds.slice(0, 1)
      const unresolvedIndex = actionScopes.findIndex((action) => (
        !action.targetComponentIds.length && action.candidateComponentIds.length
      ))
      if (unresolvedIndex >= 0 && selectedIds.length) {
        actionScopes = actionScopes.map((action, index) => index === unresolvedIndex
          ? { ...action, targetComponentIds: selectedIds, candidateComponentIds: [] }
          : action)
      }
    }
    if (geometry?.kind === 'limit_geometry_scope') {
      const geometryIds = geometry.allowedComponentIds.slice(0, geometry.maxAffectedComponents)
      const updateIndex = actionScopes.findIndex((action) => action.kind === 'update' && action.targetScope === 'components')
      actionScopes = updateIndex >= 0
        ? actionScopes.map((action, index) => index === updateIndex
            ? { ...action, targetComponentIds: [...new Set([...action.targetComponentIds, ...geometryIds])] }
            : action)
        : [...actionScopes, {
            actionId: 'geometry-repair', kind: 'update' as const,
            instruction: '在用户授权的局部范围内修复几何冲突。', targetScope: 'components' as const,
            componentTypes: [], targetComponentIds: geometryIds, candidateComponentIds: []
          }]
    }
    return {
      task: {
        ...state.task,
        actionScopes,
        delegatedToModel: state.task.delegatedToModel || useDefaults
      },
      selectedComponentIds: contextTargetIdsFor({ actionScopes }),
      appliedFallbacks: [...state.appliedFallbacks, ...decision.appliedFallbacks],
      handledProposalIds: [...new Set([...state.handledProposalIds, ...state.clarificationProposals.map((proposal) => proposal.proposalId)])],
      clarificationProposals: [],
      brokerPass: state.brokerPass + 1,
      result: null
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
    .addNode('materializeTask', materializeTaskNode)
    .addNode('analyzeActions', createEditSemanticAnalysisNode(dependencies))
    .addNode('answerQuestion', createAnswerQuestionNode(dependencies))
    .addNode('prepareExecution', prepareExecutionNode)
    .addNode('broker', brokerNode)
    .addNode('executeUnits', invoke(unitExecutor))
    .addNode('verifyEffectiveChange', verifyEffectiveChange)
    .addEdge(START, 'ruleIntent')
    .addConditionalEdges('ruleIntent', (state) => state.routingDecision ? 'materialize' : 'context', {
      materialize: 'materializeTask', context: 'contextIntent'
    })
    .addConditionalEdges('contextIntent', (state) => state.result ? 'done' : 'materialize', {
      done: END, materialize: 'materializeTask'
    })
    .addConditionalEdges('materializeTask', (state) => {
      if (state.result) return 'done'
      if (state.intent === 'question' || state.intent === 'chat') return 'qa'
      return 'edit'
    }, { done: END, qa: 'answerQuestion', edit: 'analyzeActions' })
    .addEdge('answerQuestion', END)
    .addConditionalEdges('analyzeActions', (state) => {
      if (state.result) return 'done'
      return state.clarificationProposals.length ? 'broker' : 'prepare'
    }, { done: END, broker: 'broker', prepare: 'prepareExecution' })
    .addConditionalEdges('prepareExecution', (state) => state.result ? 'done' : state.clarificationProposals.length ? 'broker' : 'execute', {
      done: END, broker: 'broker', execute: 'executeUnits'
    })
    .addConditionalEdges('broker', (state) => state.result ? 'done' : 'prepare', {
      done: END, prepare: 'prepareExecution'
    })
    .addConditionalEdges('executeUnits', (state) => state.clarificationProposals.length ? 'broker' : 'verify', {
      broker: 'broker', verify: 'verifyEffectiveChange'
    })
    .addEdge('verifyEffectiveChange', END)
    .compile()
}
