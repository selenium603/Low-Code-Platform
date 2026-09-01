import { describe, expect, it } from 'vitest'

import { ComponentType, type PageData } from '../../../src/types'
import type { AIClarificationRequested } from '../../../src/types/aiPatch'
import { validateAndRepairPageData } from '../../../src/domain/pageValidation'
import { createPageEditAgent } from '../graph/pageEditAgent'
import { createInitialPageEditState } from '../graph/pageEditState'

const page = (): PageData => ({
  id: 'page-1',
  meta: {
    title: '测试页',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: '2026.05',
    scene: 'marketing'
  },
  style: { width: 1200, height: 820, backgroundColor: '#ffffff' },
  components: [{
    id: 'existing-title',
    type: ComponentType.TEXT,
    name: '主标题',
    props: { content: '原始标题' },
    style: { top: 40, left: 40, width: 300, height: 80, zIndex: 1, rotate: 0, opacity: 1 },
    events: [],
    schemaVersion: '2026.05'
  }]
})

const fakeModelClient = {
  async completeStructured() {
    const value = {
      type: 'page_patch',
      question: null,
      clarificationCode: null,
      baseRevision: 1,
      summary: '新增一张与页面风格协调的图片',
      operations: [{
        op: 'addComponent',
        componentType: 'Image',
        name: 'AI 推荐图片',
        props: { src: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d', alt: '营销场景', objectFit: 'cover' },
        style: { top: 40, left: 400, width: 240, height: 160, rotate: 0, opacity: 1 },
        mobileStyle: { top: 140, left: 20, width: 335, height: 220, rotate: 0, opacity: 1 }
      }]
    }
    return { value, content: JSON.stringify(value) }
  }
}

const createAgent = () => createPageEditAgent({
  modelClient: fakeModelClient,
  retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] }),
  planLargeEdit: async () => { throw new Error('not used') }
})

