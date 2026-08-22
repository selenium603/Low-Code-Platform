import { ComponentType, DeviceType } from '@/types'
import type { ComponentData, ComponentStyle, PageData, PageStyle } from '@/types'
import type { AIPageOperation, AIPagePatch } from '@/types/aiPatch'
import { getComponentProtocol } from '@/components/components/registry'
import { validateAndRepairPageData } from '@/stores/pageImport'
import { SCHEMA_VERSION } from '@/stores/migration'
import { MOBILE_AVAILABLE_WIDTH, MOBILE_PADDING, MOBILE_WIDTH_THRESHOLD } from '@/utils/mobile'
import { estimateTextHeight } from '@/utils/textLayout'

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const STYLE_NUMBER_KEYS: Array<keyof ComponentStyle> = [
  'top', 'left', 'width', 'height', 'zIndex', 'rotate', 'opacity',
  'fontSize', 'fontWeight', 'lineHeight', 'borderWidth', 'borderRadius'
]
const STYLE_COLOR_KEYS: Array<keyof ComponentStyle> = ['color', 'backgroundColor', 'borderColor']
const STYLE_KEYS = new Set<string>([...STYLE_NUMBER_KEYS, ...STYLE_COLOR_KEYS, 'textAlign'])

const sanitizeStyleChanges = (value: unknown): Partial<ComponentStyle> => {
  if (!isRecord(value)) throw new Error('样式修改必须是对象。')
  const result: Partial<ComponentStyle> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!STYLE_KEYS.has(key)) throw new Error(`不允许修改样式字段“${key}”。`)
    if (STYLE_NUMBER_KEYS.includes(key as keyof ComponentStyle)) {
      if (!finite(candidate)) throw new Error(`样式字段“${key}”必须是有限数字。`)
      Object.assign(result, { [key]: candidate })
    } else if (STYLE_COLOR_KEYS.includes(key as keyof ComponentStyle)) {
      if (typeof candidate !== 'string' || candidate.length > 100) throw new Error(`样式字段“${key}”格式无效。`)
      Object.assign(result, { [key]: candidate })
    } else if (key === 'textAlign') {
      if (!['left', 'center', 'right'].includes(String(candidate))) throw new Error('textAlign 只能是 left、center 或 right。')
      result.textAlign = candidate as ComponentStyle['textAlign']
    }
  }
  if (result.opacity !== undefined) result.opacity = Math.max(0.05, Math.min(1, result.opacity))
  if (result.width !== undefined) result.width = Math.max(40, result.width)
  if (result.height !== undefined) result.height = Math.max(40, result.height)
  if (result.top !== undefined) result.top = Math.max(0, result.top)
  if (result.left !== undefined) result.left = Math.max(0, result.left)
  return result
}

const getComponent = (page: PageData, id: string) => {
  const component = page.components.find((item) => item.id === id)
  if (!component) throw new Error(`找不到组件“${id}”，页面可能已发生变化。`)
  return component
}

const effectiveStyle = (component: ComponentData, device: DeviceType): ComponentStyle => (
  device === DeviceType.MOBILE
    ? { ...component.style, ...(component.responsiveOverrides?.mobile || {}) }
    : component.style
)

const isDecorativeComponent = (component: ComponentData, style: ComponentStyle) => (
  component.type === ComponentType.IMAGE && (
    style.rotate !== 0
    || style.opacity <= 0.45
    || /(^|[-_\s])(bg|background|deco|decorative)([-_\s]|$)|背景|装饰/i.test(`${component.id} ${component.name}`)
  )
)

const applyStyle = (component: ComponentData, device: DeviceType, changes: Partial<ComponentStyle>) => {
  if (device === DeviceType.DESKTOP) {
    component.style = { ...component.style, ...changes }
    return
  }
  if (!component.responsiveOverrides) component.responsiveOverrides = {}
  component.responsiveOverrides.mobile = {
    ...(component.responsiveOverrides.mobile || {}),
    ...changes
  }
}

