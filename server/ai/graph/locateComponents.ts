import type { RunnableConfig } from '@langchain/core/runnables'

import type { RagCandidate, RagComponentIndexItem } from '../../componentRag'
import { compactStructuredValue, createComponentLocatorSchema, strictResponseFormat } from '../../structuredSchemas'
import { buildAIComponentIndex, selectLocalPageComponents } from '../context/componentIndex'
import { OpenRouterError, type OpenRouterClient } from '../model/openRouterClient'
import {
  createProposal,
  fallbackForAmbiguousCandidates,
  rankComponentCandidates
} from './autonomousFallback'
import { isPureAddRequest } from './editActionAnalysis'
import {
  contextTargetIdsFor,
  deleteTargetIdsFor,
  editTargetIdsFor,
  preserveTargetIdsFor,
  taskHasAddAction
} from './editSemanticAnalysis'
import { createExecutionCheckpoint } from './executionCheckpoint'
import type { PageEditStateUpdate, PageEditStateValue } from './pageEditState'

export interface ComponentRetrievalResult {
  mode: 'vector' | 'lexical'
  warning?: string
  candidates: RagCandidate[]
}

export interface LocateComponentsDependencies {
  modelClient: Pick<OpenRouterClient, 'completeStructured'>
  retrieveCandidates: (
    query: string,
    componentIndex: RagComponentIndexItem[],
    signal?: AbortSignal
  ) => Promise<ComponentRetrievalResult>
}

class LocatorProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocatorProtocolError'
  }
}

const locatorErrorMessage = (error: unknown) => error instanceof Error
  ? error.message.slice(0, 300)
  : '未知组件定位错误'

const locatorWasAborted = (error: unknown, signal?: AbortSignal) => (
  Boolean(signal?.aborted)
  || (error instanceof OpenRouterError && error.code === 'ABORTED')
)

const locatorFailure = (state: PageEditStateValue, message: string): PageEditStateUpdate => ({
  status: 'error',
  result: {
    type: 'execution_failed',
    runId: state.runId,
    code: 'LOCATOR_MODEL_FAILED',
    message: `暂时无法可靠定位需要修改的组件：${message}`,
    retryable: true,
    pendingTask: state.pendingTask
  }
})

const pageContext = (state: PageEditStateValue): PageEditStateUpdate => {
  const actions = state.task?.actionScopes || []
  const hasSemanticScopes = actions.length > 0
  const canAdd = !hasSemanticScopes || actions.some((action) => action.kind === 'add')
  const canUpdatePage = !hasSemanticScopes || actions.some((action) => (
    action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace')
  ))
  return {
    componentIndex: buildAIComponentIndex(state.draftPage),
    activeComponentIndex: [],
    selectedComponentIds: [],
    editScope: 'page',
    allowedOperationKinds: [
      ...(canUpdatePage ? ['updatePageStyle'] : []),
      ...(canAdd ? ['addComponent'] : [])
    ],
    currentPageContext: {
      contextMode: isPureAddRequest(state.request) ? 'pure-add' : 'page',
      totalComponentCount: state.draftPage.components.length,
      page: {
        id: state.draftPage.id,
        meta: state.draftPage.meta,
        style: state.draftPage.style,
        responsiveOverrides: state.draftPage.responsiveOverrides
      }
    }
  }
}

