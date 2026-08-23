import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ComponentData,
  ComponentEvent,
  ComponentStyle,
  Command,
  PageData,
  PageMeta,
  PageStyle,
  DeviceType,
  ResponsiveOverrides
} from '@/types'
import { ComponentType, DeviceType as DT } from '@/types'
import { useHistoryStore } from './history'
import { getComponentProtocol } from '@/components/components/registry'
import { SCHEMA_VERSION, migratePageData } from './migration'
import { validateAndRepairPageData } from './pageImport'
import { MOBILE_AVAILABLE_WIDTH } from '@/utils/mobile'
import { estimateTextHeight } from '@/utils/textLayout'
import { getFormMinimumHeight } from '@/utils/formLayout'

const STORAGE_KEY = 'marketing-editor-page'
const GRID_SIZE = 10

const DEVICE_PRESETS: Record<DeviceType, { width: number; height: number; label: string }> = {
  [DT.DESKTOP]: { width: 1200, height: 820, label: 'PC' },
  [DT.MOBILE]: { width: 375, height: 812, label: '手机' }
}

/** 合并基础样式和设备覆盖样式 */
const getMergedStyle = (component: ComponentData, device: DeviceType): ComponentStyle => {
  const overrides = component.responsiveOverrides?.[device]
  if (!overrides) return component.style
  return { ...component.style, ...overrides }
}

