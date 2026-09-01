import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import type { AIEditTaskState, ExecutionPolicy } from '../../../src/types/aiPatch'
import { createEditSemanticAnalysisNode } from '../graph/editSemanticAnalysis'
import { createExecutionUnitContext } from '../graph/executionContext'
import { createExecutionUnits } from '../graph/executionUnits'
import { deriveExecutionPolicy } from '../graph/executionPolicy'
import { createInitialPageEditState, type PageEditStateValue } from '../graph/pageEditState'
import { validateGeneratedEditResponse } from '../graph/patchPolicy'
import { createEditResponseSchema } from '../../structuredSchemas'

const page: PageData = {
  id: 'page-1',
  meta: { title: '测试', description: '', createdAt: '', updatedAt: '', version: '2026.05', scene: 'marketing' },
  style: { width: 1200, height: 820, backgroundColor: '#fff' },
  components: [
    {
      id: 'hero-image', type: ComponentType.IMAGE, name: '主视觉图片',
      props: { src: '', alt: '主视觉', objectFit: 'cover' },
      style: { top: 100, left: 40, width: 300, height: 180, zIndex: 1, rotate: 0, opacity: 1 },
      events: [], schemaVersion: '2026.05'
    },
    {
      id: 'footer-button', type: ComponentType.BUTTON, name: '页脚按钮',
      props: { content: '联系我们', type: 'primary' },
      style: { top: 700, left: 40, width: 160, height: 48, zIndex: 2, rotate: 0, opacity: 1 },
      events: [], schemaVersion: '2026.05'
    },
    {
      id: 'main-title', type: ComponentType.TEXT, name: '主标题',
      props: { content: '原始标题' },
      style: { top: 40, left: 40, width: 300, height: 48, zIndex: 3, rotate: 0, opacity: 1 },
      events: [], schemaVersion: '2026.05'
    }
  ]
}

const taskFor = (request: string): AIEditTaskState => ({
  taskId: 'task-1', pageId: page.id, pageRevision: 1, intent: 'local_edit', rootRequest: request,
  additionalInstructions: [], actionScopes: [],
  clarificationUsed: 0, resumedFromPending: false, delegatedToModel: false
})

const stateFor = (request: string) => ({
  ...createInitialPageEditState({ runId: 'run-1', request, page, baseRevision: 1 }),
  request,
  originalRequest: request,
  task: taskFor(request),
  intent: 'local_edit',
  routingSource: 'rule',
  clarificationProposals: [],
  selectedComponentIds: []
}) as PageEditStateValue

