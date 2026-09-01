import { ComponentType, DeviceType } from '../types'
import type { ComponentData, ComponentStyle, PageData, PageStyle } from '../types'
import type { AIPageOperation, AIPagePatch } from '../types/aiPatch'
import { getComponentProtocol } from './componentProtocols'
import { validateAndRepairPageData } from './pageValidation'
import { SCHEMA_VERSION } from '../stores/migration'
import { MOBILE_AVAILABLE_WIDTH, MOBILE_PADDING, MOBILE_WIDTH_THRESHOLD } from '../utils/mobile'
import { estimateTextHeight } from '../utils/textLayout'
import { getFormMinimumHeight } from '../utils/formLayout'

type UnknownRecord = Record<string, unknown>

export interface AIPagePatchExecutionContext {
  createComponentId?: (operationIndex: number) => string
  now?: string
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const STYLE_NUMBER_KEYS: Array<keyof ComponentStyle> = [
  'top', 'left', 'width', 'height', 'rotate', 'opacity',
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

export interface GeometryRect {
  left: number
  top: number
  width: number
  height: number
}

export interface GeometryConflictDetail {
  kind: 'boundary' | 'collision'
  device: DeviceType
  changedComponentId: string
  changedComponentName: string
  conflictingComponentId: string | null
  conflictingComponentName: string | null
  preferredRect: GeometryRect
  conflictingRect: GeometryRect | null
  requiredGap: number
  preExisting: boolean
  worsened: boolean
}

export class GeometryConflictError extends Error {
  public readonly conflict: GeometryConflictDetail

  constructor(
    public readonly conflicts: GeometryConflictDetail[],
    public readonly affectedComponentIds: string[],
    public readonly devices: DeviceType[],
    public readonly overflow: boolean
  ) {
    const conflict = conflicts[0]!
    const location = conflict.device === DeviceType.MOBILE ? '手机端' : '桌面端'
    const reason = conflict.kind === 'boundary'
      ? `超出${location}页面边界`
      : `与“${conflict.conflictingComponentName || conflict.conflictingComponentId}”重叠或间距不足 ${conflict.requiredGap}px`
    super(`AI 修改会导致“${conflict.changedComponentName}”${reason}，且当前影响区域内没有可自动修复的合法位置。`)
    this.name = 'GeometryConflictError'
    this.conflict = conflict
  }
}

type PlacementConstraint = {
  targetId: string
  relation: 'above' | 'below' | 'left' | 'right'
  align: 'start' | 'center' | 'end'
  gap: number
}

type GeometryValidation = {
  id: string
  device: DeviceType
  gap: number
  placementConstraint?: PlacementConstraint
}

const conflictsWithGap = (first: ComponentStyle, second: ComponentStyle, gap: number) => (
  first.left < second.left + second.width + gap
  && first.left + first.width + gap > second.left
  && first.top < second.top + second.height + gap
  && first.top + first.height + gap > second.top
)

const rectOf = (style: ComponentStyle): GeometryRect => ({
  left: style.left,
  top: style.top,
  width: style.width,
  height: style.height
})

const collisionSeverity = (first: ComponentStyle, second: ComponentStyle, gap: number) => {
  const halfGap = gap / 2
  const horizontalDepth = Math.min(
    first.left + first.width + halfGap,
    second.left + second.width + halfGap
  ) - Math.max(first.left - halfGap, second.left - halfGap)
  const verticalDepth = Math.min(
    first.top + first.height + halfGap,
    second.top + second.height + halfGap
  ) - Math.max(first.top - halfGap, second.top - halfGap)
  return horizontalDepth > 0 && verticalDepth > 0
    ? Math.min(horizontalDepth, verticalDepth)
    : 0
}

const boundarySeverity = (style: ComponentStyle, pageStyle: PageStyle, padding: number) => (
  Math.max(0, padding - style.left)
  + Math.max(0, padding - style.top)
  + Math.max(0, style.left + style.width - (pageStyle.width - padding))
  + Math.max(0, style.top + style.height - (pageStyle.height - padding))
)

const effectivePageStyle = (page: PageData, device: DeviceType): PageStyle => (
  device === DeviceType.DESKTOP
    ? page.style
    : { ...page.style, ...(page.responsiveOverrides?.mobile || {}) }
)

const isAllowedDecorationOverlap = (
  first: ComponentData,
  firstStyle: ComponentStyle,
  second: ComponentData,
  secondStyle: ComponentStyle
) => (
  (isDecorativeComponent(first, firstStyle) && firstStyle.zIndex < secondStyle.zIndex)
  || (isDecorativeComponent(second, secondStyle) && secondStyle.zIndex < firstStyle.zIndex)
)

const blockingGeometryConflicts = (
  source: PageData,
  page: PageData,
  changed: GeometryValidation
): GeometryConflictDetail[] => {
  const conflicts: GeometryConflictDetail[] = []
  const component = getComponent(page, changed.id)
  const style = effectiveStyle(component, changed.device)
  const pageStyle = effectivePageStyle(page, changed.device)
  const padding = changed.device === DeviceType.MOBILE ? MOBILE_PADDING : 0
  const currentBoundarySeverity = boundarySeverity(style, pageStyle, padding)
  if (currentBoundarySeverity > 0) {
    const original = source.components.find((item) => item.id === component.id)
    const originalSeverity = original
      ? boundarySeverity(
          effectiveStyle(original, changed.device),
          effectivePageStyle(source, changed.device),
          padding
        )
      : 0
    if (originalSeverity <= 0 || currentBoundarySeverity > originalSeverity + 0.01) {
      conflicts.push({
        kind: 'boundary',
        device: changed.device,
        changedComponentId: component.id,
        changedComponentName: component.name,
        conflictingComponentId: null,
        conflictingComponentName: null,
        preferredRect: rectOf(style),
        conflictingRect: null,
        requiredGap: changed.gap,
        preExisting: originalSeverity > 0,
        worsened: originalSeverity > 0 && currentBoundarySeverity > originalSeverity + 0.01
      })
    }
  }

  for (const other of page.components) {
    if (other.id === component.id) continue
    const otherStyle = effectiveStyle(other, changed.device)
    if (isAllowedDecorationOverlap(component, style, other, otherStyle)) continue
    const currentSeverity = collisionSeverity(style, otherStyle, changed.gap)
    if (currentSeverity <= 0) continue
    const original = source.components.find((item) => item.id === component.id)
    const originalOther = source.components.find((item) => item.id === other.id)
    const originalSeverity = original && originalOther
      ? collisionSeverity(
          effectiveStyle(original, changed.device),
          effectiveStyle(originalOther, changed.device),
          changed.gap
        )
      : 0
    if (originalSeverity > 0 && currentSeverity <= originalSeverity + 0.01) continue
    conflicts.push({
      kind: 'collision',
      device: changed.device,
      changedComponentId: component.id,
      changedComponentName: component.name,
      conflictingComponentId: other.id,
      conflictingComponentName: other.name,
      preferredRect: rectOf(style),
      conflictingRect: rectOf(otherStyle),
      requiredGap: changed.gap,
      preExisting: originalSeverity > 0,
      worsened: originalSeverity > 0 && currentSeverity > originalSeverity + 0.01
    })
  }
  return conflicts
}

const blockingGeometryConflict = (
  source: PageData,
  page: PageData,
  changed: GeometryValidation
) => blockingGeometryConflicts(source, page, changed)[0] || null

const geometryConflictKey = (conflict: GeometryConflictDetail) => {
  const ids = conflict.conflictingComponentId
    ? [conflict.changedComponentId, conflict.conflictingComponentId].sort().join(':')
    : conflict.changedComponentId
  return `${conflict.device}:${conflict.kind}:${ids}`
}

export const collectGeometryConflictClosure = (
  source: PageData,
  page: PageData,
  seedChanges: GeometryValidation[],
  maxComponents = 12
) => {
  const existingIds = new Set(page.components.map((component) => component.id))
  const seeds = uniqueGeometryChanges(seedChanges).filter((change) => existingIds.has(change.id))
  const queue: GeometryValidation[] = []
  const queued = new Set<string>()
  const affected = new Set<string>()
  let overflow = false
  for (const seed of seeds) {
    const key = `${seed.id}:${seed.device}`
    if (affected.has(seed.id)) {
      if (!queued.has(key)) {
        queued.add(key)
        queue.push(seed)
      }
      continue
    }
    if (affected.size >= maxComponents) {
      overflow = true
      continue
    }
    affected.add(seed.id)
    queued.add(key)
    queue.push(seed)
  }
  const conflicts = new Map<string, GeometryConflictDetail>()
  for (let index = 0; index < queue.length; index += 1) {
    const changed = queue[index]!
    for (const conflict of blockingGeometryConflicts(source, page, changed)) {
      conflicts.set(geometryConflictKey(conflict), conflict)
      const otherId = conflict.conflictingComponentId
      if (!otherId || affected.has(otherId)) continue
      if (affected.size >= maxComponents) {
        overflow = true
        continue
      }
      affected.add(otherId)
      const key = `${otherId}:${changed.device}`
      if (!queued.has(key)) {
        queued.add(key)
        queue.push({ id: otherId, device: changed.device, gap: changed.gap })
      }
    }
  }
  return {
    conflicts: [...conflicts.values()],
    affectedComponentIds: [...affected],
    devices: [...new Set([...conflicts.values()].map((conflict) => conflict.device))],
    overflow
  }
}

/**
 * 只校验本轮发生几何或层级变化的组件，避免历史页面中的旧布局问题阻断无关修改。
 * 装饰图只有位于内容下层时才允许重叠，与整页生成链路保持一致。
 */
const validateChangedGeometry = (page: PageData, changes: GeometryValidation[]) => {
  const errors = new Set<string>()
  for (const changed of changes) {
    const component = getComponent(page, changed.id)
    const style = effectiveStyle(component, changed.device)
    const pageStyle = changed.device === DeviceType.DESKTOP
      ? page.style
      : { ...page.style, ...(page.responsiveOverrides?.mobile || {}) }
    const padding = changed.device === DeviceType.MOBILE ? MOBILE_PADDING : 0
    if (
      style.left < padding
      || style.top < padding
      || style.left + style.width > pageStyle.width - padding
      || style.top + style.height > pageStyle.height - padding
    ) {
      errors.add(`“${component.name}”超出${changed.device === DeviceType.MOBILE ? '手机端' : '桌面端'}页面边界`)
    }

    for (const other of page.components) {
      if (other.id === component.id) continue
      const otherStyle = effectiveStyle(other, changed.device)
      if (!conflictsWithGap(style, otherStyle, changed.gap)) continue
      const componentIsLowerDecoration = isDecorativeComponent(component, style) && style.zIndex < otherStyle.zIndex
      const otherIsLowerDecoration = isDecorativeComponent(other, otherStyle) && otherStyle.zIndex < style.zIndex
      if (componentIsLowerDecoration || otherIsLowerDecoration) continue
      const suffix = changed.gap ? `或间距不足 ${changed.gap}px` : ''
      const names = [component.name, other.name].sort().join('”与“')
      errors.add(`“${names}”重叠${suffix}`)
    }
  }
  if (errors.size) throw new Error(`页面存在以下几何冲突：${[...errors].join('；')}，已取消本次修改。`)
}

/** 整页事务完成前使用；普通局部修改仍只校验本轮受影响组件。 */
export const validateFullPageGeometry = (page: PageData, gap = 16) => {
  const changes = page.components.flatMap((component) => ([
    { id: component.id, device: DeviceType.DESKTOP, gap },
    { id: component.id, device: DeviceType.MOBILE, gap }
  ]))
  validateChangedGeometry(page, changes)
}

const placementMatches = (
  rect: GeometryRect,
  target: ComponentStyle,
  constraint: PlacementConstraint
) => {
  const expectedCrossAxis = constraint.relation === 'above' || constraint.relation === 'below'
    ? constraint.align === 'start'
      ? target.left
      : constraint.align === 'end'
        ? target.left + target.width - rect.width
        : target.left + (target.width - rect.width) / 2
    : constraint.align === 'start'
      ? target.top
      : constraint.align === 'end'
        ? target.top + target.height - rect.height
        : target.top + (target.height - rect.height) / 2
  if (constraint.relation === 'above') {
    return rect.top + rect.height + constraint.gap <= target.top
      && Math.abs(rect.left - expectedCrossAxis) < 0.01
  }
  if (constraint.relation === 'below') {
    return rect.top >= target.top + target.height + constraint.gap
      && Math.abs(rect.left - expectedCrossAxis) < 0.01
  }
  if (constraint.relation === 'left') {
    return rect.left + rect.width + constraint.gap <= target.left
      && Math.abs(rect.top - expectedCrossAxis) < 0.01
  }
  return rect.left >= target.left + target.width + constraint.gap
    && Math.abs(rect.top - expectedCrossAxis) < 0.01
}

const findNearestValidRect = (
  page: PageData,
  component: ComponentData,
  device: DeviceType,
  preferred: GeometryRect,
  gap: number,
  constraint?: PlacementConstraint,
  maxDistance = 96
): GeometryRect | null => {
  const pageStyle = effectivePageStyle(page, device)
  const padding = device === DeviceType.MOBILE ? MOBILE_PADDING : 0
  const maxLeft = pageStyle.width - padding - preferred.width
  const maxTop = pageStyle.height - padding - preferred.height
  if (maxLeft < padding || maxTop < padding) return null
  const obstacles = page.components.filter((item) => item.id !== component.id)
  const target = constraint
    ? page.components.find((item) => item.id === constraint.targetId)
    : null
  if (constraint && !target) return null
  const targetStyle = target ? effectiveStyle(target, device) : null
  const step = 8
  const lefts = new Set<number>([preferred.left, padding, maxLeft])
  const tops = new Set<number>([preferred.top, padding, maxTop])
  const scanLeftStart = Math.max(padding, Math.floor((preferred.left - maxDistance) / step) * step)
  const scanLeftEnd = Math.min(maxLeft, preferred.left + maxDistance)
  const scanTopStart = Math.max(padding, Math.floor((preferred.top - maxDistance) / step) * step)
  const scanTopEnd = Math.min(maxTop, preferred.top + maxDistance)
  for (let left = scanLeftStart; left <= scanLeftEnd; left += step) lefts.add(left)
  for (let top = scanTopStart; top <= scanTopEnd; top += step) tops.add(top)
  obstacles.forEach((other) => {
    const style = effectiveStyle(other, device)
    lefts.add(style.left - preferred.width - gap)
    lefts.add(style.left + style.width + gap)
    tops.add(style.top - preferred.height - gap)
    tops.add(style.top + style.height + gap)
  })
  if (targetStyle && constraint) {
    const alignedLeft = constraint.align === 'start'
      ? targetStyle.left
      : constraint.align === 'end'
        ? targetStyle.left + targetStyle.width - preferred.width
        : targetStyle.left + (targetStyle.width - preferred.width) / 2
    const alignedTop = constraint.align === 'start'
      ? targetStyle.top
      : constraint.align === 'end'
        ? targetStyle.top + targetStyle.height - preferred.height
        : targetStyle.top + (targetStyle.height - preferred.height) / 2
    lefts.add(alignedLeft)
    tops.add(alignedTop)
  }

  const candidates: Array<GeometryRect & { distance: number }> = []
  for (const left of lefts) {
    if (left < padding || left > maxLeft) continue
    for (const top of tops) {
      if (top < padding || top > maxTop) continue
      const rect = { left, top, width: preferred.width, height: preferred.height }
      const distance = Math.abs(left - preferred.left) + Math.abs(top - preferred.top)
      if (distance > maxDistance) continue
      if (targetStyle && constraint && !placementMatches(rect, targetStyle, constraint)) continue
      const style = { ...effectiveStyle(component, device), ...rect }
      const free = obstacles.every((other) => {
        const otherStyle = effectiveStyle(other, device)
        return isAllowedDecorationOverlap(component, style, other, otherStyle)
          || !conflictsWithGap(style, otherStyle, gap)
      })
      if (free) candidates.push({ ...rect, distance })
    }
  }
  candidates.sort((first, second) => (
    first.distance - second.distance
    || first.top - second.top
    || first.left - second.left
  ))
  const selected = candidates[0]
  return selected
    ? { left: selected.left, top: selected.top, width: selected.width, height: selected.height }
    : null
}

const uniqueGeometryChanges = (changes: GeometryValidation[]) => {
  const unique = new Map<string, GeometryValidation>()
  changes.forEach((change) => {
    const key = `${change.id}:${change.device}`
    const previous = unique.get(key)
    unique.set(key, {
      ...previous,
      ...change,
      gap: Math.max(previous?.gap || 0, change.gap),
      placementConstraint: change.placementConstraint || previous?.placementConstraint
    })
  })
  return [...unique.values()].sort((first, second) => (
    first.device.localeCompare(second.device) || first.id.localeCompare(second.id)
  ))
}

const repairChangedGeometry = (
  source: PageData,
  page: PageData,
  rawChanges: GeometryValidation[]
) => {
  const warnings: string[] = []
  const unresolvedChanges: GeometryValidation[] = []
  const existingIds = new Set(page.components.map((component) => component.id))
  const changes = uniqueGeometryChanges(rawChanges).filter((change) => existingIds.has(change.id))
  for (const changed of changes) {
    const component = getComponent(page, changed.id)
    clampComponent(component, page, changed.device)
    const conflict = blockingGeometryConflict(source, page, changed)
    if (!conflict) continue
    const preferred = rectOf(effectiveStyle(component, changed.device))
    const repaired = findNearestValidRect(
      page,
      component,
      changed.device,
      preferred,
      changed.gap,
      changed.placementConstraint
    )
    if (!repaired) {
      unresolvedChanges.push(changed)
      continue
    }
    applyStyle(component, changed.device, { left: repaired.left, top: repaired.top })
    const remaining = blockingGeometryConflict(source, page, changed)
    if (remaining) {
      unresolvedChanges.push(changed)
      continue
    }
    const distance = Math.abs(repaired.left - preferred.left) + Math.abs(repaired.top - preferred.top)
    warnings.push(
      `已在${changed.device === DeviceType.MOBILE ? '手机端' : '桌面端'}自动移动“${component.name}” ${distance}px，以避免重叠并保持至少 ${changed.gap}px 间距。`
    )
  }
  const closure = collectGeometryConflictClosure(source, page, [...changes, ...unresolvedChanges])
  if (closure.conflicts.length) {
    throw new GeometryConflictError(
      closure.conflicts,
      closure.affectedComponentIds,
      closure.devices,
      closure.overflow
    )
  }
  return warnings
}

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

const affectedComponentDevices = (
  component: ComponentData,
  device: DeviceType,
  changedKeys: Array<keyof ComponentStyle>
) => {
  if (device === DeviceType.MOBILE) return [DeviceType.MOBILE]
  const devices: DeviceType[] = [DeviceType.DESKTOP]
  const mobile = component.responsiveOverrides?.mobile
  if (changedKeys.some((key) => mobile?.[key] === undefined)) devices.push(DeviceType.MOBILE)
  return devices
}

const affectedPageDevices = (
  page: PageData,
  device: DeviceType,
  changedKeys: Array<keyof PageStyle>
) => {
  if (device === DeviceType.MOBILE) return [DeviceType.MOBILE]
  const devices: DeviceType[] = [DeviceType.DESKTOP]
  const mobile = page.responsiveOverrides?.mobile
  if (changedKeys.some((key) => mobile?.[key] === undefined)) devices.push(DeviceType.MOBILE)
  return devices
}

const clampComponent = (component: ComponentData, page: PageData, device: DeviceType) => {
  const minimumHeight = component.type === ComponentType.FORM ? getFormMinimumHeight(component.props) : 40
  if (device === DeviceType.DESKTOP) {
    component.style.width = Math.min(page.style.width, Math.max(40, component.style.width))
    component.style.height = Math.min(page.style.height, Math.max(minimumHeight, component.style.height))
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
    height: Math.max(minimumHeight, current.height),
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

const addComponent = (
  page: PageData,
  operation: Extract<AIPageOperation, { op: 'addComponent' }>,
  componentId: string
) => {
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
    id: componentId,
    type: operation.componentType,
    name: operation.name?.slice(0, 80) || protocol.label,
    schemaVersion: SCHEMA_VERSION,
    style: {
      ...clone(protocol.defaultStyle),
      ...(operation.device === DeviceType.MOBILE ? {} : styleChanges),
      zIndex: page.components.reduce(
        (maximum, item) => Math.max(maximum, Number(item.style.zIndex) || 0),
        0
      ) + 1
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
  if (isDecorativeComponent(component, component.style)) {
    page.components.unshift(component)
    page.components.forEach((item, order) => { item.style.zIndex = order + 1 })
  } else {
    page.components.push(component)
  }
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
  const changedDevices = new Set<DeviceType>()
  if (component.type === ComponentType.TEXT && 'content' in operation.changes) {
    const previousDesktopHeight = component.style.height
    const previousMobileHeight = effectiveStyle(component, DeviceType.MOBILE).height
    const content = (component.props as { content?: unknown }).content
    component.style.height = Math.max(
      component.style.height,
      estimateTextHeight(content, component.style.width, component.style.fontSize, component.style.lineHeight)
    )
    const mobile = effectiveStyle(component, DeviceType.MOBILE)
    applyStyle(component, DeviceType.MOBILE, {
      height: Math.max(mobile.height, estimateTextHeight(content, mobile.width, mobile.fontSize, mobile.lineHeight))
    })
    if (component.style.height !== previousDesktopHeight) changedDevices.add(DeviceType.DESKTOP)
    if (effectiveStyle(component, DeviceType.MOBILE).height !== previousMobileHeight) changedDevices.add(DeviceType.MOBILE)
  }
  if (component.type === ComponentType.FORM && 'fields' in operation.changes) {
    const previousDesktopHeight = component.style.height
    const previousMobileHeight = effectiveStyle(component, DeviceType.MOBILE).height
    const minimumHeight = getFormMinimumHeight(component.props)
    component.style.height = Math.max(component.style.height, minimumHeight)
    const mobile = effectiveStyle(component, DeviceType.MOBILE)
    applyStyle(component, DeviceType.MOBILE, { height: Math.max(mobile.height, minimumHeight) })
    if (component.style.height !== previousDesktopHeight) changedDevices.add(DeviceType.DESKTOP)
    if (effectiveStyle(component, DeviceType.MOBILE).height !== previousMobileHeight) changedDevices.add(DeviceType.MOBILE)
  }
  return [...changedDevices]
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

export const applyAIPagePatch = (
  source: PageData,
  rawPatch: unknown,
  expectedRevision: number,
  executionContext: AIPagePatchExecutionContext = {}
) => {
  const patch = validateAIPagePatch(rawPatch)
  if (patch.baseRevision !== expectedRevision) {
    throw new Error(`AI Patch 基于 revision ${patch.baseRevision}，但当前请求基于 revision ${expectedRevision}。`)
  }
  const page = clone(source)
  const geometryChanges: GeometryValidation[] = []
  const resizedPages = new Set<DeviceType>()
  const executionStartedAt = Date.now()
  const createComponentId = executionContext.createComponentId || ((operationIndex: number) => (
    `comp_ai_${executionStartedAt}_${operationIndex}_${Math.random().toString(16).slice(2, 8)}`
  ))
  const updatedAt = typeof executionContext.now === 'string' && Number.isFinite(Date.parse(executionContext.now))
    ? executionContext.now
    : new Date(executionStartedAt).toISOString()

  for (const [operationIndex, operation] of patch.operations.entries()) {
    switch (operation.op) {
      case 'updateProps':
        updateProps(page, operation).forEach((device) => {
          geometryChanges.push({ id: operation.componentId, device, gap: 16 })
        })
        break
      case 'updateStyle': {
        const component = getComponent(page, operation.componentId)
        const before = { ...effectiveStyle(component, operation.device) }
        const changes = sanitizeStyleChanges(operation.changes)
        applyStyle(component, operation.device, changes)
        clampComponent(component, page, operation.device)
        const geometryKeys = (['top', 'left', 'width', 'height'] as Array<keyof ComponentStyle>)
          .filter((key) => effectiveStyle(component, operation.device)[key] !== before[key])
        const layerKeys = (['rotate', 'opacity'] as Array<keyof ComponentStyle>)
          .filter((key) => effectiveStyle(component, operation.device)[key] !== before[key])
        if (geometryKeys.length) {
          affectedComponentDevices(component, operation.device, geometryKeys).forEach((device) => {
            geometryChanges.push({ id: component.id, device, gap: 16 })
          })
        } else if (layerKeys.length) {
          affectedComponentDevices(component, operation.device, layerKeys).forEach((device) => {
            geometryChanges.push({ id: component.id, device, gap: 0 })
          })
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
        const resizedKeys = (['width', 'height'] as Array<keyof PageStyle>)
          .filter((key) => next[key] !== undefined)
        if (resizedKeys.length) {
          affectedPageDevices(page, operation.device, resizedKeys).forEach((device) => resizedPages.add(device))
        }
        break
      }
      case 'placeRelative': {
        const component = getComponent(page, operation.componentId)
        const before = { ...effectiveStyle(component, operation.device) }
        placeRelative(page, operation)
        const changedKeys = (['top', 'left', 'width', 'height', 'rotate'] as Array<keyof ComponentStyle>)
          .filter((key) => effectiveStyle(component, operation.device)[key] !== before[key])
        if (changedKeys.length) affectedComponentDevices(component, operation.device, changedKeys).forEach((device) => {
          geometryChanges.push({
            id: operation.componentId,
            device,
            gap: 16,
            ...(device === operation.device
              ? {
                  placementConstraint: {
                    targetId: operation.targetId,
                    relation: operation.relation,
                    align: operation.align || 'center',
                    gap: Math.max(0, Math.min(96, finite(operation.gap) ? operation.gap : 16))
                  }
                }
              : {})
          })
        })
        break
      }
      case 'addComponent': {
        const id = createComponentId(operationIndex)
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
          throw new Error(`新增组件 ID“${id}”格式无效。`)
        }
        if (page.components.some((component) => component.id === id)) {
          throw new Error(`新增组件 ID“${id}”与页面现有组件重复。`)
        }
        addComponent(page, operation, id)
        geometryChanges.push({ id, device: DeviceType.DESKTOP, gap: 16 })
        geometryChanges.push({ id, device: DeviceType.MOBILE, gap: 16 })
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
        geometryChanges.push(
          { id: operation.componentId, device: DeviceType.DESKTOP, gap: 0 },
          { id: operation.componentId, device: DeviceType.MOBILE, gap: 0 }
        )
        break
    }
  }

  resizedPages.forEach((device) => page.components.forEach((component) => {
    clampComponent(component, page, device)
    geometryChanges.push({ id: component.id, device, gap: 16 })
  }))

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
  const geometryWarnings = repairChangedGeometry(source, page, geometryChanges)
  page.meta.updatedAt = updatedAt

  const repaired = validateAndRepairPageData(page)
  return { page: repaired.page, warnings: [...geometryWarnings, ...repaired.warnings], patch }
}