const createPageMeta = (title = '营销活动页'): PageMeta => ({
  title,
  description: '面向营销活动与落地页场景的低代码页面',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: SCHEMA_VERSION,
  scene: 'marketing'
})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const createProtocolComponent = (
  type: ComponentType,
  overrides: {
    style?: Partial<ComponentStyle>
    props?: Record<string, unknown>
    events?: ComponentEvent[]
    name?: string
    responsiveOverrides?: ResponsiveOverrides
  } = {}
): ComponentData => {
  const protocol = getComponentProtocol(type)
  if (!protocol) {
    throw new Error(`Unknown component type: ${type}`)
  }

  return {
    id: `comp_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    name: overrides.name || protocol.label,
    schemaVersion: SCHEMA_VERSION,
    style: {
      ...clone(protocol.defaultStyle),
      ...clone(overrides.style || {})
    },
    props: {
      ...clone(protocol.defaultProps),
      ...clone(overrides.props || {})
    } as ComponentData['props'],
    events: clone(overrides.events || [{ type: 'click', config: { action: 'none' } }]),
    ...(overrides.responsiveOverrides
      ? { responsiveOverrides: clone(overrides.responsiveOverrides) }
      : {})
  }
}

const createStarterComponents = (): ComponentData[] => [
  createProtocolComponent(ComponentType.TEXT, {
    name: '主标题',
    style: { top: 72, left: 72, width: 420, height: 80, fontSize: 36, fontWeight: 700, color: '#111827' },
    props: { content: '2026 春季增长活动，限时开启' },
    responsiveOverrides: {
      [DT.MOBILE]: { top: 24, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 88, fontSize: 30, lineHeight: 1.25, rotate: 0 }
    }
  }),
  createProtocolComponent(ComponentType.TEXT, {
    name: '卖点描述',
    style: { top: 162, left: 72, width: 420, height: 72, fontSize: 16, fontWeight: 400, color: '#4b5563' },
    props: { content: '低代码搭建营销落地页，支持拖拽布局、图层管理、属性配置、实时预览与页面 JSON 导入导出。' },
    responsiveOverrides: {
      [DT.MOBILE]: { top: 144, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 96, fontSize: 16, lineHeight: 1.6, rotate: 0 }
    }
  }),
  createProtocolComponent(ComponentType.BUTTON, {
    name: '主 CTA',
    style: { top: 258, left: 72, width: 180, height: 46, backgroundColor: '#2563eb', borderColor: '#2563eb' },
    props: { content: '立即报名' },
    events: [{ type: 'click', config: { action: 'url', url: 'https://example.com', newTab: true } }],
    responsiveOverrides: {
      [DT.MOBILE]: { top: 604, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 52, rotate: 0 }
    }
  }),
  createProtocolComponent(ComponentType.INPUT, {
    name: '手机号输入',
    style: { top: 258, left: 270, width: 220, height: 46, backgroundColor: '#ffffff', borderColor: '#d1d5db' },
    props: { placeholder: '请输入手机号', inputType: 'tel' },
    responsiveOverrides: {
      [DT.MOBILE]: { top: 524, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 48, rotate: 0 }
    }
  }),
  createProtocolComponent(ComponentType.IMAGE, {
    name: '活动主视觉',
    style: { top: 348, left: 72, width: 420, height: 240, backgroundColor: '#f3f4f6', borderRadius: 18 },
    props: { src: '', alt: '活动主视觉', objectFit: 'cover' },
    responsiveOverrides: {
      [DT.MOBILE]: { top: 272, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 220, borderRadius: 16, rotate: 0 }
    }
  }),
  createProtocolComponent(ComponentType.FORM, {
    name: '报名表单',
    style: { top: 96, left: 600, width: 360, height: 420, backgroundColor: '#ffffff', borderColor: '#e5e7eb' },
    props: { title: '活动报名信息', submitText: '提交线索' },
    responsiveOverrides: {
      [DT.MOBILE]: { top: 688, left: 12, width: MOBILE_AVAILABLE_WIDTH, height: 460, borderRadius: 16, rotate: 0 }
    }
  })
].map((item, index) => ({
  ...item,
  style: {
    ...item.style,
    zIndex: index + 1
  }
}))

const createDefaultPage = (title = '营销活动页'): PageData => ({
  id: `page_${Date.now()}`,
  meta: createPageMeta(title),
  components: createStarterComponents(),
  style: {
    width: 1200,
    height: 820,
    backgroundColor: '#f9fafb',
    backgroundImage: ''
  },
  responsiveOverrides: {
    [DT.MOBILE]: {
      width: 375,
      height: 1172,
      backgroundColor: '#f8fafc'
    }
  }
})

const normalizeComponentLayout = (component: ComponentData, page: PageData): ComponentData => {
  const next = clone(component)
  const maxWidth = Math.max(120, page.style.width)
  const maxHeight = Math.max(120, page.style.height)

  next.style.width = Math.min(next.style.width, maxWidth)
  next.style.height = Math.min(next.style.height, maxHeight)

  if (next.type === ComponentType.FORM) {
    const minimumHeight = getFormMinimumHeight(next.props)
    next.style.height = Math.max(next.style.height, minimumHeight)
    next.style.width = Math.max(next.style.width, 320)
    const mobile = next.responsiveOverrides?.mobile
    if (mobile) mobile.height = Math.max(Number(mobile.height) || next.style.height, minimumHeight)
  }

  next.style.left = Math.max(0, Math.min(next.style.left, Math.max(0, page.style.width - next.style.width)))
  next.style.top = Math.max(0, Math.min(next.style.top, Math.max(0, page.style.height - next.style.height)))

  return next
}

const normalizePageData = (page: PageData): PageData => {
  let nextPage = migratePageData(page)
  nextPage = clone(nextPage)
  nextPage.style.width = Math.max(nextPage.style.width || 1200, 960)
  nextPage.style.height = Math.max(nextPage.style.height || 820, 720)
  nextPage.style.backgroundColor = nextPage.style.backgroundColor || '#f9fafb'
  nextPage.style.backgroundImage = nextPage.style.backgroundImage || ''
  nextPage.meta.version = SCHEMA_VERSION
  nextPage.components = nextPage.components.map((component, index) => {
    const normalized = normalizeComponentLayout(component, nextPage)
    normalized.style.zIndex = index + 1
    return normalized
  })
  return nextPage
}

/** 按当前数组顺序把图层整理为连续的 1…N，避免删除后留下空洞或重复层级。 */
const reindexComponentLayers = (components: ComponentData[]) => {
  components.forEach((component, index) => {
    component.style.zIndex = index + 1
  })
}

export const useEditorStore = defineStore('editor', () => {
  const currentPage = ref<PageData | null>(null)
  const currentComponent = ref<ComponentData | null>(null)
  // 缩放比例属于编辑器视图状态，按设备分别保存，切换设备时不互相覆盖。
  const deviceCanvasScales = ref<Record<DeviceType, number>>({
    [DT.DESKTOP]: 0.9,
    [DT.MOBILE]: 0.84
  })
  const initializedDeviceScales = ref<Record<DeviceType, boolean>>({
    [DT.DESKTOP]: false,
    // 移动端使用固定的默认视图比例，避免首次切换时被自动适配计算覆盖。
    [DT.MOBILE]: true
  })
  const snapToGrid = ref(true)
  const showGuidelines = ref(true)
  const lastSavedAt = ref('')
  const currentDevice = ref<DeviceType>(DT.DESKTOP)
  // 单调递增的编辑修订号用于防止 AI 响应覆盖请求期间发生的手工修改。
  const pageRevision = ref(0)

  const getEffectivePageStyle = (page = currentPage.value, device = currentDevice.value): PageStyle => {
    const base = page?.style || { width: DEVICE_PRESETS[device].width, height: DEVICE_PRESETS[device].height, backgroundColor: '#f9fafb' }
    const overrides = page?.responsiveOverrides?.[device] || {}
    if (device === DT.MOBILE) {
      return {
        ...base,
        ...overrides,
        width: overrides.width ?? DEVICE_PRESETS[DT.MOBILE].width,
        height: overrides.height ?? DEVICE_PRESETS[DT.MOBILE].height
      }
    }
    return { ...base, ...overrides }
  }

  const devicePresets = DEVICE_PRESETS
  const currentDeviceWidth = computed(() => getEffectivePageStyle().width)
  const currentDeviceHeight = computed(() => getEffectivePageStyle().height)

  const touchPageMeta = () => {
    if (!currentPage.value) return
    currentPage.value.meta.updatedAt = new Date().toISOString()
    pageRevision.value += 1
  }

  const createNewPage = (title = '营销活动页') => {
    currentPage.value = normalizePageData(createDefaultPage(title))
    currentComponent.value = null
    lastSavedAt.value = ''
    pageRevision.value = 0
    persistPage()
  }

  const ensurePage = () => {
    if (!currentPage.value) createNewPage()
  }

  const addComponent = (
    type: ComponentType,
    initialData: {
      style?: Partial<ComponentStyle>
      props?: Record<string, unknown>
      events?: ComponentEvent[]
      responsiveOverrides?: ResponsiveOverrides
    } = {}
  ) => {
    ensurePage()
    if (!currentPage.value) return

    const protocol = getComponentProtocol(type)
    if (!protocol) return

    const historyStore = useHistoryStore()
    const nextZIndex = currentPage.value.components.reduce(
      (maximum, item) => Math.max(maximum, Number(item.style.zIndex) || 0),
      0
    ) + 1
    const component = createProtocolComponent(type, {
      ...initialData,
      style: {
        ...initialData.style,
        zIndex: nextZIndex
      }
    })
    // 移动端新增组件时将 responsiveOverrides 一并纳入命令，确保撤销/重做完整
    if (initialData.responsiveOverrides) {
      component.responsiveOverrides = clone(initialData.responsiveOverrides)
    }

    const command: Command = {
      label: `新增${protocol.label}`,
      execute: () => {
        if (!currentPage.value) return
        component.style.zIndex = currentPage.value.components.reduce(
          (maximum, item) => Math.max(maximum, Number(item.style.zIndex) || 0),
          0
        ) + 1
        const normalized = normalizeComponentLayout(component, currentPage.value)
        currentPage.value.components.push(normalized)
        currentComponent.value = normalized
        touchPageMeta()
      },
      undo: () => {
        if (!currentPage.value) return
        const index = currentPage.value.components.findIndex((item) => item.id === component.id)
        if (index >= 0) currentPage.value.components.splice(index, 1)
        if (currentComponent.value?.id === component.id) currentComponent.value = null
        touchPageMeta()
      }
    }

    historyStore.executeCommand(command)
  }

  const selectComponent = (component: ComponentData | null) => {
    currentComponent.value = component
  }

  const commitComponentStyle = (
    componentId: string,
    nextStyle: ComponentStyle | Partial<ComponentStyle>,
    previousStyle?: ComponentStyle | Partial<ComponentStyle>
  ) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return

    const isDesktop = currentDevice.value === DT.DESKTOP

    if (isDesktop) {
      const prevStyle: ComponentStyle = clone((previousStyle || component.style) as ComponentStyle)
      const newStyle: ComponentStyle = clone(nextStyle as ComponentStyle)
      if (component.type === ComponentType.FORM) {
        newStyle.height = Math.max(newStyle.height, getFormMinimumHeight(component.props))
      }
      if (JSON.stringify(prevStyle) === JSON.stringify(newStyle)) return

      useHistoryStore().executeCommand({
        label: '更新组件样式',
        execute: () => {
          component.style = clone(newStyle)
          touchPageMeta()
        },
        undo: () => {
          component.style = clone(prevStyle)
          touchPageMeta()
        }
      })
    } else {
      const device = currentDevice.value
      const prevOverrides = clone(previousStyle || component.responsiveOverrides?.[device] || {})
      const normalizedNextStyle = clone(nextStyle)
      if (component.type === ComponentType.FORM) {
        normalizedNextStyle.height = Math.max(
          Number(normalizedNextStyle.height) || getMergedStyle(component, device).height,
          getFormMinimumHeight(component.props)
        )
      }

      // 差量覆盖：仅保存与桌面端基础样式不同的字段，避免把完整桌面样式固化为移动端覆盖
      const baseStyle = component.style
      const delta: Partial<ComponentStyle> = {}

      // 视觉/尺寸字段：仅当与桌面端基础样式不同时才保存
      const deltaKeys: Array<keyof ComponentStyle> = [
        'top', 'left', 'width', 'height', 'rotate', 'opacity',
        'fontSize', 'fontWeight', 'lineHeight', 'color',
        'backgroundColor', 'borderWidth', 'borderColor', 'borderRadius', 'textAlign'
      ]
      for (const key of deltaKeys) {
        const newVal = normalizedNextStyle[key]
        const baseVal = baseStyle[key]
        if (newVal !== undefined && newVal !== baseVal) {
          Object.assign(delta, { [key]: newVal })
        }
      }

      const newOverrides = delta
      if (JSON.stringify(prevOverrides) === JSON.stringify(newOverrides)) return

      useHistoryStore().executeCommand({
        label: `更新${DEVICE_PRESETS[device].label}端样式`,
        execute: () => {
          if (!component.responsiveOverrides) component.responsiveOverrides = {}
          if (Object.keys(newOverrides).length > 0) {
            component.responsiveOverrides[device] = clone(newOverrides)
          } else {
            delete component.responsiveOverrides[device]
          }
          touchPageMeta()
        },
        undo: () => {
          if (!component.responsiveOverrides) component.responsiveOverrides = {}
          if (Object.keys(prevOverrides).length > 0) {
            component.responsiveOverrides[device] = clone(prevOverrides)
          } else {
            delete component.responsiveOverrides[device]
          }
          touchPageMeta()
        }
      })
    }
  }

  const applyComponentStyle = (componentId: string, styleUpdates: Partial<ComponentStyle>) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return

    if (currentDevice.value === DT.DESKTOP) {
      component.style = normalizeComponentLayout({ ...component, style: {
        ...component.style,
        ...styleUpdates
      } }, currentPage.value).style
    } else {
      if (!component.responsiveOverrides) component.responsiveOverrides = {}
      const current = component.responsiveOverrides[currentDevice.value] || {}
      component.responsiveOverrides[currentDevice.value] = {
        ...current,
        ...styleUpdates
      }
    }
  }

  /** 获取组件在当前设备下的合并样式 */
  const getEffectiveStyle = (component: ComponentData): ComponentStyle => {
    return getMergedStyle(component, currentDevice.value)
  }

  const commitComponentProps = (componentId: string, nextProps: ComponentData['props']) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return

    const prevProps = clone(component.props)
    const newProps = clone(nextProps)
    const prevStyle = clone(component.style)
    const prevOverrides = clone(component.responsiveOverrides || {})
    const nextStyle = clone(component.style)
    const nextOverrides = clone(component.responsiveOverrides || {})

    if (component.type === ComponentType.TEXT) {
      const content = (newProps as { content?: unknown }).content
      nextStyle.height = Math.max(
        nextStyle.height,
        estimateTextHeight(content, nextStyle.width, nextStyle.fontSize, nextStyle.lineHeight)
      )
      const mobile = { ...nextStyle, ...(nextOverrides.mobile || {}) }
      const mobileHeight = estimateTextHeight(content, mobile.width, mobile.fontSize, mobile.lineHeight)
      if (mobileHeight > mobile.height) {
        nextOverrides.mobile = { ...(nextOverrides.mobile || {}), height: mobileHeight }
      }
    }
    if (component.type === ComponentType.FORM) {
      const minimumHeight = getFormMinimumHeight(newProps)
      nextStyle.height = Math.max(nextStyle.height, minimumHeight)
      const mobileHeight = Math.max(
        minimumHeight,
        Number(nextOverrides.mobile?.height) || nextStyle.height
      )
      nextOverrides.mobile = { ...(nextOverrides.mobile || {}), height: mobileHeight }
    }

    useHistoryStore().executeCommand({
      label: '更新组件属性',
      execute: () => {
        component.props = clone(newProps)
        component.style = clone(nextStyle)
        component.responsiveOverrides = clone(nextOverrides)
        touchPageMeta()
      },
      undo: () => {
        component.props = clone(prevProps)
        component.style = clone(prevStyle)
        component.responsiveOverrides = clone(prevOverrides)
        touchPageMeta()
      }
    })
  }

  const renameComponent = (componentId: string, rawName: string) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return
    const nextName = rawName.trim().slice(0, 80)
    if (!nextName || nextName === component.name) return
    const previousName = component.name
    useHistoryStore().executeCommand({
      label: '重命名图层',
      execute: () => {
        component.name = nextName
        touchPageMeta()
      },
      undo: () => {
        component.name = previousName
        touchPageMeta()
      }
    })
  }

  const commitComponentEvents = (componentId: string, nextEvents: ComponentEvent[]) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return

    const prevEvents = clone(component.events)
    const newEvents = clone(nextEvents)

    useHistoryStore().executeCommand({
      label: '更新组件事件',
      execute: () => {
        component.events = clone(newEvents)
        touchPageMeta()
      },
      undo: () => {
        component.events = clone(prevEvents)
        touchPageMeta()
      }
    })
  }

  const deleteComponent = (componentId: string) => {
    if (!currentPage.value) return

    const index = currentPage.value.components.findIndex((item) => item.id === componentId)
    if (index < 0) return

    const rawComponent = currentPage.value.components[index]
    if (!rawComponent) return
    const component = clone(rawComponent)
    const wasSelected = currentComponent.value?.id === componentId

    useHistoryStore().executeCommand({
      label: '删除组件',
      execute: () => {
        if (!currentPage.value) return
        currentPage.value.components.splice(index, 1)
        reindexComponentLayers(currentPage.value.components)
        if (wasSelected) currentComponent.value = null
        touchPageMeta()
      },
      undo: () => {
        if (!currentPage.value) return
        currentPage.value.components.splice(index, 0, component)
        reindexComponentLayers(currentPage.value.components)
        if (wasSelected) currentComponent.value = currentPage.value.components[index] || null
        touchPageMeta()
      }
    })
  }

  const moveComponentLayer = (componentId: string, direction: 'up' | 'down' | 'top' | 'bottom') => {
    if (!currentPage.value) return

    const before = clone(currentPage.value.components)
    const next = clone(currentPage.value.components)
    const index = next.findIndex((item) => item.id === componentId)
    if (index < 0) return

    if (direction === 'up' && index < next.length - 1) {
      const item = next[index]
      if (!item) return
      next.splice(index, 1)
      next.splice(index + 1, 0, item)
    } else if (direction === 'down' && index > 0) {
      const item = next[index]
      if (!item) return
      next.splice(index, 1)
      next.splice(index - 1, 0, item)
    } else if (direction === 'top') {
      const item = next.splice(index, 1)[0]
      if (!item) return
      next.push(item)
    } else if (direction === 'bottom') {
      const item = next.splice(index, 1)[0]
      if (!item) return
      next.unshift(item)
    } else {
      return
    }

    next.forEach((item, order) => {
      item.style.zIndex = order + 1
    })

    useHistoryStore().executeCommand({
      label: '调整图层',
      execute: () => {
        if (!currentPage.value) return
        currentPage.value.components = clone(next)
        currentComponent.value = currentPage.value.components.find((item) => item.id === componentId) || null
        touchPageMeta()
      },
      undo: () => {
        if (!currentPage.value) return
        currentPage.value.components = clone(before)
        currentComponent.value = currentPage.value.components.find((item) => item.id === componentId) || null
        touchPageMeta()
      }
    })
  }

  const updatePageMeta = (metaUpdates: Partial<PageMeta>) => {
    if (!currentPage.value) return
    currentPage.value.meta = {
      ...currentPage.value.meta,
      ...metaUpdates,
      updatedAt: new Date().toISOString()
    }
    pageRevision.value += 1
  }

  const updatePageStyle = (styleUpdates: Partial<PageData['style']>) => {
    if (!currentPage.value) return
    if (currentDevice.value === DT.DESKTOP) {
      currentPage.value.style = {
        ...currentPage.value.style,
        ...styleUpdates
      }
    } else {
      if (!currentPage.value.responsiveOverrides) currentPage.value.responsiveOverrides = {}
      currentPage.value.responsiveOverrides[DT.MOBILE] = {
        ...currentPage.value.responsiveOverrides[DT.MOBILE],
        ...styleUpdates
      }
    }
    touchPageMeta()
  }

  const exportPageData = () => (currentPage.value ? JSON.stringify(currentPage.value, null, 2) : null)

  const importPageData = (payload: string) => {
    const { page, warnings } = validateAndRepairPageData(JSON.parse(payload) as unknown)
    const parsed = normalizePageData(page)
    currentPage.value = parsed
    currentComponent.value = null
    pageRevision.value = 0
    touchPageMeta()
    return warnings
  }

  /**
   * 将 AI 返回的对象直接导入编辑器。和 JSON 导入共用同一套修复逻辑，
   * 但额外要求结果至少包含一个可渲染组件，避免“接口成功、画布为空”。
   */
  const importGeneratedPage = (payload: unknown) => {
    const { page, warnings } = validateAndRepairPageData(payload)
    const parsed = normalizePageData(page)
    const firstComponent = parsed.components[0]
    if (!firstComponent) {
      throw new Error('AI 返回的页面没有可渲染组件，请补充页面结构后重新生成。')
    }

    currentPage.value = parsed
    currentComponent.value = firstComponent
    pageRevision.value = 0
    touchPageMeta()
    return { warnings, componentCount: parsed.components.length }
  }

  /** 将已在副本中校验通过的 AI Patch 作为单条命令提交，保证一次撤销完整恢复。 */
  const applyAIPagePatchTransaction = (nextPage: PageData, summary: string, baseRevision: number) => {
    if (!currentPage.value) throw new Error('当前没有可修改的页面。')
    if (pageRevision.value !== baseRevision) {
      throw new Error('AI 处理期间页面已发生修改。为避免覆盖手工操作，请重新发送这条要求。')
    }

    const before = clone(currentPage.value)
    const after = normalizePageData(clone(nextPage))
    const selectedId = currentComponent.value?.id
    useHistoryStore().executeCommand({
      label: `AI 修改：${summary}`,
      execute: () => {
        currentPage.value = clone(after)
        currentComponent.value = selectedId
          ? currentPage.value.components.find((item) => item.id === selectedId) || null
          : null
        touchPageMeta()
      },
      undo: () => {
        currentPage.value = clone(before)
        currentComponent.value = selectedId
          ? currentPage.value.components.find((item) => item.id === selectedId) || null
          : null
        touchPageMeta()
      }
    })
  }

  const persistPage = () => {
    if (!currentPage.value) return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPage.value))
    lastSavedAt.value = new Date().toLocaleString('zh-CN')
  }

  const loadPersistedPage = () => {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      createNewPage()
      return
    }

    try {
      currentPage.value = normalizePageData(JSON.parse(raw) as PageData)
      currentComponent.value = null
      pageRevision.value = 0
    } catch {
      createNewPage()
    }
  }

  const nudgeComponent = (componentId: string, deltaX: number, deltaY: number) => {
    if (!currentPage.value) return
    const component = currentPage.value.components.find((item) => item.id === componentId)
    if (!component) return

    if (currentDevice.value === DT.MOBILE) {
      const eff = getEffectiveStyle(component)
      const prevOverrides = clone(component.responsiveOverrides?.mobile || {})
      const width = Math.min(MOBILE_AVAILABLE_WIDTH, Math.max(40, eff.width || MOBILE_AVAILABLE_WIDTH))
      const nextOverrides = {
        ...prevOverrides,
        left: Math.min(MOBILE_AVAILABLE_WIDTH - width + 12, Math.max(12, eff.left + deltaX)),
        top: Math.max(12, eff.top + deltaY)
      }
      commitComponentStyle(componentId, nextOverrides, prevOverrides)
      return
    }

    commitComponentStyle(componentId, {
      ...component.style,
      left: Math.max(0, component.style.left + deltaX),
      top: Math.max(0, component.style.top + deltaY)
    })
  }

  return {
    GRID_SIZE,
    currentPage: computed(() => currentPage.value),
    currentComponent: computed(() => currentComponent.value),
    canvasScale: computed(() => deviceCanvasScales.value[currentDevice.value]),
    snapToGrid: computed(() => snapToGrid.value),
    showGuidelines: computed(() => showGuidelines.value),
    lastSavedAt: computed(() => lastSavedAt.value),
    currentDevice: computed(() => currentDevice.value),
    pageRevision: computed(() => pageRevision.value),
    devicePresets,
    currentDeviceWidth,
    currentDeviceHeight,
    createNewPage,
    loadPersistedPage,
    persistPage,
    addComponent,
    selectComponent,
    commitComponentStyle,
    applyComponentStyle,
    commitComponentProps,
    renameComponent,
    commitComponentEvents,
    deleteComponent,
    moveComponentLayer,
    updatePageMeta,
    updatePageStyle,
    exportPageData,
    importPageData,
    importGeneratedPage,
    applyAIPagePatchTransaction,
    nudgeComponent,
    getEffectiveStyle,
    getEffectivePageStyle,
    setCanvasScale: (scale: number) => {
      deviceCanvasScales.value[currentDevice.value] = scale
      initializedDeviceScales.value[currentDevice.value] = true
    },
    needsCanvasFit: () => !initializedDeviceScales.value[currentDevice.value],
    setSnapToGrid: (enabled: boolean) => (snapToGrid.value = enabled),
    setShowGuidelines: (enabled: boolean) => (showGuidelines.value = enabled),
    setDevice: (device: DeviceType) => { currentDevice.value = device },
  }
})
