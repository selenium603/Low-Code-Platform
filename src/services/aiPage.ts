import type { PageData } from '@/types'

type GenerationEvent = {
  type: 'progress' | 'success' | 'error'
  message?: string
  page?: PageData
  attempts?: number
}

export const generatePageFromPrompt = async (
  prompt: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<{ page: PageData; attempts: number }> => {
  const response = await fetch('/api/ai/generate-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal
  })
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json() as { page?: PageData; attempts?: number; message?: string }
    if (!response.ok || !data.page) throw new Error(data.message || 'AI 页面生成失败，请重试。')
    return { page: data.page, attempts: data.attempts || 1 }
  }

  if (!response.body) throw new Error('生成服务未返回可读取的数据流，请重试。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: { page: PageData; attempts: number } | null = null
  let failure = ''

  const consume = (rawEvent: string) => {
    const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return
    const event = JSON.parse(dataLine.slice(6)) as GenerationEvent
    if (event.type === 'progress' && event.message) onProgress?.(event.message)
    if (event.type === 'success' && event.page) result = { page: event.page, attempts: event.attempts || 1 }
    if (event.type === 'error') failure = event.message || 'AI 页面生成失败，请重试。'
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
  if (!result) throw new Error('生成服务连接已结束，但未收到页面结果，请重试。')
  return result
}
