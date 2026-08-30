export interface SSEWritable {
  destroyed?: boolean
  writableEnded?: boolean
  write(chunk: string): unknown
  end(): unknown
}

export interface SSEEvent {
  type: 'progress' | 'clarification' | 'success' | 'error'
  runId?: string
  [key: string]: unknown
}

export const encodeSSEEvent = (event: SSEEvent) => `data: ${JSON.stringify(event)}\n\n`

export const createSSEWriter = (response: SSEWritable, signal?: AbortSignal) => ({
  send(event: SSEEvent) {
    if (response.destroyed || response.writableEnded || signal?.aborted) return false
    response.write(encodeSSEEvent(event))
    return true
  },
  close() {
    if (response.destroyed || response.writableEnded) return false
    response.end()
    return true
  }
})
