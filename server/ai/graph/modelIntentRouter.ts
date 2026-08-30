import type { RunnableConfig } from '@langchain/core/runnables'

import {
  compactStructuredValue,
  contextIntentSchema,
  strictResponseFormat,
  toolRouteSchema
} from '../../structuredSchemas'
import type { OpenRouterClient } from '../model/openRouterClient'
import type { PageEditIntent, PageEditRoutingTraceStep, PageEditStateUpdate, PageEditStateValue } from './pageEditState'

type StructuredClient = Pick<OpenRouterClient, 'completeStructured'>

export interface ModelIntentRouterDependencies {
  contextModelClient?: StructuredClient
  modelClient: StructuredClient
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
)

const appendTrace = (state: PageEditStateValue, step: PageEditRoutingTraceStep) => [
  ...(state.routingTrace || []),
  step
]

const errorMessage = (error: unknown) => (
  error instanceof Error ? error.message.slice(0, 300) : '未知模型错误'
)

const compactRoutingContext = (state: PageEditStateValue) => {
  const componentTypes = state.draftPage.components.reduce<Record<string, number>>((counts, component) => {
    counts[component.type] = (counts[component.type] || 0) + 1
    return counts
  }, {})
  return {
    request: state.originalRequest,
    recentMessages: state.recentMessages.slice(-6).map(({ role, content }) => ({ role, content })),
    conversationMemory: state.conversationMemory,
    pageSummary: {
      componentCount: state.draftPage.components.length,
      componentTypes
    },
    lastCompletedChange: state.conversationMemory.completedChanges.at(-1) || null
  }
}

const contextLabels = new Set(['local_edit', 'large_edit', 'full_relayout', 'question', 'need_clarification'])

export const createContextIntentNode = (dependencies: ModelIntentRouterDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  if (!dependencies.contextModelClient) {
    return {
      intent: 'unresolved',
      routingReason: '未配置上下文语义模型，进入工具路由兜底。',
      routingTrace: appendTrace(state, { source: 'context', outcome: 'fallback', reason: '未配置上下文语义模型。' })
    }
  }
  try {
    const completion = await dependencies.contextModelClient.completeStructured({
      messages: [
        {
          role: 'system',
          content: `你是低代码页面编辑入口的上下文意图分类器，只分类，不生成页面、Patch 或计划。
可选 label：local_edit（明确的局部组件或页面样式修改）、large_edit（跨区域、多步骤或大量增删）、full_relayout（所有组件或整页重新排版）、question（用户只咨询，不要求执行修改）、need_clarification（结合上下文仍缺少执行所需的关键信息）。
结合最近对话解析“继续、其他地方、和刚才一样”等指代。need_clarification 时必须给出一个具体且简短的 clarificationQuestion；其他 label 的 clarificationQuestion 必须为 null。只输出符合 Schema 的 JSON。`
        },
        { role: 'user', content: JSON.stringify(compactRoutingContext(state)) }
      ],
      responseFormat: strictResponseFormat('page_edit_context_intent', contextIntentSchema),
      signal: config?.signal,
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 4_000
    })
    const value = compactStructuredValue(completion.value)
    if (!isRecord(value) || !contextLabels.has(String(value.label)) || typeof value.reason !== 'string' || !value.reason.trim()) {
      throw new Error('上下文模型返回了无效的意图结果。')
    }
    if (value.label === 'need_clarification') {
      if (typeof value.clarificationQuestion !== 'string' || !value.clarificationQuestion.trim()) {
        throw new Error('上下文模型未给出具体澄清问题。')
      }
      return {
        intent: 'question',
        routingSource: 'context',
        routingReason: value.reason.trim().slice(0, 300),
        clarificationQuestion: value.clarificationQuestion.trim().slice(0, 500),
        routingTrace: appendTrace(state, { source: 'context', outcome: 'clarification', reason: value.reason.trim().slice(0, 300) })
      }
    }
    return {
      intent: value.label as PageEditIntent,
      routingSource: 'context',
      routingReason: value.reason.trim().slice(0, 300),
      clarificationQuestion: null,
      routingTrace: appendTrace(state, { source: 'context', outcome: 'resolved', reason: value.reason.trim().slice(0, 300) })
    }
  } catch (error) {
    return {
      intent: 'unresolved',
      routingSource: 'context',
      routingReason: `上下文语义路由失败：${errorMessage(error)}`,
      clarificationQuestion: null,
      routingTrace: appendTrace(state, { source: 'context', outcome: 'error', reason: errorMessage(error) })
    }
  }
}

const tools = new Set(['local_edit', 'large_edit', 'full_relayout', 'ask_clarification'])

export const createToolIntentNode = (dependencies: ModelIntentRouterDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  try {
    const completion = await dependencies.modelClient.completeStructured({
      messages: [
        {
          role: 'system',
          content: `你是低代码页面编辑 Agent 的工具路由器，只选择逻辑工具，不改写用户请求，不生成页面、Patch 或计划。
可用工具：local_edit、large_edit、full_relayout、ask_clarification。ask_clarification 时必须给出一个具体且简短的 clarificationQuestion；其他工具的 clarificationQuestion 必须为 null。实际编辑始终使用应用保存的 originalRequest。只输出符合 Schema 的 JSON。`
        },
        {
          role: 'user',
          content: JSON.stringify({
            ...compactRoutingContext(state),
            previousRoutingFailure: state.routingReason || null
          })
        }
      ],
      responseFormat: strictResponseFormat('page_edit_tool_route', toolRouteSchema),
      signal: config?.signal,
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 6_000
    })
    const value = compactStructuredValue(completion.value)
    if (!isRecord(value) || !tools.has(String(value.tool)) || typeof value.reason !== 'string' || !value.reason.trim()) {
      throw new Error('工具路由模型返回了无效结果。')
    }
    if (value.tool === 'ask_clarification') {
      if (typeof value.clarificationQuestion !== 'string' || !value.clarificationQuestion.trim()) {
        throw new Error('工具路由模型未给出具体澄清问题。')
      }
      return {
        intent: 'question',
        routingSource: 'tool',
        routingReason: value.reason.trim().slice(0, 300),
        clarificationQuestion: value.clarificationQuestion.trim().slice(0, 500),
        routingTrace: appendTrace(state, { source: 'tool', outcome: 'clarification', reason: value.reason.trim().slice(0, 300) })
      }
    }
    return {
      intent: value.tool as PageEditIntent,
      routingSource: 'tool',
      routingReason: value.reason.trim().slice(0, 300),
      clarificationQuestion: null,
      routingTrace: appendTrace(state, { source: 'tool', outcome: 'resolved', reason: value.reason.trim().slice(0, 300) })
    }
  } catch (error) {
    return {
      intent: 'question',
      routingSource: 'tool',
      routingReason: `工具路由失败：${errorMessage(error)}`,
      clarificationQuestion: '我暂时无法可靠判断修改范围。请明确要修改的组件、区域，或说明是否需要重构整个页面。',
      routingTrace: appendTrace(state, { source: 'tool', outcome: 'error', reason: errorMessage(error) })
    }
  }
}