describe('page edit agent clarification budget', () => {
  it('asks once for a vague image addition, then safely adds an image after delegation', async () => {
    const agent = createAgent()
    const first = await agent.invoke(createInitialPageEditState({
      runId: 'run-1',
      request: '加点图片',
      page: page(),
      baseRevision: 1,
      pendingIntegritySecret: 'integration-test-secret'
    }))

    expect(first.result).toMatchObject({ type: 'clarification_requested' })
    const pendingTask = (first.result as AIClarificationRequested).pendingTask
    expect(pendingTask.clarification).toMatchObject({ used: 1, max: 1 })
    expect(first.draftPage).toEqual(first.originalPage)

    const second = await agent.invoke(createInitialPageEditState({
      runId: 'run-2',
      request: '随便',
      page: page(),
      baseRevision: 1,
      pendingTask,
      pendingIntegritySecret: 'integration-test-secret'
    }))

    expect(second.result?.type).toBe('page_edit_completed')
    if (second.result?.type !== 'page_edit_completed') return
    expect(second.result.page.components).toHaveLength(2)
    expect(second.result.page.components.find((item) => item.id === 'existing-title')?.props).toEqual({ content: '原始标题' })
    expect(second.result.page.components.filter((item) => item.type === ComponentType.IMAGE)).toHaveLength(1)
  })

  it('keeps existing images unchanged for a negated-replacement pure add request', async () => {
    const rawSource = page()
    rawSource.components.push({
      id: 'existing-image',
      type: ComponentType.IMAGE,
      name: '现有主图',
      props: { src: 'https://example.com/existing.jpg', alt: '现有图片', objectFit: 'cover' },
      style: { top: 160, left: 40, width: 240, height: 160, zIndex: 2, rotate: 0, opacity: 1 },
      events: [],
      schemaVersion: '2026.05'
    })
    const source = validateAndRepairPageData(rawSource).page
    const originalImageProps = structuredClone(source.components.find((item) => item.id === 'existing-image')?.props)
    const agent = createAgent()
    const first = await agent.invoke(createInitialPageEditState({
      runId: 'run-pure-add',
      request: '添加图片，不要替换现有图片',
      page: source,
      baseRevision: 1,
      pendingIntegritySecret: 'integration-test-secret'
    }))

    expect(first.result?.type).toBe('clarification_requested')
    if (first.result?.type !== 'clarification_requested') return
    const second = await agent.invoke(createInitialPageEditState({
      runId: 'run-pure-add-resume',
      request: '随便',
      page: source,
      baseRevision: 1,
      pendingTask: first.result.pendingTask,
      pendingIntegritySecret: 'integration-test-secret'
    }))

    expect(second.result?.type).toBe('page_edit_completed')
    if (second.result?.type !== 'page_edit_completed') return
    expect(second.result.page.components).toHaveLength(3)
    expect(second.result.page.components.find((item) => item.id === 'existing-image')?.props).toEqual(originalImageProps)
  })

  it('executes complex action scopes without leaking delete targets into update targets', async () => {
    const rawSource = page()
    rawSource.components.push(
      {
        id: 'hero-image', type: ComponentType.IMAGE, name: '主视觉图片',
        props: { src: 'https://example.com/hero.jpg', alt: '主视觉', objectFit: 'cover' },
        style: { top: 180, left: 40, width: 260, height: 160, zIndex: 2, rotate: 0, opacity: 1 },
        events: [], schemaVersion: '2026.05'
      },
      {
        id: 'footer-button', type: ComponentType.BUTTON, name: '页脚按钮',
        props: { content: '联系我们', type: 'primary' },
        style: { top: 700, left: 40, width: 160, height: 48, zIndex: 3, rotate: 0, opacity: 1 },
        events: [], schemaVersion: '2026.05'
      }
    )
    const source = validateAndRepairPageData(rawSource).page
    const modelClient = {
      async completeStructured(input: { responseFormat?: { json_schema?: { name?: string } } }) {
        const name = input.responseFormat?.json_schema?.name
        const value = name === 'page_edit_semantic_actions'
          ? {
              type: 'semantic_actions', question: null, clarificationCode: null,
              actions: [
                {
                  actionId: 'preserve-image', kind: 'preserve', instruction: '保留图片', targetScope: 'components',
                  componentTypes: ['Image'], componentIds: ['hero-image']
                },
                {
                  actionId: 'delete-footer', kind: 'delete', instruction: '删除页脚按钮', targetScope: 'components',
                  componentTypes: ['Button'], componentIds: ['footer-button']
                },
                {
                  actionId: 'update-title', kind: 'update', instruction: '把主标题改成红色', targetScope: 'components',
                  componentTypes: ['Text'], componentIds: ['existing-title']
                }
              ]
            }
          : {
              type: 'page_patch', question: null, clarificationCode: null, baseRevision: 1,
              summary: '删除页脚按钮并修改主标题',
              operations: [
                { op: 'removeComponent', componentId: 'footer-button' },
                { op: 'updateStyle', componentId: 'existing-title', device: 'desktop', changes: { color: '#ff0000' } }
              ]
            }
        return { value, content: JSON.stringify(value) }
      }
    }
    const agent = createPageEditAgent({
      modelClient,
      retrieveCandidates: async () => ({ mode: 'lexical', candidates: [] }),
      planLargeEdit: async () => { throw new Error('not used') }
    })
    const result = await agent.invoke(createInitialPageEditState({
      runId: 'run-complex',
      request: '保留图片，删除页脚按钮，并把主标题改成红色',
      page: source,
      baseRevision: 1,
      pendingIntegritySecret: 'integration-test-secret'
    }))

    expect(result.result?.type).toBe('page_edit_completed')
    if (result.result?.type !== 'page_edit_completed') return
    expect(result.result.page.components.some((component) => component.id === 'footer-button')).toBe(false)
    expect(result.result.page.components.some((component) => component.id === 'hero-image')).toBe(true)
    expect(result.result.page.components.find((component) => component.id === 'existing-title')?.style.color).toBe('#ff0000')
  })
})
