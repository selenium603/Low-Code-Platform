import { ComponentType, DeviceType } from '../types'
import type { ComponentData, ComponentProtocol, ComponentStyle, FormField, PageData, ResponsiveOverrides } from '../types'
import { getComponentProtocol } from './componentProtocols'
import { getFormMinimumHeight } from '../utils/formLayout'

type UnknownRecord = Record<string, unknown>

export interface PageImportResult {
  page: PageData
  warnings: string[]
}

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const pageId = () => `page_${Date.now()}`
const componentId = (index: number) => `comp_import_${Date.now()}_${index}`

/** 净化组件 ID，仅保留安全字符（字母、数字、下划线、连字符），防止 CSS 选择器注入 */
const sanitizeComponentId = (raw: string, fallback: string): string => {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[0-9]/, '_$&')
  return sanitized || fallback
}

const repairFormFields = (value: unknown, warnings: string[]): FormField[] | null => {
  if (!Array.isArray(value)) return null

  const fields = value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.label !== 'string') {
      warnings.push(`表单字段 ${index + 1} 格式无效，已跳过。`)
      return []
    }

    const type = ['text', 'email', 'tel'].includes(String(item.type)) ? item.type as FormField['type'] : 'text'
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `field_${index + 1}`,
      label: item.label,
      type,
      placeholder: typeof item.placeholder === 'string' ? item.placeholder : '',
      required: Boolean(item.required)
    }]
  })

  return fields
}

const repairChartData = (value: unknown, warnings: string[]) => {
  if (!Array.isArray(value)) return null
  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !isFiniteNumber(item.value)) {
      warnings.push(`图表数据 ${index + 1} 格式无效，已跳过。`)
      return []
    }
    return [{ name: item.name, value: item.value }]
  })
}

const repairProps = (protocol: ComponentProtocol, value: unknown, warnings: string[]): ComponentData['props'] => {
  const raw = isRecord(value) ? value : {}
  const props = clone(protocol.defaultProps) as unknown as UnknownRecord

  for (const field of protocol.schema) {
    const candidate = raw[field.key]
    if (candidate === undefined) continue

    if (field.type === 'string' || field.type === 'color') {
      if (typeof candidate === 'string') props[field.key] = candidate
      else warnings.push(`组件“${protocol.label}”的“${field.label}”无效，已使用默认值。`)
      continue
    }

    if (field.type === 'number') {
      if (isFiniteNumber(candidate)) props[field.key] = candidate
      else warnings.push(`组件“${protocol.label}”的“${field.label}”必须是数字，已使用默认值。`)
      continue
    }

    if (field.type === 'boolean') {
      if (typeof candidate === 'boolean') props[field.key] = candidate
      else warnings.push(`组件“${protocol.label}”的“${field.label}”必须是布尔值，已使用默认值。`)
      continue
    }

    if (field.type === 'select') {
      if (typeof candidate === 'string' && field.options?.includes(candidate)) props[field.key] = candidate
      else warnings.push(`组件“${protocol.label}”的“${field.label}”选项无效，已使用默认值。`)
      continue
    }

    if (field.arrayFormat === 'name-value-lines') {
      const data = repairChartData(candidate, warnings)
      if (data) props[field.key] = data
    } else {
      const fields = repairFormFields(candidate, warnings)
      if (fields) props[field.key] = fields
    }
  }

  return props as unknown as ComponentData['props']
}

const repairStyle = (protocol: ComponentProtocol, value: unknown): ComponentStyle => {
  const raw = isRecord(value) ? value : {}
  const style = clone(protocol.defaultStyle)
  const numericKeys: Array<keyof ComponentStyle> = [
    'top', 'left', 'width', 'height', 'zIndex', 'rotate', 'opacity',
    'fontSize', 'fontWeight', 'lineHeight', 'borderWidth', 'borderRadius'
  ]
  const colorKeys: Array<keyof ComponentStyle> = ['color', 'backgroundColor', 'borderColor']

  numericKeys.forEach((key) => {
    if (isFiniteNumber(raw[key])) (style[key] as number | undefined) = raw[key] as number
  })
  colorKeys.forEach((key) => {
    if (typeof raw[key] === 'string') (style[key] as string | undefined) = raw[key] as string
  })
  if (raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right') {
    style.textAlign = raw.textAlign
  }

  style.top = Math.max(0, style.top)
  style.left = Math.max(0, style.left)
  style.width = Math.max(40, style.width)
  style.height = Math.max(40, style.height)
  style.opacity = Math.max(0, Math.min(1, style.opacity))

  return style
}

