import type { AIEditRequest, PageEditGraphResult } from '@/types/aiPatch'

type TerminalEditResult = PageEditGraphResult

type EditEvent = {
  type: 'progress' | 'success' | 'error'
  code?: string
  message?: string
  result?: TerminalEditResult
  attempts?: number
}

export class AIEditPageError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message)
    this.name = 'AIEditPageError'
  }

}

export const editPageFromPrompt = async (
  request: AIEditRequest,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<{ result: TerminalEditResult; attempts: number }> => {
  const response = await fetch('/api/ai/edit-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal
  })
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json() as { result?: TerminalEditResult; attempts?: number; code?: string; message?: string }
    if (!response.ok || !data.result) throw new AIEditPageError(data.message || 'AI 页面修改失败，请重试。', data.code)
    return { result: data.result, attempts: data.attempts || 1 }
  }

  if (!response.body) throw new Error('AI 页面修改服务未返回可读取的数据流。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: { result: TerminalEditResult; attempts: number } | null = null
  let failureMessage = ''
  let failureCode: string | undefined

  const isTerminalResult = (value: unknown): value is TerminalEditResult => Boolean(
    value && typeof value === 'object'
    && [
      'clarification_requested', 'page_edit_completed', 'assistant_reply',
      'task_cancelled', 'no_change', 'execution_failed'
    ].includes(String((value as { type?: unknown }).type))
  )

  const consume = (rawEvent: string) => {
    const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return
    const event = JSON.parse(dataLine.slice(6)) as EditEvent
    if (event.type === 'progress' && event.message) onProgress?.(event.message)
    if (event.type === 'success' && isTerminalResult(event.result)) {
      result = { result: event.result, attempts: event.attempts || 1 }
    } else if (event.type === 'success') {
      failureMessage = 'AI 编辑服务未返回可提交的最终页面。'
    }
    if (event.type === 'error') {
      failureMessage = event.message || 'AI 页面修改失败，请重试。'
      failureCode = event.code
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''
    events.forEach(consume)
    if (done) break
  }
  if (buffer.trim()) consume(buffer)
  if (failureMessage) throw new AIEditPageError(failureMessage, failureCode)
  if (!result) throw new Error('AI 页面修改连接已结束，但未收到有效终态。')
  return result
}