const clampComponent = (component: ComponentData, page: PageData, device: DeviceType) => {
  if (device === DeviceType.DESKTOP) {
    component.style.width = Math.min(page.style.width, Math.max(40, component.style.width))
    component.style.height = Math.min(page.style.height, Math.max(40, component.style.height))
    component.style.left = Math.max(0, Math.min(component.style.left, page.style.width - component.style.width))
    component.style.top = Math.max(0, Math.min(component.style.top, page.style.height - component.style.height))
    return
  }

  const current = effectiveStyle(component, DeviceType.MOBILE)
  const width = Math.min(MOBILE_AVAILABLE_WIDTH, Math.max(40, current.width))
  const left = Math.min(MOBILE_WIDTH_THRESHOLD - MOBILE_PADDING - width, Math.max(MOBILE_PADDING, current.left))
  applyStyle(component, DeviceType.MOBILE, {
    width,
    left,
    top: Math.max(MOBILE_PADDING, current.top),
    height: Math.max(40, current.height),
    rotate: 0
  })
}

const placeAddedComponentSafely = (component: ComponentData, page: PageData, device: DeviceType) => {
  clampComponent(component, page, device)
  const current = effectiveStyle(component, device)
  if (isDecorativeComponent(component, current)) return
  const pageStyle = device === DeviceType.DESKTOP
    ? page.style
    : { ...page.style, ...(page.responsiveOverrides?.mobile || {}) }
  const padding = device === DeviceType.MOBILE ? MOBILE_PADDING : 24
  const gap = 16
  const step = device === DeviceType.MOBILE ? 12 : 16
  const maxLeft = Math.max(padding, pageStyle.width - padding - current.width)
  const maxTop = Math.max(padding, pageStyle.height - padding - current.height)
  const others = page.components.filter((other) => {
    if (other.id === component.id) return false
    const style = effectiveStyle(other, device)
    return !isDecorativeComponent(other, style)
  })
  const freeAt = (left: number, top: number) => others.every((other) => {
    const style = effectiveStyle(other, device)
    return left + current.width + gap <= style.left
      || style.left + style.width + gap <= left
      || top + current.height + gap <= style.top
      || style.top + style.height + gap <= top
  })

  const preferredLeft = Math.max(padding, Math.min(maxLeft, current.left))
  const preferredTop = Math.max(padding, Math.min(maxTop, current.top))
  const candidateLefts = device === DeviceType.MOBILE
    ? [MOBILE_PADDING]
    : [preferredLeft, ...Array.from(
        { length: Math.floor((maxLeft - padding) / step) + 1 },
        (_, index) => padding + index * step
      )]
  for (let top = preferredTop; top <= maxTop; top += step) {
    for (const left of candidateLefts) {
      if (!freeAt(left, top)) continue
      applyStyle(component, device, { left, top })
      return
    }
  }

  const bottom = others.reduce((value, other) => {
    const style = effectiveStyle(other, device)
    return Math.max(value, style.top + style.height)
  }, padding)
  const nextTop = bottom + gap
  applyStyle(component, device, { left: device === DeviceType.MOBILE ? MOBILE_PADDING : padding, top: nextTop })
  if (device === DeviceType.DESKTOP) {
    page.style.height = Math.max(page.style.height, nextTop + current.height + padding)
  } else {
    if (!page.responsiveOverrides) page.responsiveOverrides = {}
    page.responsiveOverrides.mobile = {
      ...(page.responsiveOverrides.mobile || {}),
      width: MOBILE_WIDTH_THRESHOLD,
      height: Math.max(Number(page.responsiveOverrides.mobile?.height) || 812, nextTop + current.height + padding)
    }
  }
}