describe('complex edit semantic action scopes', () => {
  it('keeps preserve and delete targets isolated', async () => {
    const node = createEditSemanticAnalysisNode({
      modelClient: {
        completeStructured: async () => ({ value: {
          type: 'semantic_actions', question: null, clarificationCode: null,
          actions: [
            {
              actionId: 'preserve-image', kind: 'preserve', instruction: '保留图片', targetScope: 'components',
              componentTypes: ['Image'], componentIds: ['hero-image']
            },
            {
              actionId: 'delete-button', kind: 'delete', instruction: '删除按钮', targetScope: 'components',
              componentTypes: ['Button'], componentIds: ['footer-button']
            }
          ]
        }, content: '{}' })
      }
    })
    const result = await node(stateFor('保留图片并删除按钮'))
    expect(result.task?.actionScopes).toMatchObject([
      { kind: 'preserve', targetComponentIds: ['hero-image'] },
      { kind: 'delete', targetComponentIds: ['footer-button'] }
    ])
  })

  it('keeps deletion and update targets independent through policy and unit context', async () => {
    const semanticNode = createEditSemanticAnalysisNode({
      modelClient: {
        completeStructured: async () => ({ value: {
          type: 'semantic_actions', question: null, clarificationCode: null,
          actions: [
            {
              actionId: 'delete-footer', kind: 'delete', instruction: '删除页脚按钮', targetScope: 'components',
              componentTypes: ['Button'], componentIds: ['footer-button']
            },
            {
              actionId: 'update-title', kind: 'update', instruction: '把主标题改成红色', targetScope: 'components',
              componentTypes: ['Text'], componentIds: ['main-title']
            }
          ]
        }, content: '{}' })
      }
    })
    const initial = stateFor('删除页脚按钮，并把主标题改成红色')
    const analyzed = await semanticNode(initial)
    const task = analyzed.task!
    expect(task.actionScopes.map((action) => action.targetComponentIds)).toEqual([
      ['footer-button'],
      ['main-title']
    ])

    const policy = deriveExecutionPolicy({
      task,
      authorizationEvidence: { rootUserMessage: task.rootRequest, additionalUserMessages: [] }
    })
    expect(policy.deleteAuthorization.componentIds).toEqual(['footer-button'])

    const executionUnits = createExecutionUnits({ task, page, policy })
    const located = createExecutionUnitContext({
      ...initial, ...analyzed, task, executionPolicy: policy, executionUnits, unitIndex: 0
    } as PageEditStateValue)
    expect(located.selectedComponentIds).toHaveLength(2)
    expect(located.selectedComponentIds).toEqual(expect.arrayContaining(['main-title', 'footer-button']))
    expect(located.allowedOperationKinds).toEqual(expect.arrayContaining(['updateProps', 'removeComponent']))

    const schema = JSON.stringify(createEditResponseSchema(
      page.components.map((component) => ({ id: component.id, type: component.type })),
      {
        baseRevision: 1,
        operationLimit: 12,
        allowedEditComponentIds: new Set(['main-title']),
        allowedDeleteComponentIds: new Set(['footer-button']),
        allowedOperationKinds: new Set(['updateProps', 'updateStyle', 'removeComponent'])
      }
    ))
    expect(schema).toContain('main-title')
    expect(schema).toContain('footer-button')
    expect(schema).not.toContain('hero-image')

    const scopedState = { ...initial, ...analyzed, ...located, task, executionPolicy: policy } as PageEditStateValue
    expect(validateGeneratedEditResponse({
      type: 'page_patch', baseRevision: 1, summary: '正确修改',
      operations: [
        { op: 'removeComponent', componentId: 'footer-button' },
        { op: 'updateStyle', componentId: 'main-title', device: 'desktop', changes: { color: '#ff0000' } }
      ]
    }, scopedState).error).toBeUndefined()
    expect(validateGeneratedEditResponse({
      type: 'page_patch', baseRevision: 1, summary: '越权删除',
      operations: [{ op: 'removeComponent', componentId: 'main-title' }]
    }, scopedState).error).toContain('明确授权')
    expect(validateGeneratedEditResponse({
      type: 'page_patch', baseRevision: 1, summary: '越权修改删除目标',
      operations: [{ op: 'updateStyle', componentId: 'footer-button', device: 'desktop', changes: { color: '#ff0000' } }]
    }, scopedState).error).toContain('修改 action')
  })

  it('uses page scope for colloquial additions without granting deletion', async () => {
    const node = createEditSemanticAnalysisNode({
      modelClient: {
        completeStructured: async () => ({ value: {
          type: 'semantic_actions', question: null, clarificationCode: null,
          actions: [{
            actionId: 'add-button', kind: 'add', instruction: '来个按钮', targetScope: 'page',
            componentTypes: ['Button'], componentIds: []
          }]
        }, content: '{}' })
      }
    })
    const result = await node(stateFor('来个按钮'))
    expect(result.task?.actionScopes).toMatchObject([{ kind: 'add', targetScope: 'page', targetComponentIds: [] }])
  })

  it('represents full relayout as a page-scoped semantic action', async () => {
    const node = createEditSemanticAnalysisNode({
      modelClient: {
        completeStructured: async () => ({ value: {
          type: 'semantic_actions', question: null, clarificationCode: null,
          actions: [{
            actionId: 'relayout-page', kind: 'update', instruction: '重新设计整个页面布局', targetScope: 'page',
            componentTypes: [], componentIds: []
          }]
        }, content: '{}' })
      }
    })
    const initial = {
      ...stateFor('重新设计整个页面布局'),
      intent: 'full_relayout' as const,
      task: { ...taskFor('重新设计整个页面布局'), intent: 'full_relayout' as const }
    } as PageEditStateValue

    const result = await node(initial)

    expect(result.task?.actionScopes).toMatchObject([{
      kind: 'update', targetScope: 'page', targetComponentIds: []
    }])
  })
})
