export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StructuredCompletionRequest {
  messages: AIMessage[]
  responseFormat: Record<string, unknown>
  signal?: AbortSignal
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface StructuredCompletionResult {
  value: unknown
  content: string
  finishReason?: string
}

export type OpenRouterErrorCode =
  | 'UNAUTHORIZED'
  | 'UPSTREAM_REJECTED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'EMPTY_RESPONSE'
  | 'OUTPUT_TRUNCATED'
  | 'INVALID_JSON'
  | 'CONNECTION_FAILED'

export class OpenRouterError extends Error {
  constructor(
    public readonly code: OpenRouterErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

export interface OpenRouterClientOptions {
  apiKey: string
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
  defaultTimeoutMs?: number
}

const readErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string }
    return payload.error?.message || payload.message || `OpenRouter ${response.status}`
  } catch {
    return `OpenRouter ${response.status}`
  }
}

const linkAbortSignal = (controller: AbortController, signal?: AbortSignal) => {
  if (!signal) return () => undefined
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export const createOpenRouterClient = (options: OpenRouterClientOptions) => {
  const fetchImpl = options.fetchImpl || fetch

  return {
    async completeStructured(request: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
      const controller = new AbortController()
      const unlinkAbort = linkAbortSignal(controller, request.signal)
      const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs ?? 35_000
      const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs)

      try {
        const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: request.model || options.model,
            messages: request.messages,
            reasoning: { enabled: false },
            response_format: request.responseFormat,
            temperature: request.temperature ?? 0.1,
            max_tokens: request.maxTokens ?? 2000
          }),
          signal: controller.signal
        })

        if (!response.ok) {
          const message = await readErrorMessage(response)
          const code = response.status === 401 || response.status === 403
            ? 'UNAUTHORIZED'
            : 'UPSTREAM_REJECTED'
          throw new OpenRouterError(code, message, response.status)
        }

        const payload = await response.json() as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
        }
        const choice = payload.choices?.[0]
        const content = choice?.message?.content
        if (!content) throw new OpenRouterError('EMPTY_RESPONSE', '模型未返回结构化内容。')
        if (choice.finish_reason === 'length') {
          throw new OpenRouterError('OUTPUT_TRUNCATED', '模型输出达到 token 上限。')
        }
        try {
          return { value: JSON.parse(content), content, finishReason: choice.finish_reason }
        } catch {
          throw new OpenRouterError('INVALID_JSON', '模型返回的 JSON 不完整或语法错误。')
        }
      } catch (error) {
        if (error instanceof OpenRouterError) throw error
        if (controller.signal.aborted) {
          if (request.signal?.aborted) throw new OpenRouterError('ABORTED', 'AI 请求已取消。')
          throw new OpenRouterError('TIMEOUT', `AI 请求超过 ${timeoutMs}ms 未完成。`)
        }
        throw new OpenRouterError(
          'CONNECTION_FAILED',
          error instanceof Error ? error.message : '无法连接模型服务。'
        )
      } finally {
        clearTimeout(timeout)
        unlinkAbort()
      }
    }
  }
}

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>