const componentContext = (state: PageEditStateValue, targetIds: string[]): PageEditStateUpdate => {
  const selectedIds = new Set(targetIds)
  const componentIndex = buildAIComponentIndex(state.draftPage)
  const localComponents = selectLocalPageComponents(state.draftPage, targetIds)
  const localIds = new Set(localComponents.map((component) => component.id))
  const authorizedDeleteIds = new Set(state.executionPolicy?.deleteAuthorization.componentIds || [])
  const hasSemanticScopes = Boolean(state.task?.actionScopes?.length)
  const semanticEditIds = new Set(editTargetIdsFor(state.task))
  const semanticDeleteIds = new Set(deleteTargetIdsFor(state.task))
  const editableIds = hasSemanticScopes ? targetIds.filter((id) => semanticEditIds.has(id)) : targetIds
  const allowedDeleteIds = targetIds.filter((id) => (
    authorizedDeleteIds.has(id) && (!hasSemanticScopes || semanticDeleteIds.has(id))
  ))
  const canDelete = allowedDeleteIds.length > 0
    && (state.intent !== 'full_relayout' || state.relayoutAllowDeletion)
  const canEdit = editableIds.length > 0
  const canAdd = hasSemanticScopes && taskHasAddAction(state.task) && state.intent !== 'full_relayout'
  return {
    componentIndex,
    task: state.task && !hasSemanticScopes ? { ...state.task, targetComponentIds: targetIds } : state.task,
    activeComponentIndex: componentIndex.filter((item) => localIds.has(item.id)),
    selectedComponentIds: targetIds,
    editScope: 'components',
    allowedOperationKinds: [
      ...(canEdit ? ['updateProps', 'updateStyle', 'placeRelative', 'moveLayer'] : []),
      ...(canDelete ? ['removeComponent'] : []),
      ...(canAdd ? ['addComponent'] : []),
      ...(state.executionPolicy?.allowRegionalRelayout ? ['updatePageStyle'] : [])
    ],
    currentPageContext: {
      contextMode: state.intent === 'full_relayout' ? 'full-relayout-group' : 'localized',
      totalComponentCount: state.draftPage.components.length,
      page: {
        id: state.draftPage.id,
        meta: state.draftPage.meta,
        style: state.draftPage.style,
        responsiveOverrides: state.draftPage.responsiveOverrides
      },
      selectedComponentIds: targetIds,
      selectedComponents: state.draftPage.components.filter((component) => selectedIds.has(component.id)),
      nearbyComponents: localComponents,
      preservedComponentIds: preserveTargetIdsFor(state.task)
    },
    needsRelocate: false
  }
}

const proposalUpdate = (
  state: PageEditStateValue,
  input: { question: string; candidates: Array<RagCandidate | RagComponentIndexItem> }
): PageEditStateUpdate => {
  const ranked = rankComponentCandidates(state.request, input.candidates)
  const fallback = fallbackForAmbiguousCandidates(state.request, input.candidates)
  const proposal = createProposal({
    source: 'component_locator',
    code: 'TARGET_AMBIGUOUS',
    question: input.question.slice(0, 500),
    blocking: true,
    hasSafeFallback: fallback.kind !== 'select_best_candidate' || fallback.orderedCandidateIds.length > 0,
    affectedComponentCount: ranked.length,
    fallback
  })
  return {
    clarificationProposals: [proposal],
    executionCheckpoint: createExecutionCheckpoint(state, 'locate'),
    task: state.task ? {
      ...state.task,
      candidateComponentIds: ranked.slice(0, 12).map((item) => item.id)
    } : state.task
  }
}

