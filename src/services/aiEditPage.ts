import type { AIEditRequest, AIEditResponse } from '@/types/aiPatch'

type EditEvent = {
  type: 'progress' | 'success' | 'error'
  message?: string
  result?: AIEditResponse
  attempts?: number
}

export const editPageFromPrompt = async (
  request: AIEditRequest,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<{ result: AIEditResponse; attempts: number }> => {
  const response = await fetch('/api/ai/edit-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal
  })
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json() as { result?: AIEditResponse; attempts?: number; message?: string }
    if (!response.ok || !data.result) throw new Error(data.message || 'AI 增量修改失败，请重试。')
    return { result: data.result, attempts: data.attempts || 1 }
  }

  if (!response.body) throw new Error('增量修改服务未返回可读取的数据流。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: { result: AIEditResponse; attempts: number } | null = null
  let failure = ''

  const consume = (rawEvent: string) => {
    const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return
    const event = JSON.parse(dataLine.slice(6)) as EditEvent
    if (event.type === 'progress' && event.message) onProgress?.(event.message)
    if (event.type === 'success' && event.result) result = { result: event.result, attempts: event.attempts || 1 }
    if (event.type === 'error') failure = event.message || 'AI 增量修改失败，请重试。'
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
  if (failure) throw new Error(failure)
  if (!result) throw new Error('增量修改连接已结束，但未收到 Patch。')
  return result
}
