import type { RunnableConfig } from '@langchain/core/runnables'

import type { ModelRoutingDecision, PageEditIntent, PendingRelation } from '../../../src/types/aiPatch'
import { compactStructuredValue, contextIntentSchema, strictResponseFormat, toolRouteSchema } from '../../structuredSchemas'
import type { OpenRouterClient } from '../model/openRouterClient'
import type { PageEditRoutingTraceStep, PageEditStateUpdate, PageEditStateValue } from './pageEditState'

type StructuredClient = Pick<OpenRouterClient, 'completeStructured'>

export interface ModelIntentRouterDependencies {
  contextModelClient?: StructuredClient
  modelClient: StructuredClient
}

const intents = new Set<PageEditIntent>(['local_edit', 'large_edit', 'full_relayout', 'question', 'chat', 'cancel', 'unresolved'])
const relations = new Set<PendingRelation>(['none', 'answer', 'supplement', 'delegate', 'replace', 'cancel', 'question', 'chat', 'unresolved'])
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const errorMessage = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : '未知模型错误'
const appendTrace = (state: PageEditStateValue, step: PageEditRoutingTraceStep) => [...(state.routingTrace || []), step]

const compactRoutingContext = (state: PageEditStateValue) => ({
  currentUserMessage: state.originalRequest,
  recentMessages: state.recentMessages.slice(-6).map(({ role, content }) => ({ role, content })),
  conversationMemory: state.conversationMemory,
  pendingTask: state.pendingTask ? {
    rootRequest: state.pendingTask.rootRequest,
    lastQuestion: state.pendingTask.clarification.question,
    taskIntent: state.pendingTask.taskIntent,
    clarificationUsed: state.pendingTask.clarification.used
  } : null,
  pageSummary: {
    componentCount: state.draftPage.components.length,
    componentTypes: state.draftPage.components.reduce<Record<string, number>>((counts, component) => {
      counts[component.type] = (counts[component.type] || 0) + 1
      return counts
    }, {})
  },
  lastCompletedChange: state.conversationMemory.completedChanges.at(-1) || null
})

const parseDecision = (value: unknown): ModelRoutingDecision | null => {
  const compact = compactStructuredValue(value)
  if (!isRecord(compact) || !intents.has(compact.intent as PageEditIntent)
    || !relations.has(compact.relationToPending as PendingRelation)
    || typeof compact.reason !== 'string' || !compact.reason.trim()) return null
  return {
    intent: compact.intent as PageEditIntent,
    relationToPending: compact.relationToPending as PendingRelation,
    reason: compact.reason.trim().slice(0, 300)
  }
}

const systemPrompt = (layer: 'context' | 'tool', hasPending: boolean) => `你是低代码页面编辑入口的${layer === 'context' ? '上下文意图分类器' : '最终工具路由器'}，只分类，不生成页面、Patch、计划或执行授权。
intent 只能是 local_edit、large_edit、full_relayout、question、chat、cancel、unresolved。
relationToPending 只能是 none、answer、supplement、delegate、replace、cancel、question、chat、unresolved。
${hasPending
    ? '存在经过服务端验证的 pendingTask。判断当前消息是回答/补充/委托旧任务、替换/取消旧任务，还是只进行问答或闲聊。'
    : '不存在 pendingTask，relationToPending 必须为 none。'}
“随便、你决定、都可以”在存在 pendingTask 时是 delegate；只咨询页面或上一问题是 question；明确新修改覆盖旧任务是 replace。模型不得决定澄清次数。只输出符合 Schema 的 JSON。`

export const createContextIntentNode = (dependencies: ModelIntentRouterDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  if (!dependencies.contextModelClient) {
    return {
      routingDecision: null,
      intent: 'unresolved',
      routingReason: '未配置上下文语义模型，进入工具路由兜底。',
      routingTrace: appendTrace(state, { source: 'context', outcome: 'fallback', reason: '未配置上下文语义模型。' })
    }
  }
  let lastError = '上下文模型未返回结果。'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await dependencies.contextModelClient.completeStructured({
        messages: [
          { role: 'system', content: systemPrompt('context', Boolean(state.pendingTask)) },
          { role: 'user', content: JSON.stringify(compactRoutingContext(state)) }
        ],
        responseFormat: strictResponseFormat('page_edit_context_intent', contextIntentSchema),
        signal: config?.signal,
        temperature: 0,
        maxTokens: 300,
        timeoutMs: 4_000
      })
      const decision = parseDecision(completion.value)
      if (!decision) throw new Error('上下文模型返回了无效的意图结果。')
      return {
        routingDecision: decision,
        intent: decision.intent,
        routingSource: 'context',
        routingReason: decision.reason,
        routingTrace: appendTrace(state, { source: 'context', outcome: 'resolved', reason: decision.reason })
      }
    } catch (error) {
      lastError = errorMessage(error)
    }
  }
  return {
    routingDecision: null,
    intent: 'unresolved',
    routingSource: 'context',
    routingReason: `上下文语义路由失败：${lastError}`,
    routingTrace: appendTrace(state, { source: 'context', outcome: 'error', reason: lastError })
  }
}

export const createToolIntentNode = (dependencies: ModelIntentRouterDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  try {
    const completion = await dependencies.modelClient.completeStructured({
      messages: [
        { role: 'system', content: systemPrompt('tool', Boolean(state.pendingTask)) },
        { role: 'user', content: JSON.stringify({ ...compactRoutingContext(state), previousRoutingFailure: state.routingReason || null }) }
      ],
      responseFormat: strictResponseFormat('page_edit_tool_route', toolRouteSchema),
      signal: config?.signal,
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 6_000
    })
    const decision = parseDecision(completion.value)
    if (!decision) throw new Error('工具路由模型返回了无效结果。')
    return {
      routingDecision: decision,
      intent: decision.intent,
      routingSource: 'tool',
      routingReason: decision.reason,
      routingTrace: appendTrace(state, { source: 'tool', outcome: 'resolved', reason: decision.reason })
    }
  } catch (error) {
    const message = errorMessage(error)
    return {
      status: 'error',
      routingDecision: null,
      intent: 'unresolved',
      routingSource: 'tool',
      routingReason: `工具路由失败：${message}`,
      routingTrace: appendTrace(state, { source: 'tool', outcome: 'error', reason: message }),
      result: {
        type: 'execution_failed',
        runId: state.runId,
        code: 'INTENT_ROUTING_FAILED',
        message: '暂时无法可靠判断修改意图，请稍后重试。',
        retryable: true,
        pendingTask: state.pendingTask
      }
    }
  }
}
