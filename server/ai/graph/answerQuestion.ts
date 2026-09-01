import type { RunnableConfig } from '@langchain/core/runnables'

import { assistantReplySchema, compactStructuredValue, strictResponseFormat } from '../../structuredSchemas'
import type { OpenRouterClient } from '../model/openRouterClient'
import type { PageEditStateUpdate, PageEditStateValue } from './pageEditState'

type StructuredClient = Pick<OpenRouterClient, 'completeStructured'>

const protocolArtifact = /<\/?(?:tool_response|tool_call|assistant|system|user)\b|<\|im_(?:start|end)\|>|\b(?:page_patch|removeComponent|updateProps|updateStyle)\b/i

const cleanReply = (value: unknown) => {
  const compact = compactStructuredValue(value)
  if (!compact || typeof compact !== 'object' || Array.isArray(compact)) return null
  const record = compact as Record<string, unknown>
  if (record.type !== 'assistant_reply' || typeof record.message !== 'string') return null
  const message = record.message.trim().slice(0, 1_500)
  return message && !protocolArtifact.test(message) ? message : null
}

export const createAnswerQuestionNode = (dependencies: {
  contextModelClient?: StructuredClient
  modelClient: StructuredClient
}) => async (state: PageEditStateValue, config?: RunnableConfig): Promise<PageEditStateUpdate> => {
  const clients = dependencies.contextModelClient
    ? [dependencies.contextModelClient, dependencies.modelClient]
    : [dependencies.modelClient]
  let lastError = '问答模型没有返回有效内容。'
  for (const client of clients) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const completion = await client.completeStructured({
          messages: [
            {
              role: 'system',
              content: '你是低代码页面的只读助手。回答当前问题，不生成 Patch、工具调用、执行授权或新的澄清问题。只输出 assistant_reply JSON。'
            },
            {
              role: 'user',
              content: JSON.stringify({
                question: state.originalRequest,
                recentMessages: state.recentMessages.slice(-6).map(({ role, content }) => ({ role, content })),
                conversationMemory: state.conversationMemory,
                pageSummary: {
                  id: state.draftPage.id,
                  componentCount: state.draftPage.components.length,
                  components: state.draftPage.components.slice(0, 24).map((item) => ({ id: item.id, type: item.type, name: item.name }))
                },
                pendingTask: state.pendingTask ? {
                  rootRequest: state.pendingTask.rootRequest,
                  lastQuestion: state.pendingTask.clarification.question
                } : null,
                lastGeometryError: state.validationError?.includes('GEOMETRY') ? state.validationError.slice(0, 800) : null
              })
            }
          ],
          responseFormat: strictResponseFormat('assistant_reply', assistantReplySchema),
          signal: config?.signal,
          temperature: 0.2,
          maxTokens: 600,
          timeoutMs: 4_000
        })
        const message = cleanReply(completion.value)
        if (!message) throw new Error('问答输出不符合只读协议。')
        return {
          status: 'completed',
          result: {
            type: 'assistant_reply',
            runId: state.runId,
            message,
            pendingTask: state.pendingTask
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 300) : '未知问答错误'
      }
    }
  }
  return {
    status: 'error',
    result: {
      type: 'execution_failed',
      runId: state.runId,
      code: 'QA_MODEL_FAILED',
      message: `暂时无法回答这个问题：${lastError}`,
      retryable: true,
      pendingTask: state.pendingTask
    }
  }
}