export const createLocateComponentsNode = (dependencies: LocateComponentsDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  if (isPureAddRequest(state.request)) return pageContext(state)
  if (state.intent === 'full_relayout' && state.selectedComponentIds.length) {
    return componentContext(state, state.selectedComponentIds)
  }
  if (state.task?.actionScopes?.length) {
    const semanticTargetIds = contextTargetIdsFor(state.task)
      .filter((id) => state.draftPage.components.some((component) => component.id === id))
      .slice(0, 12)
    if (semanticTargetIds.length) return componentContext(state, semanticTargetIds)
    if (taskHasAddAction(state.task)) return pageContext(state)
  }
  const fallbackSelection = state.appliedFallbacks.find((fallback) => fallback.kind === 'select_best_candidate')
  const requestedIds = [
    ...(fallbackSelection?.kind === 'select_best_candidate' ? fallbackSelection.orderedCandidateIds.slice(0, 1) : []),
    ...(!state.task?.actionScopes?.length ? state.task?.targetComponentIds || [] : [])
  ].filter((id) => state.draftPage.components.some((component) => component.id === id))
  if (requestedIds.length) return componentContext(state, [...new Set(requestedIds)].slice(0, 12))
  const plannedStep = state.plan?.steps[state.stepIndex]
  if (plannedStep?.scope === 'page') return pageContext(state)

  const componentIndex = buildAIComponentIndex(state.draftPage)
  const pendingCandidates = state.task?.resumedFromPending && state.task.candidateComponentIds.length
    ? (() => {
        const pendingCandidateIds = new Set(state.task.candidateComponentIds)
        return componentIndex.filter((candidate) => pendingCandidateIds.has(candidate.id))
      })()
    : null
  const candidatePool = pendingCandidates || componentIndex
  const rankedDirect = rankComponentCandidates(
    pendingCandidates ? state.originalRequest : state.request,
    candidatePool
  )
  const direct = rankedDirect[0]
  const runnerUp = rankedDirect[1]
  if (direct && direct.evidence.some((item) => ['stable_id', 'exact_name', 'exact_text', 'unique_type'].includes(item))
    && (!runnerUp || direct.score > runnerUp.score)) {
    return componentContext(state, [direct.id])
  }
  const retrievalQuery = [
    `本轮请求：${state.request}`,
    state.conversationMemory.userGoals.length ? `用户目标：${state.conversationMemory.userGoals.slice(-2).join('；')}` : '',
    state.conversationMemory.designConstraints.length ? `设计约束：${state.conversationMemory.designConstraints.join('；')}` : '',
    state.recentMessages.length ? `最近对话：${state.recentMessages.slice(-4).map((item) => item.content).join('；')}` : ''
  ].filter(Boolean).join('\n')
  let retrieved: ComponentRetrievalResult
  if (!pendingCandidates && componentIndex.length > 40) {
    try {
      retrieved = await dependencies.retrieveCandidates(retrievalQuery, componentIndex, config?.signal)
    } catch (error) {
      if (locatorWasAborted(error, config?.signal)) throw error
      retrieved = {
        mode: 'lexical',
        warning: `RAG 检索失败，已降级本地候选：${locatorErrorMessage(error)}`,
        candidates: componentIndex.map((item) => ({ ...item, ragScore: 0, ragSignals: ['RAG 失败，本地候选'] }))
      }
    }
  } else {
    retrieved = {
      mode: 'lexical',
      candidates: candidatePool.map((item) => ({ ...item, ragScore: 1, ragSignals: [pendingCandidates ? '签名 pending 候选' : '小页面完整候选'] }))
    }
  }
  const candidates = retrieved.candidates.slice(0, !pendingCandidates && componentIndex.length > 40 ? 16 : candidatePool.length)
  let lastError = '组件定位模型没有返回有效结果。'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await dependencies.modelClient.completeStructured({
        messages: [
          {
            role: 'system',
            content: `你是低代码页面组件定位器，只从候选中选择本轮稳定组件 ID，不生成 Patch。纯新增使用 page scope。${state.executionPolicy?.canClarify ? '无法唯一确定时可返回 need_clarification。' : '澄清预算已用完，必须返回最保守的唯一 selection；不得选择全部候选。'}`
          },
          {
            role: 'user',
            content: JSON.stringify({ request: state.request, currentAnswer: state.originalRequest, candidates })
          }
        ],
        responseFormat: strictResponseFormat('component_selection', createComponentLocatorSchema(state.executionPolicy?.canClarify !== false)),
        signal: config?.signal,
        temperature: 0,
        maxTokens: 500
      })
      const compact = compactStructuredValue(completion.value)
      if (!compact || typeof compact !== 'object' || Array.isArray(compact)) {
        throw new LocatorProtocolError('组件定位结果不是 JSON 对象。')
      }
      const result = compact as Record<string, unknown>
      if (result.type === 'need_clarification') {
        if (state.executionPolicy?.canClarify === false) {
          throw new LocatorProtocolError('澄清预算已用完，Locator 不得再次请求澄清。')
        }
        if (typeof result.question !== 'string' || !result.question.trim()) {
          throw new LocatorProtocolError('组件定位澄清问题为空。')
        }
        return proposalUpdate(state, { question: result.question.trim(), candidates })
      }
      if (result.type !== 'selection') throw new LocatorProtocolError('组件定位结果类型无效。')
      if (result.scope === 'page') return pageContext(state)
      if (result.scope !== 'components') throw new LocatorProtocolError('组件定位 selection 缺少有效 scope。')
      const candidateIds = new Set(candidates.map((candidate) => candidate.id))
      const submittedIds = Array.isArray(result.componentIds)
        ? result.componentIds.filter((id): id is string => typeof id === 'string')
        : []
      if (!submittedIds.length || submittedIds.length > 12 || submittedIds.some((id) => !candidateIds.has(id))) {
        throw new LocatorProtocolError('组件定位 selection 引用了无效或越界的组件 ID。')
      }
      return componentContext(state, [...new Set(submittedIds)])
    } catch (error) {
      if (locatorWasAborted(error, config?.signal)) throw error
      lastError = locatorErrorMessage(error)
      if (error instanceof OpenRouterError && (
        error.code === 'UNAUTHORIZED'
        || (error.code === 'UPSTREAM_REJECTED' && error.status !== 429 && (error.status || 0) < 500)
      )) break
    }
  }

  const deterministic = fallbackForAmbiguousCandidates(
    pendingCandidates ? state.originalRequest : state.request,
    candidates
  )
  if (deterministic.kind === 'select_best_candidate' && deterministic.orderedCandidateIds.length) {
    return componentContext(state, deterministic.orderedCandidateIds.slice(0, 1))
  }
  return locatorFailure(state, lastError)
}
