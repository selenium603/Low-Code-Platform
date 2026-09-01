import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import type { AIEditActionScope, AIEditTaskState, ExecutionPolicy } from '../../../src/types/aiPatch'
import { createExecutionUnits } from '../graph/executionUnits'

const page: PageData = {
  id: 'page-1',
  meta: { title: '测试', description: '', createdAt: '', updatedAt: '', version: '2026.05', scene: 'marketing' },
  style: { width: 1200, height: 820, backgroundColor: '#fff' },
  components: Array.from({ length: 6 }, (_, index) => ({
    id: `component-${index + 1}`,
    type: ComponentType.TEXT,
    name: `文本 ${index + 1}`,
    props: { content: `内容 ${index + 1}` },
    style: { top: index * 100, left: 40, width: 240, height: 60, zIndex: index + 1, rotate: 0, opacity: 1 },
    events: [], schemaVersion: '2026.05'
  }))
}

const policy: ExecutionPolicy = {
  canClarify: true, useModelDefaults: false, allowDelete: false,
  deleteAuthorization: { authorized: false, source: 'none', componentIds: [] },
  allowRegionalRelayout: false, maxAffectedComponents: 12,
  operationLimit: 12
}

const action = (input: Partial<AIEditActionScope> & Pick<AIEditActionScope, 'actionId' | 'kind'>): AIEditActionScope => ({
  instruction: input.actionId,
  targetScope: 'components',
  componentTypes: [],
  targetComponentIds: [],
  candidateComponentIds: [],
  ...input
})

const task = (intent: AIEditTaskState['intent'], actionScopes: AIEditActionScope[]): AIEditTaskState => ({
  taskId: 'task-1', pageId: page.id, pageRevision: 1, intent,
  rootRequest: '修改页面', additionalInstructions: [], actionScopes,
  clarificationUsed: 0, resumedFromPending: false, delegatedToModel: false
})

describe('execution unit planning strategies', () => {
  it('creates one unit for Local', () => {
    const units = createExecutionUnits({
      task: task('local_edit', [action({ actionId: 'update-title', kind: 'update', targetComponentIds: ['component-1'] })]),
      page,
      policy
    })
    expect(units).toEqual([expect.objectContaining({
      id: 'local-1', actionIds: ['update-title'], componentIds: ['component-1'], operationBudget: 12
    })])
  })

  it('creates one ordered unit per Qwen action for Large', () => {
    const units = createExecutionUnits({
      task: task('large_edit', [
        action({ actionId: 'first', kind: 'update', targetComponentIds: ['component-1'] }),
        action({ actionId: 'second', kind: 'add', targetScope: 'page' })
      ]),
      page,
      policy
    })
    expect(units).toMatchObject([
      { actionIds: ['first'], componentIds: ['component-1'], allowAdd: false },
      { actionIds: ['second'], componentIds: [], allowAdd: true }
    ])
  })

  it('creates deterministic spatial units for Full', () => {
    const units = createExecutionUnits({
      task: task('full_relayout', [action({ actionId: 'relayout', kind: 'update', targetScope: 'page' })]),
      page,
      policy
    })
    expect(units.length).toBeGreaterThan(1)
    expect(units.flatMap((unit) => unit.componentIds)).toEqual(page.components.map((component) => component.id))
    expect(units[0]).toMatchObject({ actionIds: ['relayout'], allowPageStyle: true })
    expect(units.slice(1).every((unit) => !unit.allowPageStyle)).toBe(true)
  })
})