const placeRelative = (page: PageData, operation: Extract<AIPageOperation, { op: 'placeRelative' }>) => {
  if (operation.componentId === operation.targetId) throw new Error('组件不能相对于自身定位。')
  const component = getComponent(page, operation.componentId)
  const target = getComponent(page, operation.targetId)
  const current = effectiveStyle(component, operation.device)
  const anchor = effectiveStyle(target, operation.device)
  const gap = Math.max(0, Math.min(96, finite(operation.gap) ? operation.gap : 16))
  const align = operation.align || 'center'
  const changes: Partial<ComponentStyle> = {}

  if (operation.relation === 'above' || operation.relation === 'below') {
    changes.top = operation.relation === 'above'
      ? anchor.top - current.height - gap
      : anchor.top + anchor.height + gap
    changes.left = align === 'start'
      ? anchor.left
      : align === 'end'
        ? anchor.left + anchor.width - current.width
        : anchor.left + (anchor.width - current.width) / 2
  } else {
    changes.left = operation.relation === 'left'
      ? anchor.left - current.width - gap
      : anchor.left + anchor.width + gap
    changes.top = align === 'start'
      ? anchor.top
      : align === 'end'
        ? anchor.top + anchor.height - current.height
        : anchor.top + (anchor.height - current.height) / 2
  }

  applyStyle(component, operation.device, changes)
  clampComponent(component, page, operation.device)
}

