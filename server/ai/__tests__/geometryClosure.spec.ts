import { describe, expect, it } from 'vitest'

import { ComponentType, DeviceType, type PageData } from '../../../src/types'
import { collectGeometryConflictClosure } from '../../../src/domain/pagePatchExecutor'

const pageWithComponents = (count: number, overlap: boolean): PageData => ({
  id: 'page-geometry',
  meta: { title: '几何测试', description: '', createdAt: '', updatedAt: '', version: '2026.05', scene: 'marketing' },
  style: { width: 1200, height: 2000, backgroundColor: '#fff' },
  responsiveOverrides: { mobile: { width: 375, height: 2000, backgroundColor: '#fff' } },
  components: Array.from({ length: count }, (_, index) => ({
    id: `component-${index}`,
    type: ComponentType.TEXT,
    name: `组件 ${index}`,
    props: { content: `组件 ${index}` },
    style: {
      top: overlap ? 100 : index * 100,
      left: 100,
      width: 200,
      height: 60,
      zIndex: index + 1,
      rotate: 0,
      opacity: 1
    },
    events: [],
    schemaVersion: '2026.05'
  }))
})

describe('geometry conflict closure limits', () => {
  it('marks overflow when a changed component conflicts with a thirteenth component', () => {
    const source = pageWithComponents(13, false)
    const draft = pageWithComponents(13, true)
    const result = collectGeometryConflictClosure(source, draft, [
      { id: 'component-0', device: DeviceType.DESKTOP, gap: 0 }
    ], 12)

    expect(result.overflow).toBe(true)
    expect(result.affectedComponentIds).toHaveLength(12)
    expect(result.conflicts.some((conflict) => conflict.conflictingComponentId === 'component-12')).toBe(true)
  })

  it('marks overflow immediately when seed components already exceed the limit', () => {
    const page = pageWithComponents(13, false)
    const result = collectGeometryConflictClosure(
      page,
      page,
      page.components.map((component) => ({ id: component.id, device: DeviceType.DESKTOP, gap: 0 })),
      12
    )

    expect(result.overflow).toBe(true)
    expect(result.affectedComponentIds).toHaveLength(12)
  })

  it('keeps an exact twelve-component seed set within the safe limit', () => {
    const page = pageWithComponents(12, false)
    const result = collectGeometryConflictClosure(
      page,
      page,
      page.components.map((component) => ({ id: component.id, device: DeviceType.DESKTOP, gap: 0 })),
      12
    )

    expect(result.overflow).toBe(false)
    expect(result.affectedComponentIds).toHaveLength(12)
  })
})
