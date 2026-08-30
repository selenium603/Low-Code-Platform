import type { RagComponentIndexItem } from '../../componentRag'
import type { ComponentData, PageData } from '../../../src/types'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const collectComponentText = (props: Record<string, unknown>) => {
  const fragments = [props.content, props.title, props.placeholder, props.alt, props.submitText]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  if (Array.isArray(props.fields)) {
    props.fields.slice(0, 6).forEach((field) => {
      if (!isRecord(field)) return
      if (typeof field.label === 'string') fragments.push(field.label)
      if (typeof field.placeholder === 'string') fragments.push(field.placeholder)
    })
  }
  if (Array.isArray(props.data)) {
    props.data.slice(0, 8).forEach((item) => {
      if (isRecord(item) && typeof item.name === 'string') fragments.push(item.name)
    })
  }
  return [...new Set(fragments.map((value) => value.trim()).filter(Boolean))].join('；').slice(0, 240) || undefined
}

const describeSpatialRegion = (rect: number[], canvasWidth: number, canvasHeight: number) => {
  const [left = 0, top = 0, width = 0, height = 0] = rect
  if (width <= 0 || height <= 0) return '未单独配置'
  const x = left + width / 2
  const y = top + height / 2
  const horizontal = x < canvasWidth / 3 ? '左侧' : x > canvasWidth * 2 / 3 ? '右侧' : '中部'
  const vertical = y < canvasHeight / 3 ? '上部' : y > canvasHeight * 2 / 3 ? '下部' : '中部'
  return `${vertical}${horizontal}`
}

export const buildAIComponentIndex = (page: PageData): RagComponentIndexItem[] => {
  const desktopWidth = page.style.width || 1200
  const desktopHeight = page.style.height || 820
  const mobilePage = page.responsiveOverrides?.mobile
  const mobileWidth = mobilePage?.width || 375
  const mobileHeight = mobilePage?.height || 812
  const items = page.components.map((component, index) => {
    const mobile = component.responsiveOverrides?.mobile || {}
    const desktopRect = [component.style.left, component.style.top, component.style.width, component.style.height]
    const mobileRect = [
      mobile.left ?? component.style.left,
      mobile.top ?? component.style.top,
      mobile.width ?? component.style.width,
      mobile.height ?? component.style.height
    ]
    return {
      index,
      id: component.id,
      type: component.type,
      name: component.name,
      text: collectComponentText(component.props as unknown as Record<string, unknown>),
      desktop: desktopRect,
      mobile: mobileRect,
      spatial: {
        desktop: describeSpatialRegion(desktopRect, desktopWidth, desktopHeight),
        mobile: describeSpatialRegion(mobileRect, mobileWidth, mobileHeight)
      },
      neighborIds: [] as string[]
    }
  })

  const center = (rect: number[]) => ({
    x: (rect[0] || 0) + (rect[2] || 0) / 2,
    y: (rect[1] || 0) + (rect[3] || 0) / 2
  })
  items.forEach((item) => {
    const point = center(item.desktop)
    item.neighborIds = items
      .filter((candidate) => candidate.id !== item.id)
      .map((candidate) => {
        const candidatePoint = center(candidate.desktop)
        return {
          id: candidate.id,
          distance: (candidatePoint.x - point.x) ** 2 + (candidatePoint.y - point.y) ** 2
        }
      })
      .sort((first, second) => first.distance - second.distance)
      .slice(0, 4)
      .map((candidate) => candidate.id)
  })
  return items
}

export const selectLocalPageComponents = (
  page: PageData,
  targetIds: string[],
  maximum = 16
): ComponentData[] => {
  const targetSet = new Set(targetIds)
  const selected = new Set<number>()
  page.components.forEach((component, index) => {
    if (targetSet.has(component.id)) selected.add(index)
  })
  for (const index of [...selected]) {
    if (index > 0) selected.add(index - 1)
    if (index + 1 < page.components.length) selected.add(index + 1)
  }

  const center = (component: ComponentData) => ({
    x: component.style.left + component.style.width / 2,
    y: component.style.top + component.style.height / 2
  })
  const targetPoints = [...selected].map((index) => center(page.components[index]!))
  const candidates = page.components
    .map((component, index) => ({ component, index, point: center(component) }))
    .filter(({ index }) => !selected.has(index))
    .sort((first, second) => {
      const distance = (point: { x: number; y: number }) => Math.min(...targetPoints.map((target) => (
        (point.x - target.x) ** 2 + (point.y - target.y) ** 2
      )))
      return distance(first.point) - distance(second.point)
    })
  for (const candidate of candidates) {
    if (selected.size >= maximum) break
    selected.add(candidate.index)
  }
  return [...selected]
    .sort((first, second) => first - second)
    .slice(0, maximum)
    .map((index) => page.components[index]!)
}