const addComponent = (page: PageData, operation: Extract<AIPageOperation, { op: 'addComponent' }>) => {
  const protocol = getComponentProtocol(operation.componentType)
  if (!protocol) throw new Error(`组件类型“${operation.componentType}”未注册。`)
  const styleChanges = operation.style ? sanitizeStyleChanges(operation.style) : {}
  const requestedMobileStyle = operation.mobileStyle
    ? sanitizeStyleChanges(operation.mobileStyle)
    : {
        left: MOBILE_PADDING,
        top: finite(styleChanges.top) ? styleChanges.top : page.components.length * 140 + MOBILE_PADDING,
        width: Math.min(MOBILE_AVAILABLE_WIDTH, finite(styleChanges.width) ? styleChanges.width : MOBILE_AVAILABLE_WIDTH),
        height: finite(styleChanges.height) ? styleChanges.height : protocol.defaultStyle.height,
        rotate: 0
      }
  const component: ComponentData = {
    id: `comp_ai_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type: operation.componentType,
    name: operation.name?.slice(0, 80) || protocol.label,
    schemaVersion: SCHEMA_VERSION,
    style: {
      ...clone(protocol.defaultStyle),
      ...(operation.device === DeviceType.MOBILE ? {} : styleChanges),
      zIndex: page.components.length + 1
    },
    props: {
      ...clone(protocol.defaultProps),
      ...(isRecord(operation.props) ? clone(operation.props) : {})
    } as ComponentData['props'],
    events: [{ type: 'click', config: { action: 'none' } }],
    responsiveOverrides: {
      mobile: operation.mobileStyle
        ? requestedMobileStyle
        : operation.device === DeviceType.MOBILE
          ? styleChanges
          : requestedMobileStyle
    }
  }
  if (component.type === ComponentType.TEXT) {
    const content = (component.props as { content?: unknown }).content
    component.style.height = Math.max(
      component.style.height,
      estimateTextHeight(content, component.style.width, component.style.fontSize, component.style.lineHeight)
    )
    const mobile = effectiveStyle(component, DeviceType.MOBILE)
    applyStyle(component, DeviceType.MOBILE, {
      height: Math.max(mobile.height, estimateTextHeight(content, mobile.width, mobile.fontSize, mobile.lineHeight))
    })
  }
  placeAddedComponentSafely(component, page, DeviceType.DESKTOP)
  placeAddedComponentSafely(component, page, DeviceType.MOBILE)
  page.components.push(component)
  return component.id
}

const updateProps = (page: PageData, operation: Extract<AIPageOperation, { op: 'updateProps' }>) => {
  const component = getComponent(page, operation.componentId)
  const protocol = getComponentProtocol(component.type)
  if (!protocol || !isRecord(operation.changes)) throw new Error(`组件“${operation.componentId}”的属性修改无效。`)
  const allowed = new Set([...Object.keys(protocol.defaultProps as unknown as UnknownRecord), ...protocol.schema.map((field) => field.key)])
  for (const key of Object.keys(operation.changes)) {
    if (!allowed.has(key)) throw new Error(`组件“${component.name}”不支持属性“${key}”。`)
  }
  component.props = { ...clone(component.props), ...clone(operation.changes) } as ComponentData['props']
  if (component.type === ComponentType.TEXT && 'content' in operation.changes) {
    const content = (component.props as { content?: unknown }).content
    component.style.height = Math.max(
      component.style.height,
      estimateTextHeight(content, component.style.width, component.style.fontSize, component.style.lineHeight)
    )
    const mobile = effectiveStyle(component, DeviceType.MOBILE)
    applyStyle(component, DeviceType.MOBILE, {
      height: Math.max(mobile.height, estimateTextHeight(content, mobile.width, mobile.fontSize, mobile.lineHeight))
    })
    placeAddedComponentSafely(component, page, DeviceType.DESKTOP)
    placeAddedComponentSafely(component, page, DeviceType.MOBILE)
  }
}

const moveLayer = (page: PageData, operation: Extract<AIPageOperation, { op: 'moveLayer' }>) => {
  const index = page.components.findIndex((item) => item.id === operation.componentId)
  if (index < 0) throw new Error(`找不到组件“${operation.componentId}”。`)
  const [component] = page.components.splice(index, 1)
  if (!component) return
  const nextIndex = operation.direction === 'top'
    ? page.components.length
    : operation.direction === 'bottom'
      ? 0
      : operation.direction === 'up'
        ? Math.min(page.components.length, index + 1)
        : Math.max(0, index - 1)
  page.components.splice(nextIndex, 0, component)
  page.components.forEach((item, order) => { item.style.zIndex = order + 1 })
}

export const validateAIPagePatch = (value: unknown): AIPagePatch => {
  if (!isRecord(value) || value.type !== 'page_patch') throw new Error('AI 未返回有效的页面 Patch。')
  if (!finite(value.baseRevision)) throw new Error('AI Patch 缺少页面版本号。')
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('AI Patch 缺少修改摘要。')
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 12) {
    throw new Error('AI Patch 必须包含 1～12 个修改操作。')
  }
  const allowed = new Set(['updateProps', 'updateStyle', 'updatePageStyle', 'placeRelative', 'addComponent', 'removeComponent', 'moveLayer'])
  for (const operation of value.operations) {
    if (!isRecord(operation) || !allowed.has(String(operation.op))) throw new Error(`AI Patch 包含不支持的操作“${String(isRecord(operation) ? operation.op : '')}”。`)
    const op = String(operation.op)
    if (['updateProps', 'updateStyle', 'placeRelative', 'removeComponent', 'moveLayer'].includes(op) && typeof operation.componentId !== 'string') {
      throw new Error(`操作“${op}”缺少 componentId。`)
    }
    if (['updateStyle', 'updatePageStyle', 'placeRelative'].includes(op) && !Object.values(DeviceType).includes(operation.device as DeviceType)) {
      throw new Error(`操作“${op}”的 device 无效。`)
    }
    if (['updateProps', 'updateStyle', 'updatePageStyle'].includes(op) && !isRecord(operation.changes)) {
      throw new Error(`操作“${op}”缺少 changes 对象。`)
    }
    if (op === 'placeRelative') {
      if (typeof operation.targetId !== 'string') throw new Error('placeRelative 缺少 targetId。')
      if (!['above', 'below', 'left', 'right'].includes(String(operation.relation))) throw new Error('placeRelative 的 relation 无效。')
      if (operation.align !== undefined && !['start', 'center', 'end'].includes(String(operation.align))) throw new Error('placeRelative 的 align 无效。')
    }
    if (op === 'addComponent') {
      if (!Object.values(ComponentType).includes(operation.componentType as ComponentType)) throw new Error('addComponent 的组件类型无效。')
      if (operation.device !== undefined && !Object.values(DeviceType).includes(operation.device as DeviceType)) throw new Error('addComponent 的 device 无效。')
      if (operation.props !== undefined && !isRecord(operation.props)) throw new Error('addComponent 的 props 必须是对象。')
      if (operation.style !== undefined && !isRecord(operation.style)) throw new Error('addComponent 的 style 必须是对象。')
      if (operation.mobileStyle !== undefined && !isRecord(operation.mobileStyle)) throw new Error('addComponent 的 mobileStyle 必须是对象。')
    }
    if (op === 'moveLayer' && !['up', 'down', 'top', 'bottom'].includes(String(operation.direction))) throw new Error('moveLayer 的 direction 无效。')
  }
  return value as unknown as AIPagePatch
}

export const applyAIPagePatch = (source: PageData, rawPatch: unknown) => {
  const patch = validateAIPagePatch(rawPatch)
  const page = clone(source)
  const geometryChanges: Array<{ id: string; device: DeviceType }> = []
  const resizedPages = new Set<DeviceType>()

  for (const operation of patch.operations) {
    switch (operation.op) {
      case 'updateProps':
        updateProps(page, operation)
        break
      case 'updateStyle': {
        const component = getComponent(page, operation.componentId)
        const changes = sanitizeStyleChanges(operation.changes)
        applyStyle(component, operation.device, changes)
        clampComponent(component, page, operation.device)
        if (['top', 'left', 'width', 'height'].some((key) => key in changes)) {
          geometryChanges.push({ id: component.id, device: operation.device })
        }
        break
      }
      case 'updatePageStyle': {
        if (!isRecord(operation.changes)) throw new Error('页面样式修改必须是对象。')
        const next: Partial<PageStyle> = {}
        if (finite(operation.changes.width)) next.width = Math.max(operation.device === DeviceType.MOBILE ? 320 : 960, operation.changes.width)
        if (finite(operation.changes.height)) next.height = Math.max(operation.device === DeviceType.MOBILE ? 400 : 720, operation.changes.height)
        if (typeof operation.changes.backgroundColor === 'string') next.backgroundColor = operation.changes.backgroundColor
        if (typeof operation.changes.backgroundImage === 'string') next.backgroundImage = operation.changes.backgroundImage
        if (operation.device === DeviceType.DESKTOP) page.style = { ...page.style, ...next }
        else {
          if (!page.responsiveOverrides) page.responsiveOverrides = {}
          page.responsiveOverrides.mobile = { ...(page.responsiveOverrides.mobile || {}), ...next }
        }
        if (next.width !== undefined || next.height !== undefined) resizedPages.add(operation.device)
        break
      }
      case 'placeRelative':
        placeRelative(page, operation)
        geometryChanges.push({ id: operation.componentId, device: operation.device })
        break
      case 'addComponent': {
        const id = addComponent(page, operation)
        geometryChanges.push({ id, device: DeviceType.DESKTOP })
        geometryChanges.push({ id, device: DeviceType.MOBILE })
        break
      }
      case 'removeComponent':
        if (page.components.length <= 1) throw new Error('页面至少需要保留一个组件。')
        getComponent(page, operation.componentId)
        page.components = page.components.filter((item) => item.id !== operation.componentId)
        page.components.forEach((item, order) => { item.style.zIndex = order + 1 })
        break
      case 'moveLayer':
        moveLayer(page, operation)
        break
    }
  }

  resizedPages.forEach((device) => page.components.forEach((component) => clampComponent(component, page, device)))

  for (const changed of geometryChanges) {
    const component = getComponent(page, changed.id)
    const style = effectiveStyle(component, changed.device)
    if (isDecorativeComponent(component, style)) continue
    for (const other of page.components) {
      if (other.id === component.id) continue
      const otherStyle = effectiveStyle(other, changed.device)
      if (isDecorativeComponent(other, otherStyle)) continue
      const overlaps = style.left < otherStyle.left + otherStyle.width
        && style.left + style.width > otherStyle.left
        && style.top < otherStyle.top + otherStyle.height
        && style.top + style.height > otherStyle.top
      if (overlaps) throw new Error(`AI 修改会导致“${component.name}”与“${other.name}”重叠，已取消本次修改。`)
    }
  }

  const mobileBottom = page.components.reduce((bottom, component) => {
    const style = effectiveStyle(component, DeviceType.MOBILE)
    return Math.max(bottom, style.top + style.height)
  }, 0)
  if (!page.responsiveOverrides) page.responsiveOverrides = {}
  page.responsiveOverrides.mobile = {
    ...(page.responsiveOverrides.mobile || {}),
    width: MOBILE_WIDTH_THRESHOLD,
    height: Math.max(812, mobileBottom + MOBILE_PADDING)
  }
  page.meta.updatedAt = new Date().toISOString()

  const repaired = validateAndRepairPageData(page)
  return { page: repaired.page, warnings: repaired.warnings, patch }
}
