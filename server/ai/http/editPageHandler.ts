import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { validateAndRepairPageData } from '../../../src/domain/pageValidation'
import type { AIConversationMemory, AIConversationMessage } from '../../../src/types/aiPatch'
import { retrieveComponentsWithRag } from '../../componentRag'
import { createPageEditAgent } from '../graph/pageEditAgent'
import { createInitialPageEditState, type PageEditGraphResult, type PageEditStateValue } from '../graph/pageEditState'
import { createDefaultLargeEditPlanner } from '../graph/largeEditGraph'
import { getPendingTaskSecret, verifyPendingTask } from '../graph/pendingTaskIntegrity'
import { createOpenRouterClient } from '../model/openRouterClient'
import { createSSEWriter } from './sse'

const AI_EDIT_SERVER_VERSION = 'pending-task-v2'

export interface PageEditEnvironment {
  NODE_ENV?: string
  OPENROUTER_API_KEY?: string
  AI_BASE_URL?: string
  AI_MODEL?: string
  OPENROUTER_API_KEY2?: string
  AI_BASE_URL2?: string
  AI_MODEL2?: string
  AI_PLANNING_MODEL?: string
  AI_RAG_ENABLED?: string
  AI_EMBEDDING_API_KEY?: string
  AI_EMBEDDING_BASE_URL?: string
  AI_EMBEDDING_MODEL?: string
  AI_PENDING_TASK_SECRET?: string
}

type PageEditAgentInvoker = {
  invoke(input: unknown, config?: { signal?: AbortSignal }): Promise<PageEditStateValue | { result?: PageEditGraphResult | null }>
}

const readBody = (request: IncomingMessage) => new Promise<string>((resolve, reject) => {
  let data = ''
  request.on('data', (chunk) => {
    data += String(chunk)
    if (data.length > 5_000_000) reject(new Error('请求体过大。'))
  })
  request.on('end', () => resolve(data))
  request.on('error', reject)
})

const cleanList = (value: unknown, max: number): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 300)).filter(Boolean).slice(-max)
  : []

const memoryFrom = (value: unknown): AIConversationMemory => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    userGoals: cleanList(source.userGoals, 4),
    designConstraints: cleanList(source.designConstraints, 5),
    completedChanges: cleanList(source.completedChanges, 6),
    openQuestions: cleanList(source.openQuestions, 3)
  }
}

export const messagesFrom = (value: unknown): AIConversationMessage[] => Array.isArray(value)
  ? value.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return []
      const source = item as Record<string, unknown>
      if ((source.role !== 'user' && source.role !== 'assistant') || typeof source.content !== 'string') return []
      const status = source.status == null
        ? 'completed'
        : ['processing', 'completed', 'failed', 'cancelled'].includes(String(source.status))
          ? source.status as AIConversationMessage['status']
          : null
      if (!status) return []
      return [{
        id: typeof source.id === 'string' ? source.id : `message-${index}`,
        role: source.role as AIConversationMessage['role'],
        content: source.content.slice(0, 600),
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
        status
      }]
    }).filter((message) => message.status === 'completed').slice(-6)
  : []

