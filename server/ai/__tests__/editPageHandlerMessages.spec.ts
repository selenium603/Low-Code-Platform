import { describe, expect, it } from 'vitest'

import { messagesFrom } from '../http/editPageHandler'

const message = (id: string, status?: string) => ({
  id,
  role: 'user',
  content: id,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...(status ? { status } : {})
})

describe('editPageHandler recent message normalization', () => {
  it('keeps only completed messages and treats a legacy missing status as completed', () => {
    expect(messagesFrom([
      message('legacy'),
      message('processing', 'processing'),
      message('failed', 'failed'),
      message('cancelled', 'cancelled'),
      message('invalid', 'unknown'),
      message('completed', 'completed')
    ]).map((item) => item.id)).toEqual(['legacy', 'completed'])
  })

  it('filters before taking the six most recent valid messages', () => {
    const completed = Array.from({ length: 7 }, (_, index) => message(`completed-${index}`, 'completed'))
    const failedTail = Array.from({ length: 10 }, (_, index) => message(`failed-${index}`, 'failed'))

    expect(messagesFrom([...completed, ...failedTail]).map((item) => item.id)).toEqual([
      'completed-1',
      'completed-2',
      'completed-3',
      'completed-4',
      'completed-5',
      'completed-6'
    ])
  })
})
