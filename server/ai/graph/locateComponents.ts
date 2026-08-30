import type { RunnableConfig } from '@langchain/core/runnables'

import type { RagCandidate, RagComponentIndexItem } from '../../componentRag'
import {
  compactStructuredValue,
  componentLocatorSchema,
  strictResponseFormat
} from '../../structuredSchemas'
import { buildAIComponentIndex, selectLocalPageComponents } from '../context/componentIndex'
import type { OpenRouterClient } from '../model/openRouterClient'
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

const clarification = (state: PageEditStateValue, question: string): PageEditStateUpdate => ({
  status: 'clarification',
  result: { type: 'need_clarification', runId: state.runId, question }
})

const pageContext = (state: PageEditStateValue): PageEditStateUpdate => ({
  componentIndex: buildAIComponentIndex(state.draftPage),
  activeComponentIndex: [],
  selectedComponentIds: [],
  editScope: 'page',
  allowedOperationKinds: ['updatePageStyle', 'addComponent'],
  currentPageContext: {
    contextMode: 'page',
    totalComponentCount: state.draftPage.components.length,
    page: {
      id: state.draftPage.id,
      meta: state.draftPage.meta,
      style: state.draftPage.style,
      responsiveOverrides: state.draftPage.responsiveOverrides
    }
  }
})

const authorizedRelayoutContext = (state: PageEditStateValue): PageEditStateUpdate => {
  const selectedIds = new Set(state.selectedComponentIds)
  const componentIndex = buildAIComponentIndex(state.draftPage)
  const selectedComponents = state.draftPage.components.filter((component) => selectedIds.has(component.id))
  return {
    componentIndex,
    activeComponentIndex: componentIndex.filter((item) => selectedIds.has(item.id)),
    editScope: 'components',
    allowedOperationKinds: [
      'updateProps', 'updateStyle', 'placeRelative', 'moveLayer',
      ...(state.relayoutAllowDeletion ? ['removeComponent'] : [])
    ],
    currentPageContext: {
      contextMode: 'full-relayout-group',
      totalComponentCount: state.draftPage.components.length,
      selectedComponentIds: state.selectedComponentIds,
      selectedComponents,
      note: '当前组件由应用按稳定空间顺序确定性枚举；不得修改本组之外的组件。'
    }
  }
}

export const createLocateComponentsNode = (dependencies: LocateComponentsDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  if (state.intent === 'full_relayout' && state.selectedComponentIds.length) {
    return authorizedRelayoutContext(state)
  }
  const plannedStep = state.plan?.steps[state.stepIndex]
  if (plannedStep?.scope === 'page') return pageContext(state)

  const componentIndex = buildAIComponentIndex(state.draftPage)
  const retrievalQuery = [
    `本轮请求：${state.request}`,
    state.conversationMemory.openQuestions.length ? `未决问题：${state.conversationMemory.openQuestions.join('；')}` : '',
    state.conversationMemory.userGoals.length ? `用户目标：${state.conversationMemory.userGoals.slice(-2).join('；')}` : '',
    state.conversationMemory.designConstraints.length ? `设计约束：${state.conversationMemory.designConstraints.join('；')}` : '',
    state.recentMessages.length ? `最近对话：${state.recentMessages.slice(-4).map((item) => item.content).join('；')}` : ''
  ].filter(Boolean).join('\n')
  const retrieved = componentIndex.length > 40
    ? await dependencies.retrieveCandidates(retrievalQuery, componentIndex, config?.signal)
    : {
        mode: 'lexical' as const,
        candidates: componentIndex.map((item) => ({ ...item, ragScore: 1, ragSignals: ['小页面完整候选'] }))
      }
  const candidates = retrieved.candidates.slice(0, componentIndex.length > 40 ? 16 : componentIndex.length)

  const system = `你是低代码页面组件定位器。只从候选中选择用户本轮要修改的稳定组件 ID，不生成 Patch。位置关系修改必须同时选择被移动组件和参照组件。目标不明确或涉及超过 12 个组件时返回 need_clarification。纯页面背景、尺寸修改或新增组件使用 scope:"page"。`
  const completion = await dependencies.modelClient.completeStructured({
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          request: state.request,
          conversationMemory: state.conversationMemory,
          recentMessages: state.recentMessages,
          candidates
        })
      }
    ],
    responseFormat: strictResponseFormat('component_selection', componentLocatorSchema),
    signal: config?.signal,
    temperature: 0,
    maxTokens: 500
  })
  const result = compactStructuredValue(completion.value) as Record<string, unknown>
  if (result.type === 'need_clarification') {
    return clarification(
      state,
      typeof result.question === 'string' && result.question.trim()
        ? result.question.trim().slice(0, 500)
        : '请补充目标组件的名称、文案或所在区域。'
    )
  }
  if (result.type !== 'selection') return clarification(state, '暂时无法定位需要修改的组件，请补充组件名称或所在区域。')
  if (result.scope === 'page') return pageContext(state)

  const rawIds = Array.isArray(result.componentIds)
    ? result.componentIds.filter((id): id is string => typeof id === 'string')
    : []
  if (rawIds.length > 12) return clarification(state, '本轮涉及超过 12 个组件，请缩小修改范围。')
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const targetIds = [...new Set(rawIds.filter((id) => candidateIds.has(id)))]
  if (!targetIds.length) return clarification(state, '暂时无法唯一定位目标，请补充组件名称、当前文案或所在区域。')

  const localComponents = selectLocalPageComponents(state.draftPage, targetIds)
  const localIds = new Set(localComponents.map((component) => component.id))
  return {
    componentIndex,
    activeComponentIndex: componentIndex.filter((item) => localIds.has(item.id)),
    selectedComponentIds: targetIds,
    editScope: 'components',
    allowedOperationKinds: ['updateProps', 'updateStyle', 'placeRelative', 'removeComponent', 'moveLayer'],
    currentPageContext: {
      contextMode: 'localized',
      totalComponentCount: state.draftPage.components.length,
      page: {
        id: state.draftPage.id,
        meta: state.draftPage.meta,
        style: state.draftPage.style,
        responsiveOverrides: state.draftPage.responsiveOverrides
      },
      selectedComponentIds: targetIds,
      selectedComponents: localComponents
    }
  }
}