const jsonReply = (response: ServerResponse, status: number, payload: Record<string, unknown>) => {
  if (response.destroyed || response.writableEnded) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

export const createEditPageHandler = (options: {
  env: PageEditEnvironment
  createAgent?: (signal: AbortSignal) => PageEditAgentInvoker
  createRunId?: () => string
}) => async (request: IncomingMessage, response: ServerResponse) => {
  if (request.method !== 'POST') return jsonReply(response, 405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST 请求。' })
  if (!options.env.OPENROUTER_API_KEY && !options.createAgent) {
    return jsonReply(response, 503, { code: 'KEY_NOT_CONFIGURED', message: '未检测到 OPENROUTER_API_KEY。请检查 .env.local 并重启 npm run dev。' })
  }
  if ((options.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production')
    && !options.env.AI_PENDING_TASK_SECRET?.trim()) {
    return jsonReply(response, 503, {
      code: 'PENDING_TASK_SECRET_NOT_CONFIGURED',
      message: '生产环境必须配置 AI_PENDING_TASK_SECRET。'
    })
  }

  const controller = new AbortController()
  response.on('close', () => { if (!response.writableEnded) controller.abort('client disconnected') })
  try {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const baseRevision = Number(body.baseRevision)
    if (!message) return jsonReply(response, 400, { code: 'EMPTY_MESSAGE', message: '请先输入需要修改的内容。' })
    if (!Number.isFinite(baseRevision)) return jsonReply(response, 400, { code: 'INVALID_REVISION', message: '页面 revision 无效，请刷新后重试。' })
    let page
    try {
      page = validateAndRepairPageData(body.page).page
    } catch (error) {
      return jsonReply(response, 400, { code: 'INVALID_PAGE', message: error instanceof Error ? error.message : '当前页面 Schema 无效。' })
    }

    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-AI-Edit-Version', AI_EDIT_SERVER_VERSION)
    response.flushHeaders?.()
    const stream = createSSEWriter(response, controller.signal)
    const runId = options.createRunId?.() || `run_${randomUUID()}`
    stream.send({ type: 'progress', runId, stage: 'routing', message: '正在分析修改范围并选择安全执行链路…' })

    const baseUrl = options.env.AI_BASE_URL || 'https://openrouter.ai/api/v1'
    const model = options.env.AI_MODEL || 'qwen/qwen3.7-plus'
    const contextModelClient = options.env.OPENROUTER_API_KEY2
      ? createOpenRouterClient({
          apiKey: options.env.OPENROUTER_API_KEY2,
          baseUrl: options.env.AI_BASE_URL2 || baseUrl,
          model: options.env.AI_MODEL2 || 'deepseek/deepseek-v4-flash-0731',
          defaultTimeoutMs: 4_000
        })
      : undefined
    const agent = options.createAgent?.(controller.signal) || createPageEditAgent({
      modelClient: createOpenRouterClient({ apiKey: options.env.OPENROUTER_API_KEY || '', baseUrl, model }),
      contextModelClient,
      retrieveCandidates: (query, componentIndex, signal) => retrieveComponentsWithRag({
        query,
        componentIndex,
        apiKey: options.env.AI_RAG_ENABLED === 'false' ? '' : options.env.AI_EMBEDDING_API_KEY || options.env.OPENROUTER_API_KEY || '',
        baseUrl: options.env.AI_EMBEDDING_BASE_URL || baseUrl,
        model: options.env.AI_EMBEDDING_MODEL || 'openai/text-embedding-3-small',
        signal: signal || controller.signal,
        topK: 16
      }),
      planLargeEdit: createDefaultLargeEditPlanner({
        apiKey: options.env.OPENROUTER_API_KEY || '', baseUrl,
        model: options.env.AI_PLANNING_MODEL || model
      })
    })
    const pendingIntegritySecret = getPendingTaskSecret(options.env.AI_PENDING_TASK_SECRET)
    const pendingValidation = verifyPendingTask(body.pendingTask, pendingIntegritySecret)
    const verifiedPendingTask = pendingValidation.valid ? pendingValidation.task : null
    const pageIds = new Set(page.components.map((component) => component.id))
    const inputPendingTask = verifiedPendingTask
      && verifiedPendingTask.pageId === page.id
      && verifiedPendingTask.pageRevision === baseRevision
      && [...verifiedPendingTask.targetComponentIds, ...verifiedPendingTask.candidateComponentIds].every((id) => pageIds.has(id))
      ? verifiedPendingTask
      : null
    if (body.pendingTask != null && !inputPendingTask) {
      console.warn(JSON.stringify({
        event: 'ai_pending_task_rejected',
        runId,
        reason: pendingValidation.valid ? 'page_or_component_mismatch' : pendingValidation.reason
      }))
    }
    const output = await agent.invoke(createInitialPageEditState({
      runId,
      request: message,
      page,
      baseRevision,
      recentMessages: messagesFrom(body.recentMessages),
      conversationMemory: memoryFrom(body.conversationMemory),
      pendingTask: inputPendingTask,
      pendingIntegritySecret
    }), { signal: controller.signal })
    if (controller.signal.aborted) return
    const result = output.result
    const routingState = output as Partial<PageEditStateValue>
    console.info(JSON.stringify({
      event: 'ai_page_edit_route',
      runId,
      request: message.slice(0, 1000),
      routingSource: routingState.routingSource || 'unknown',
      intent: routingState.intent || 'unknown',
      reason: (routingState.routingReason || '').slice(0, 300),
      routingTrace: routingState.routingTrace || [],
      outcome: result?.type || 'empty_result',
      errorCode: result?.type === 'execution_failed' ? result.code : null,
      clarificationSource: result?.type === 'clarification_requested' ? result.pendingTask.clarification.source : null,
      clarificationCode: result?.type === 'clarification_requested' ? result.pendingTask.clarification.code : null,
      validationError: (routingState.validationError || '').slice(0, 1000),
      serverVersion: AI_EDIT_SERVER_VERSION,
      pendingReceived: Boolean(inputPendingTask),
      pendingCode: inputPendingTask?.clarification.code || null,
      pendingTaskId: inputPendingTask?.taskId || null,
      geometryRepairAttempt: routingState.geometryRepairAttempt || 0,
      needsRelocate: routingState.needsRelocate || false,
      durationMs: Date.now() - Date.parse(routingState.startedAt || new Date().toISOString())
    }))
    if (!result) {
      stream.send({ type: 'error', runId, code: 'EMPTY_AGENT_RESULT', message: 'AI 编辑流程结束但未产生结果。' })
    } else {
      stream.send({ type: 'success', runId, result, attempts: 1 })
    }
    stream.close()
  } catch (error) {
    if (controller.signal.aborted) return
    if (response.headersSent) {
      const stream = createSSEWriter(response, controller.signal)
      stream.send({ type: 'error', code: 'AI_EDIT_SERVER_ERROR', message: error instanceof Error ? error.message : '增量修改服务异常。' })
      stream.close()
      return
    }
    return jsonReply(response, 500, { code: 'AI_EDIT_SERVER_ERROR', message: error instanceof Error ? error.message : '增量修改服务异常。' })
  }
}