/** 校验并修复 responsiveOverrides，保留有效的移动端覆盖样式 */
const repairResponsiveOverrides = (value: unknown): ResponsiveOverrides | undefined => {
  if (!isRecord(value)) return undefined
  const result: ResponsiveOverrides = {}
  const validDevices = [DeviceType.DESKTOP, DeviceType.MOBILE]
  const numericKeys: Array<keyof ComponentStyle> = [
    'top', 'left', 'width', 'height', 'zIndex', 'rotate', 'opacity',
    'fontSize', 'fontWeight', 'lineHeight', 'borderWidth', 'borderRadius'
  ]
  const colorKeys: Array<keyof ComponentStyle> = ['color', 'backgroundColor', 'borderColor']

  for (const device of validDevices) {
    const raw = value[device]
    if (!isRecord(raw)) continue
    const overrides: Partial<ComponentStyle> = {}
    numericKeys.forEach((key) => {
      if (isFiniteNumber(raw[key])) overrides[key] = raw[key] as never
    })
    colorKeys.forEach((key) => {
      if (typeof raw[key] === 'string') overrides[key] = raw[key] as never
    })
    if (raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right') overrides.textAlign = raw.textAlign
    if (overrides.width !== undefined) overrides.width = Math.max(40, overrides.width)
    if (overrides.height !== undefined) overrides.height = Math.max(40, overrides.height)
    if (overrides.opacity !== undefined) overrides.opacity = Math.max(0, Math.min(1, overrides.opacity))
    if (overrides.top !== undefined) overrides.top = Math.max(0, overrides.top)
    if (overrides.left !== undefined) overrides.left = Math.max(0, overrides.left)
    if (Object.keys(overrides).length > 0) {
      result[device] = overrides
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

const repairPageResponsiveOverrides = (value: unknown) => {
  if (!isRecord(value) || !isRecord(value.mobile)) return undefined
  const raw = value.mobile
  const mobile: Partial<PageData['style']> = {}
  if (isFiniteNumber(raw.width)) mobile.width = Math.max(320, raw.width)
  if (isFiniteNumber(raw.height)) mobile.height = Math.max(400, raw.height)
  if (typeof raw.backgroundColor === 'string') mobile.backgroundColor = raw.backgroundColor
  if (typeof raw.backgroundImage === 'string') mobile.backgroundImage = raw.backgroundImage
  return Object.keys(mobile).length > 0 ? { [DeviceType.MOBILE]: mobile } : undefined
}

const repairComponent = (value: unknown, index: number, warnings: string[]): ComponentData | null => {
  if (!isRecord(value) || !Object.values(ComponentType).includes(value.type as ComponentType)) {
    warnings.push(`第 ${index + 1} 个组件类型无效，已跳过。`)
    return null
  }

  const type = value.type as ComponentType
  const protocol = getComponentProtocol(type)
  if (!protocol) {
    warnings.push(`第 ${index + 1} 个组件未注册，已跳过。`)
    return null
  }

  const style = repairStyle(protocol, value.style)
  const props = repairProps(protocol, value.props, warnings)
  const responsiveOverrides = repairResponsiveOverrides(value.responsiveOverrides)
  // 兼容 2026.01 的 Button.props.color：旧数据把背景色放在 props 中。
  if (
    type === ComponentType.BUTTON &&
    isRecord(value.props) &&
    typeof value.props.color === 'string' &&
    (!isRecord(value.style) || typeof value.style.backgroundColor !== 'string')
  ) {
    style.backgroundColor = value.props.color
    warnings.push(`组件“${protocol.label}”使用了旧版颜色字段，已迁移到样式配置。`)
  }
  if (type === ComponentType.FORM) {
    const minimumHeight = getFormMinimumHeight(props)
    style.height = Math.max(style.height, minimumHeight)
    if (responsiveOverrides?.mobile) {
      responsiveOverrides.mobile.height = Math.max(
        Number(responsiveOverrides.mobile.height) || style.height,
        minimumHeight
      )
    }
  }

  return {
    id: typeof value.id === 'string' && value.id ? sanitizeComponentId(value.id, componentId(index)) : componentId(index),
    type,
    name: typeof value.name === 'string' && value.name ? value.name : protocol.label,
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : '2026.01',
    style,
    props,
    events: Array.isArray(value.events)
      ? value.events.filter((event) => isRecord(event) && event.type === 'click' && isRecord(event.config)).map((event) => ({
          type: 'click' as const,
          config: {
            action: ['none', 'url', 'message'].includes(String(event.config.action))
              ? event.config.action as 'none' | 'url' | 'message'
              : 'none',
            ...(typeof event.config.url === 'string' ? { url: event.config.url } : {}),
            ...(typeof event.config.message === 'string' ? { message: event.config.message } : {}),
            ...(typeof event.config.newTab === 'boolean' ? { newTab: event.config.newTab } : {})
          }
        }))
      : [{ type: 'click', config: { action: 'none' } }],
    ...(responsiveOverrides
      ? { responsiveOverrides }
      : {})
  }
}

export const validateAndRepairPageData = (value: unknown): PageImportResult => {
  if (!isRecord(value)) throw new Error('页面 JSON 必须是一个对象。')

  const warnings: string[] = []
  const rawMeta = isRecord(value.meta) ? value.meta : {}
  const rawStyle = isRecord(value.style) ? value.style : {}
  const pageResponsiveOverrides = repairPageResponsiveOverrides(value.responsiveOverrides)
  const rawComponents = Array.isArray(value.components) ? value.components : []
  if (!Array.isArray(value.components)) warnings.push('组件列表无效，已按空页面导入。')

  const scene = ['marketing', 'landing', 'form'].includes(String(rawMeta.scene))
    ? rawMeta.scene as PageData['meta']['scene']
    : 'marketing'
  const componentIds = new Set<string>()
  const components = rawComponents.flatMap((component, index) => {
    const repaired = repairComponent(component, index, warnings)
    if (!repaired) return []
    if (componentIds.has(repaired.id)) {
      repaired.id = componentId(index)
      warnings.push(`第 ${index + 1} 个组件 ID 重复，已重新生成。`)
    }
    componentIds.add(repaired.id)
    return [repaired]
  })

  return {
    page: {
      id: typeof value.id === 'string' && value.id ? value.id : pageId(),
      meta: {
        title: typeof rawMeta.title === 'string' ? rawMeta.title : '未命名页面',
        description: typeof rawMeta.description === 'string' ? rawMeta.description : '',
        createdAt: typeof rawMeta.createdAt === 'string' ? rawMeta.createdAt : new Date().toISOString(),
        updatedAt: typeof rawMeta.updatedAt === 'string' ? rawMeta.updatedAt : new Date().toISOString(),
        version: typeof rawMeta.version === 'string' ? rawMeta.version : '2026.05',
        scene
      },
      style: {
        width: isFiniteNumber(rawStyle.width) ? rawStyle.width : 1200,
        height: isFiniteNumber(rawStyle.height) ? rawStyle.height : 820,
        backgroundColor: typeof rawStyle.backgroundColor === 'string' ? rawStyle.backgroundColor : '#f9fafb',
        backgroundImage: typeof rawStyle.backgroundImage === 'string' ? rawStyle.backgroundImage : ''
      },
      ...(pageResponsiveOverrides ? { responsiveOverrides: pageResponsiveOverrides } : {}),
      components
    },
    warnings
  }
}
