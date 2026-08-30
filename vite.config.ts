import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import {
  compactStructuredValue,
  layoutPlanSchema,
  pageDataSchema,
  strictResponseFormat
} from './server/structuredSchemas'
import { estimateTextHeight } from './src/utils/textLayout'
import { getFormMinimumHeight } from './src/utils/formLayout'
import { createEditPageHandler } from './server/ai/http/editPageHandler'

const DEFAULT_PLANNED_FORM_MIN_HEIGHT = getFormMinimumHeight({ fields: [{}, {}, {}] })

type GeneratedPage = { id?: unknown; meta?: unknown; style?: unknown; responsiveOverrides?: unknown; components?: unknown }

type LayoutPlan = {
  concept?: unknown
  palette?: unknown
  layout?: unknown
  mobile?: unknown
  sections?: unknown
  components?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const containsModelProtocolArtifact = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return /<\/?(?:tool_response|tool_call|assistant|system|user)\b|<\|im_(?:start|end)\|>/i.test(value)
  }
  if (Array.isArray(value)) return value.some(containsModelProtocolArtifact)
  return isRecord(value) && Object.values(value).some(containsModelProtocolArtifact)
}

/** 先修正规划阶段最容易违反的硬约束，避免错误计划污染第二阶段。 */
const normalizeLayoutPlan = (plan: LayoutPlan) => {
  if (!Array.isArray(plan.components)) return plan
  for (const item of plan.components) {
    if (!isRecord(item) || item.type !== 'Form' || !isRecord(item.bounds)) continue
    const bounds = item.bounds
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) continue
    const width = Math.min(1120, Math.max(320, Number(bounds.width) || 360))
    const height = Math.min(740, Math.max(DEFAULT_PLANNED_FORM_MIN_HEIGHT, Number(bounds.height) || DEFAULT_PLANNED_FORM_MIN_HEIGHT))
    bounds.width = width
    bounds.height = height
    bounds.left = Math.min(1160 - width, Math.max(40, Number(bounds.left)))
    bounds.top = Math.min(780 - height, Math.max(40, Number(bounds.top)))
  }

  // 规划结果也必须先通过与最终 Schema 相同的桌面排布规则。
  // 否则第二阶段会被“必须遵循计划”锁死在一个本身就冲突的矩形方案中。
  const proxies = plan.components.flatMap((item, index) => {
    if (!isRecord(item) || !isRecord(item.bounds)) return []
    const bounds = item.bounds
    if (!['left', 'top', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) return []
    return [{
      id: `plan-${index}`,
      type: String(item.type || 'Text'),
      name: String(item.role || ''),
      planIndex: index,
      style: {
        left: Number(bounds.left),
        top: Number(bounds.top),
        width: Number(bounds.width),
        height: Number(bounds.height),
        zIndex: index + 1,
        rotate: 0,
        opacity: 1
      }
    }]
  })
  normalizeContentLayout({ components: proxies })
  for (const proxy of proxies) {
    const item = plan.components[Number(proxy.planIndex)]
    if (!isRecord(item) || !isRecord(item.bounds)) continue
    item.bounds.left = proxy.style.left
    item.bounds.top = proxy.style.top
    item.bounds.width = proxy.style.width
    item.bounds.height = proxy.style.height
  }
  return plan
}

const isDecorativeImage = (
  component: Record<string, unknown>,
  style: Record<string, unknown>
) => {
  if (component.type !== 'Image' || !Number.isFinite(style.zIndex)) return false
  const identity = `${String(component.id || '')} ${String(component.name || '')}`.toLowerCase()
  const hasDecorativeHint = /(^|[-_\s])(bg|background|deco|decorative)([-_\s]|$)|背景|装饰/.test(identity)
  return Number(style.rotate) !== 0 || hasDecorativeHint || Number(style.opacity) <= 0.45
}

const basicPageError = (page: GeneratedPage): string | null => {
  if (!page || typeof page !== 'object') return '模型未返回页面对象。'
  const pageStyle = page.style as Record<string, unknown> | undefined
  if (!pageStyle || pageStyle.width !== 1200 || pageStyle.height !== 820) return '页面尺寸必须严格为 1200x820。'
  if (!Array.isArray(page.components) || page.components.length === 0) return '页面缺少可编辑组件。'
  if (page.components.length > 12) return '页面组件数量超过 12 个。'
  const rectangles: Array<{ id: string; zIndex: number; decorative: boolean; left: number; top: number; right: number; bottom: number }> = []
  for (const item of page.components) {
    const component = item as Record<string, unknown>
    const style = component.style as Record<string, unknown> | undefined
    if (!['Text', 'Image', 'Button', 'Input', 'Form', 'Chart'].includes(String(component.type))
      || !style || !['top', 'left', 'width', 'height', 'zIndex', 'rotate', 'opacity'].every((key) => Number.isFinite(style[key]))) {
      return '组件类型或布局字段不符合页面协议。'
    }
    const left = style.left as number
    const top = style.top as number
    const width = style.width as number
    const height = style.height as number
    const opacity = style.opacity as number
    if (width <= 0 || height <= 0 || opacity <= 0 || opacity > 1) return `组件 ${String(component.id)} 的尺寸或透明度无效。`
    const formMinimumHeight = component.type === 'Form' ? getFormMinimumHeight(component.props) : 0
    if (component.type === 'Form' && (width < 320 || height < formMinimumHeight)) {
      return `表单组件 ${String(component.id)} 当前字段数量要求尺寸至少为 320x${formMinimumHeight}，避免导入后自动扩展并破坏布局。`
    }
    const decorative = isDecorativeImage(component, style)
    // 内容组件保留 40px 安全边距；受控的底层装饰图可延伸至实际画布边缘。
    const minX = decorative ? 0 : 40
    const minY = decorative ? 0 : 40
    const maxX = decorative ? 1200 : 1160
    const maxY = decorative ? 820 : 780
    if (left < minX || top < minY || left + width > maxX || top + height > maxY) {
      return decorative
        ? `装饰图片 ${String(component.id)} 超出 1200x820 画布边界。`
        : `组件 ${String(component.id)} 超出 1200x820 画布安全区域。`
    }
    rectangles.push({
      id: String(component.id),
      zIndex: style.zIndex as number,
      decorative,
      left,
      top,
      right: left + width,
      bottom: top + height
    })
  }

  // 常规内容需保留间距；受控的低层装饰图可以与上层内容产生视觉重叠。
  for (let index = 0; index < rectangles.length; index += 1) {
    const first = rectangles[index]
    for (const second of rectangles.slice(index + 1)) {
      const conflict = first.left < second.right + 16
        && first.right + 16 > second.left
        && first.top < second.bottom + 16
        && first.bottom + 16 > second.top
      const firstIsDecoration = first.decorative && first.zIndex < second.zIndex
      const secondIsDecoration = second.decorative && second.zIndex < first.zIndex
      if (conflict && !firstIsDecoration && !secondIsDecoration) {
        return `组件 ${first.id} 与 ${second.id} 重叠或间距不足 16px。`
      }
    }
  }
  return mobilePageError(page)
}

/**
 * 装饰图越界不会影响页面数据的可编辑性，导入前将其原始矩形收进画布。
 * 旋转和 zIndex 保持不变，因此仍可呈现背景图或倾斜图片位于内容下方的视觉层次。
 */
const normalizeDecorativeImages = (page: GeneratedPage) => {
  if (!Array.isArray(page.components)) return page
  for (const item of page.components) {
    const component = item as Record<string, unknown>
    const style = component.style as Record<string, unknown> | undefined
    if (!style || !isDecorativeImage(component, style)) continue
    if (!Number.isFinite(style.left) || !Number.isFinite(style.top) || !Number.isFinite(style.width) || !Number.isFinite(style.height)) continue

    const width = Math.min(1200, Math.max(1, Number(style.width)))
    const height = Math.min(820, Math.max(1, Number(style.height)))
    style.width = width
    style.height = height
    style.left = Math.min(1200 - width, Math.max(0, Number(style.left)))
    style.top = Math.min(820 - height, Math.max(0, Number(style.top)))
  }
  // 编辑器会按数组顺序重新编号 zIndex，因此先按模型规划的层级排序，避免装饰图导入后盖住正文。
  page.components.sort((first, second) => {
    const firstZIndex = Number((first as Record<string, unknown>).style && ((first as Record<string, unknown>).style as Record<string, unknown>).zIndex) || 0
    const secondZIndex = Number((second as Record<string, unknown>).style && ((second as Record<string, unknown>).style as Record<string, unknown>).zIndex) || 0
    return firstZIndex - secondZIndex
  })
  return page
}

/**
 * 表单在编辑器导入时本就会扩展到最小尺寸，因此在服务端提前做同样的安全修复，
 * 再交给统一的边界/重叠校验，避免为可恢复的尺寸问题浪费整轮模型重试。
 */
const normalizeForms = (page: GeneratedPage) => {
  if (!Array.isArray(page.components)) return page
  for (const item of page.components) {
    const component = item as Record<string, unknown>
    const style = component.style as Record<string, unknown> | undefined
    if (component.type !== 'Form' || !style) continue
    if (!Number.isFinite(style.left) || !Number.isFinite(style.top)) continue
    const width = Math.min(1120, Math.max(320, Number(style.width) || 360))
    const minimumHeight = getFormMinimumHeight(component.props)
    const height = Math.min(740, Math.max(minimumHeight, Number(style.height) || minimumHeight))
    style.width = width
    style.height = height
    style.left = Math.min(1160 - width, Math.max(40, Number(style.left)))
    style.top = Math.min(780 - height, Math.max(40, Number(style.top)))
  }
  return page
}

type GeometryRect = { left: number; top: number; width: number; height: number }

const overlapsWithGap = (first: GeometryRect, second: GeometryRect, gap = 16) => (
  first.left < second.left + second.width + gap
  && first.left + first.width + gap > second.left
  && first.top < second.top + second.height + gap
  && first.top + first.height + gap > second.top
)

/**
 * 把普通组件移动到距离原位置最近的合法空位。AI 仍负责视觉设计，
 * 这里仅修复边界和矩形碰撞，避免为几像素间距反复请求模型。
 */
function normalizeContentLayout(page: GeneratedPage) {
  if (!Array.isArray(page.components)) return page
  const content = page.components.flatMap((item) => {
    const component = item as Record<string, unknown>
    const style = component.style as Record<string, unknown> | undefined
    if (!style || isDecorativeImage(component, style)) return []
    if (!['left', 'top', 'width', 'height'].every((key) => Number.isFinite(style[key]))) return []
    return [{ component, style }]
  })

  // 表单扩展对周边布局影响最大，先固定表单，再对其他组件做最小位移。
  content.sort((first, second) => Number(second.component.type === 'Form') - Number(first.component.type === 'Form'))
  const placed: GeometryRect[] = []
  const snap = (value: number) => Math.round(value / 8) * 8

  const sizeVariants = (component: Record<string, unknown>, rawWidth: number, rawHeight: number) => {
    const type = String(component.type)
    const limits: Record<string, { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number; scaleHeight: boolean }> = {
      Text: { minWidth: 240, maxWidth: 720, minHeight: 48, maxHeight: 180, scaleHeight: false },
      Image: { minWidth: 280, maxWidth: 720, minHeight: 180, maxHeight: 460, scaleHeight: true },
      Button: { minWidth: 144, maxWidth: 360, minHeight: 44, maxHeight: 64, scaleHeight: false },
      Input: { minWidth: 240, maxWidth: 440, minHeight: 44, maxHeight: 64, scaleHeight: false },
      Form: { minWidth: 320, maxWidth: 440, minHeight: getFormMinimumHeight(component.props), maxHeight: 740, scaleHeight: true },
      Chart: { minWidth: 320, maxWidth: 640, minHeight: 240, maxHeight: 360, scaleHeight: true }
    }
    const limit = limits[type] || { minWidth: 80, maxWidth: 720, minHeight: 40, maxHeight: 460, scaleHeight: true }
    const originalWidth = Math.min(1120, Math.max(limit.minWidth, rawWidth))
    const props = isRecord(component.props) ? component.props : {}
    const textHeight = type === 'Text'
      ? estimateTextHeight(props.content, rawWidth, Number((component.style as Record<string, unknown>)?.fontSize) || 14, Number((component.style as Record<string, unknown>)?.lineHeight) || 1.5)
      : 0
    const originalHeight = Math.min(740, Math.max(limit.minHeight, rawHeight, textHeight))
    const boundedWidth = Math.min(limit.maxWidth, originalWidth)
    const boundedHeight = Math.min(limit.maxHeight, originalHeight)
    const variants: Array<{ width: number; height: number }> = []
    const add = (width: number, height: number) => {
      const candidate = {
        width: Math.min(1120, Math.max(limit.minWidth, snap(width))),
        height: Math.min(740, Math.max(limit.minHeight, snap(height)))
      }
      if (!variants.some((item) => item.width === candidate.width && item.height === candidate.height)) variants.push(candidate)
    }

    // 先尝试忠实保留模型尺寸；确实放不下时才按组件语义逐级收敛。
    add(originalWidth, originalHeight)
    add(boundedWidth, boundedHeight)
    for (const scale of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      add(
        boundedWidth * scale,
        limit.scaleHeight ? boundedHeight * scale : boundedHeight
      )
    }
    return variants
  }

  for (const { component, style } of content) {
    const fits = (candidate: GeometryRect) => !placed.some((other) => overlapsWithGap(candidate, other))
    const findNearestPlacement = (width: number, height: number): GeometryRect | null => {
      const maxLeft = 1160 - width
      const maxTop = 780 - height
      if (maxLeft < 40 || maxTop < 40) return null
      const original = {
        left: Math.min(maxLeft, Math.max(40, Number(style.left))),
        top: Math.min(maxTop, Math.max(40, Number(style.top))),
        width,
        height
      }
      if (fits(original)) return original

      const clampLeft = (value: number) => Math.min(maxLeft, Math.max(40, snap(value)))
      const clampTop = (value: number) => Math.min(maxTop, Math.max(40, snap(value)))
      const xValues = new Set<number>([40, maxLeft, original.left])
      const yValues = new Set<number>([40, maxTop, original.top])
      for (const other of placed) {
        xValues.add(other.left + other.width + 16)
        xValues.add(other.left - width - 16)
        yValues.add(other.top + other.height + 16)
        yValues.add(other.top - height - 16)
      }
      const candidates: GeometryRect[] = []
      for (const rawLeft of xValues) {
        for (const rawTop of yValues) {
          const candidate = {
            left: clampLeft(rawLeft),
            top: clampTop(rawTop),
            width,
            height
          }
          if (fits(candidate)) candidates.push(candidate)
        }
      }
      candidates.sort((first, second) => {
        const firstDistance = (first.left - original.left) ** 2 + (first.top - original.top) ** 2
        const secondDistance = (second.left - original.left) ** 2 + (second.top - original.top) ** 2
        return firstDistance - secondDistance
      })
      if (candidates[0]) return candidates[0]

      // 边缘候选无解时，用 16px 网格寻找距离模型原位置最近的空位。
      let selected: GeometryRect | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (let top = 40; top <= maxTop; top += 16) {
        for (let left = 40; left <= maxLeft; left += 16) {
          const candidate = { left, top, width, height }
          if (!fits(candidate)) continue
          const distance = (left - original.left) ** 2 + (top - original.top) ** 2
          if (distance < bestDistance) {
            selected = candidate
            bestDistance = distance
          }
        }
      }
      return selected
    }

    let resolved: GeometryRect | null = null
    const variants = sizeVariants(component, Number(style.width), Number(style.height))
    for (const variant of variants) {
      resolved = findNearestPlacement(variant.width, variant.height)
      if (resolved) break
    }

    // 只有连语义最小尺寸也无解时才保留安全区内原矩形，让校验器反馈模型重排。
    const fallback = variants[variants.length - 1]
    resolved ||= {
      left: Math.min(1160 - fallback.width, Math.max(40, Number(style.left))),
      top: Math.min(780 - fallback.height, Math.max(40, Number(style.top))),
      width: fallback.width,
      height: fallback.height
    }
    style.left = resolved.left
    style.top = resolved.top
    style.width = resolved.width
    style.height = resolved.height
    placed.push(resolved)
  }
  return page
}

const getMobileComponentHeight = (
  component: Record<string, unknown>,
  style: Record<string, unknown>,
  mobile: Record<string, unknown>
) => {
  const requested = Number.isFinite(mobile.height) ? Number(mobile.height) : 0
  const type = String(component.type)
  if (type === 'Form') {
    const minimumHeight = getFormMinimumHeight(component.props)
    return Math.max(minimumHeight, requested || minimumHeight)
  }
  if (type === 'Chart') return Math.min(340, Math.max(240, requested || 280))
  if (type === 'Image') return Math.min(300, Math.max(180, requested || 220))
  if (type === 'Button') return Math.min(64, Math.max(44, requested || 52))
  if (type === 'Input') return Math.min(60, Math.max(44, requested || 48))
  if (type === 'Text') {
    const props = isRecord(component.props) ? component.props : {}
    const fontSize = Number(mobile.fontSize) || Number(style.fontSize) || 16
    const lineHeight = Number(mobile.lineHeight) || Number(style.lineHeight) || 1.5
    const required = estimateTextHeight(props.content, Number(mobile.width) || 351, fontSize, lineHeight)
    return Math.max(48, requested, required)
  }
  const isTitle = Number(style.fontSize) >= 28 || /title|heading|标题|主标题/.test(`${String(component.id || '')} ${String(component.name || '')}`.toLowerCase())
  return Math.min(160, Math.max(48, requested || (isTitle ? 88 : 72)))
}

/**
 * 为每个 AI 组件补齐并规范化 375px 手机端差量样式。
 * 默认采用单列纵向信息流；保留模型给出的字体等视觉覆盖，但不允许越界或互相遮挡。
 */
const normalizeMobileLayout = (page: GeneratedPage) => {
  if (!Array.isArray(page.components)) return page
  const MOBILE_WIDTH = 375
  const MOBILE_PADDING = 12
  const MOBILE_CONTENT_WIDTH = MOBILE_WIDTH - MOBILE_PADDING * 2
  const MOBILE_GAP = 20

  const content: Array<{
    component: Record<string, unknown>
    style: Record<string, unknown>
    mobile: Record<string, unknown>
    hasPlannedTop: boolean
  }> = []

  for (const item of page.components) {
    const component = item as Record<string, unknown>
    const style = component.style as Record<string, unknown> | undefined
    if (!style) continue
    const responsive = isRecord(component.responsiveOverrides) ? component.responsiveOverrides : {}
    const existingMobile = isRecord(responsive.mobile) ? responsive.mobile : {}
    const mobile = { ...existingMobile }
    responsive.mobile = mobile
    component.responsiveOverrides = responsive

    if (isDecorativeImage(component, style)) {
      mobile.left = MOBILE_PADDING
      mobile.top = MOBILE_PADDING
      mobile.width = MOBILE_CONTENT_WIDTH
      mobile.height = Math.min(300, Math.max(180, Number(mobile.height) || 240))
      mobile.rotate = 0
      mobile.opacity = Math.min(0.22, Math.max(0.08, Number(mobile.opacity) || Number(style.opacity) || 0.16))
      continue
    }

    content.push({
      component,
      style,
      mobile,
      hasPlannedTop: Number.isFinite(existingMobile.top)
    })
  }

  content.sort((first, second) => {
    const firstTop = first.hasPlannedTop ? Number(first.mobile.top) : Number(first.style.top)
    const secondTop = second.hasPlannedTop ? Number(second.mobile.top) : Number(second.style.top)
    return firstTop - secondTop
  })

  let cursor = MOBILE_PADDING
  for (const { component, style, mobile, hasPlannedTop } of content) {
    const height = getMobileComponentHeight(component, style, mobile)
    const requestedTop = hasPlannedTop ? Math.max(MOBILE_PADDING, Number(mobile.top)) : cursor
    // 尊重模型顺序，但将额外留白限制在 32px 内，避免直接复用桌面 top 造成手机端大空洞。
    const top = Math.max(cursor, Math.min(requestedTop, cursor + 32))
    mobile.left = MOBILE_PADDING
    mobile.top = top
    mobile.width = MOBILE_CONTENT_WIDTH
    mobile.height = height
    mobile.rotate = 0

    if (component.type === 'Text') {
      const desktopFontSize = Number(style.fontSize) || 16
      mobile.fontSize = desktopFontSize >= 28
        ? Math.min(32, Math.max(26, Number(mobile.fontSize) || desktopFontSize * 0.78))
        : Math.min(18, Math.max(15, Number(mobile.fontSize) || desktopFontSize))
      mobile.lineHeight = Number(mobile.lineHeight) || (desktopFontSize >= 28 ? 1.25 : 1.55)
    }
    cursor = top + height + MOBILE_GAP
  }

  const mobilePageHeight = Math.max(812, Math.ceil((cursor - MOBILE_GAP + MOBILE_PADDING) / 8) * 8)
  const pageResponsive = isRecord(page.responsiveOverrides) ? page.responsiveOverrides : {}
  const existingPageMobile = isRecord(pageResponsive.mobile) ? pageResponsive.mobile : {}
  pageResponsive.mobile = {
    ...existingPageMobile,
    width: MOBILE_WIDTH,
    height: mobilePageHeight
  }
  page.responsiveOverrides = pageResponsive
  return page
}

const mobilePageError = (page: GeneratedPage): string | null => {
  const pageResponsive = isRecord(page.responsiveOverrides) ? page.responsiveOverrides : null
  const mobilePage = pageResponsive && isRecord(pageResponsive.mobile) ? pageResponsive.mobile : null
  if (!mobilePage || mobilePage.width !== 375 || !Number.isFinite(mobilePage.height) || Number(mobilePage.height) < 812) {
    return '手机端页面必须提供 375px 宽且高度不少于 812px 的 responsiveOverrides.mobile。'
  }
  if (!Array.isArray(page.components)) return '手机端缺少组件列表。'

  const rectangles: Array<GeometryRect & { id: string }> = []
  for (const item of page.components) {
    const component = item as Record<string, unknown>
    const style = isRecord(component.style) ? component.style : {}
    if (isDecorativeImage(component, style)) continue
    const responsive = isRecord(component.responsiveOverrides) ? component.responsiveOverrides : null
    const mobile = responsive && isRecord(responsive.mobile) ? responsive.mobile : null
    if (!mobile || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(mobile[key]))) {
      return `组件 ${String(component.id)} 缺少有效的手机端布局。`
    }
    const rect = {
      id: String(component.id),
      left: Number(mobile.left),
      top: Number(mobile.top),
      width: Number(mobile.width),
      height: Number(mobile.height)
    }
    if (rect.left < 12 || rect.left + rect.width > 363 || rect.top < 12 || rect.top + rect.height > Number(mobilePage.height) - 12) {
      return `组件 ${rect.id} 超出手机端页面边界。`
    }
    const formMinimumHeight = component.type === 'Form' ? getFormMinimumHeight(component.props) : 0
    if (component.type === 'Form' && rect.height < formMinimumHeight) {
      return `表单组件 ${rect.id} 当前字段数量要求手机端高度至少为 ${formMinimumHeight}px。`
    }
    const conflict = rectangles.find((other) => overlapsWithGap(rect, other, 16))
    if (conflict) return `手机端组件 ${conflict.id} 与 ${rect.id} 重叠或间距不足 16px。`
    rectangles.push(rect)
  }
  return null
}

/** 逐块接收 OpenRouter 的 SSE 输出，避免等待整个长 JSON 完成才得到响应。 */
const collectStreamContent = async (
  response: Response,
  onFirstActivity: () => void,
  onFirstContent: () => void,
  onActivity: () => void
) => {
  if (!response.body) throw new Error('OpenRouter 未返回可读取的数据流。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let hasActivity = false
  let hasContent = false

  const consume = (block: string) => {
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
    const data = dataLine?.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
      const delta = payload.choices?.[0]?.delta?.content
      if (typeof delta !== 'string' || !delta) return
      content += delta
      if (!hasContent) {
        hasContent = true
        onFirstContent()
      }
    } catch {
      // 忽略 OpenRouter 可能发送的非 JSON keep-alive 数据块。
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      onActivity()
      if (!hasActivity) {
        hasActivity = true
        onFirstActivity()
      }
    }
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() || ''
    blocks.forEach(consume)
    if (done) break
  }
  if (buffer.trim()) consume(buffer)
  return content
}

/**
 * 第一阶段只生成紧凑的布局计划。限制 token 和总时长，规划失败时返回 null，
 * 第二阶段会自动使用内置设计规则继续生成，避免额外请求拖垮整体体验。
 */
const linkAbortSignal = (controller: AbortController, signal?: AbortSignal) => {
  if (!signal) return () => undefined
  const abort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

const createLayoutPlan = async (
  env: Record<string, string>,
  prompt: string,
  clientSignal?: AbortSignal
): Promise<LayoutPlan | null> => {
  const controller = new AbortController()
  const unlinkAbort = linkAbortSignal(controller, clientSignal)
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const system = `你是低代码页面的资深响应式 UI 布局规划师。只输出一个精简 JSON 布局计划，不生成最终页面，不要 Markdown。需要同时规划桌面 1200x820 和手机 375px 单列滚动页面；桌面安全边距 40px，手机左右边距 12px，使用 8px 网格。

计划格式：{"concept":"一句视觉方向","palette":{"background":"#hex","surface":"#hex","primary":"#hex","text":"#hex","muted":"#hex"},"layout":"桌面布局名称","mobile":{"strategy":"single-column","gap":20,"order":["组件 role，按手机阅读顺序"]},"sections":[{"role":"区域作用","bounds":{"left":数字,"top":数字,"width":数字,"height":数字}}],"components":[{"type":"Text|Image|Button|Input|Form|Chart","role":"用途","section":"区域作用","bounds":{"left":数字,"top":数字,"width":数字,"height":数字},"mobileOrder":1,"mobileHeight":数字,"priority":1}]}

桌面规则：规划 4~6 个核心组件并给出最终精确矩形；建立清晰的主标题、说明、视觉主体和转化区层级；区域之间至少 24px 留白；所有常规组件矩形不得重叠且间距至少 16px。任意两个常规组件必须满足“左右至少相隔 16px”或“上下至少相隔 16px”中的一项，不能只凭视觉估计。Form 是完整表单卡片，宽度建议 360~440；高度由字段数量决定，约为 126 + 字段数 × 74px，不能按固定 420px 或单行输入框高度规划，且 top + height <= 780。如果页面同时有主视觉 Image 和 Form，优先使用明确的左右双栏：左栏 x=40、宽不超过 640，右栏从 x>=704 开始，Form 宽不超过 440；主视觉不得伸入表单栏。组件 bounds 是最终矩形，不要让多个组件共用同一 section 的完整 bounds。

手机规则：按用户阅读顺序规划 mobile.order；普通组件统一使用 351px 内容宽度并纵向排列，间距 20px；主标题建议高 80~112，图片 180~260，按钮 48~56，图表 260~320；Form 高度同样按字段数量计算，约为 126 + 字段数 × 74px。手机页面允许纵向滚动，不要把桌面坐标等比缩小或让组件并排。选择克制协调的配色。若使用全画布背景装饰图，role 必须明确包含“背景装饰”，并将其 priority 设为最低。JSON 尽量短。`

  try {
    const response = await fetch(`${env.AI_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_PLANNING_MODEL || env.AI_MODEL || 'qwen/qwen3.7-plus',
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        reasoning: { enabled: false },
        response_format: strictResponseFormat('page_layout_plan', layoutPlanSchema),
        temperature: 0.15,
        max_tokens: 650
      }),
      signal: controller.signal
    })
    if (!response.ok) return null
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = result.choices?.[0]?.message?.content
    if (!content) return null
    const plan = compactStructuredValue(JSON.parse(content)) as LayoutPlan
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.sections) || !Array.isArray(plan.components)) return null
    return normalizeLayoutPlan(plan)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    unlinkAbort()
  }
}

const aiPageGeneratorV2 = (): Plugin => ({
  name: 'ai-page-generator-v2',
  configureServer(server) {
    const env = loadEnv(server.config.mode, process.cwd(), '')
    server.middlewares.use('/api/ai/edit-page', createEditPageHandler({ env }))
    server.middlewares.use('/api/ai/generate-page', async (req, res) => {
      const clientController = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) clientController.abort()
      })
      const reply = (status: number, payload: Record<string, unknown>) => {
        if (res.destroyed || res.writableEnded) return
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      }
      if (req.method !== 'POST') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST 请求。' })
      if (!env.OPENROUTER_API_KEY) return reply(503, { code: 'KEY_NOT_CONFIGURED', message: '未检测到 OPENROUTER_API_KEY。请检查 .env.local 并重启 npm run dev。' })

      try {
        const raw = await new Promise<string>((resolve, reject) => {
          let data = ''
          req.on('data', (chunk) => { data += String(chunk) })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })
        const { prompt } = JSON.parse(raw) as { prompt?: unknown }
        if (typeof prompt !== 'string' || !prompt.trim()) return reply(400, { code: 'EMPTY_PROMPT', message: '请先输入页面需求后再生成。' })

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()
        const send = (payload: Record<string, unknown>) => {
          if (res.destroyed || res.writableEnded || clientController.signal.aborted) return false
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          return true
        }

        const system = `你是资深响应式 UI 设计师和低代码页面生成器。根据已批准的布局计划生成一个桌面与手机端都美观、可编辑的页面 JSON，只输出 JSON，不要 Markdown 或解释。根对象为 {id,meta,style,responsiveOverrides,components}；meta 含 title,description,createdAt,updatedAt,version:"2026.05",scene；桌面 style 固定 {width:1200,height:820,backgroundColor}；页面 responsiveOverrides.mobile 必须含 {width:375,height:手机页面完整高度,backgroundColor}。可用类型：Text、Image、Button、Input、Form、Chart，生成 4~6 个核心组件。

每个组件必须含 id,type,name,schemaVersion:"2026.05",style,responsiveOverrides,props,events。style 是桌面样式，必含 top,left,width,height,zIndex,rotate,opacity。responsiveOverrides.mobile 至少含 top,left,width,height,zIndex,rotate,opacity。Structured Output Schema 中当前组件不需要的可空视觉字段、backgroundImage 及事件扩展字段统一输出 null，应用会在校验前移除；不得用空字符串或 0 冒充缺省值。Text.props.content；Button.props.content,type；Input.props.placeholder,value,inputType；Image.props.src,alt,objectFit；Form.props.title,submitText,fields；Chart.props 含 chartType,title,data,showLegend,legendPosition,showXAxis,showYAxis,xAxisName,yAxisName,valueUnit,primaryColor,secondaryColor,accentColor,tooltipFormat；events 为 [{type:"click",config:{action:"none",url:null,message:null,newTab:null}}]。

视觉：严格执行布局计划的分区和配色；使用 8px 网格、统一对齐线、24~48px 区域留白和明确的标题/正文/CTA 层级；避免所有组件同尺寸、随机颜色和无意义旋转。标题建议 36~48px、正文 15~18px，按钮高度 44~56px，卡片使用轻边框或柔和背景。Text 的桌面和手机高度必须分别按 content、width、fontSize、lineHeight 的真实换行行数计算并留出内边距，严禁文字被固定高度裁切。文案简洁且贴合需求。需要图片时使用可访问的 https://picsum.photos/seed/<英文关键词>/800/600 地址。

桌面硬约束（优先级高于布局计划）：常规内容在 1200x820 画布的安全区域 left 40~1160、top 40~780 内，彼此不重叠且间距至少 16。布局计划中的组件 bounds 已经过应用侧安全规范化，应直接作为对应组件 style 的 top/left/width/height，不要擅自放大或让组件占满所在 section。Form 是完整表单卡片，不是单行输入框：宽度必须 >= 320；最小高度按字段数量计算，0 个字段约 140px，1 个约 200px，2 个约 276px，3 个约 348px，每增加一个字段约增加 74px；放置后仍须满足 top + height <= 780。如果同时生成主视觉 Image 与 Form，使用互不侵入的左右双栏，并确保 image.left + image.width + 16 <= form.left（或反向关系）。若布局计划中的任何矩形违反这些硬约束，必须主动调整该矩形及相邻组件。Image 可作为受控的最低层装饰与内容重叠：旋转装饰图，或 id/name 明确含 bg、background、deco、背景、装饰的背景图；其 zIndex 必须为 0 或 1。其他 Image 仍是普通内容。components 数组必须按 zIndex 从小到大排列。

手机硬约束：手机不是桌面缩小版。按布局计划的 mobile.order 和“标题→说明/视觉→筛选或表单→结果/CTA”的阅读顺序，把普通组件排成单列；每个普通组件 left:12,width:351,rotate:0，纵向间距至少 20px。主标题 fontSize 26~32，正文 15~18；Image 高 180~300；Button 高 44~64；Chart 高 240~340；Form 最小高度同样按字段数计算（0/1/2/3 个字段约为 140/200/276/348px）。页面 responsiveOverrides.mobile.height 必须覆盖最后一个组件底部并额外留 12px，允许大于 812 形成自然滚动页。不要复用桌面 top/left，不要在手机端并排放置大组件。输出前同时检查桌面和手机的边界、间距、Form 尺寸和阅读顺序。

输出骨架：{"id":"page-1","meta":{"title":"页面标题","description":"","createdAt":"ISO 时间","updatedAt":"ISO 时间","version":"2026.05","scene":"landing"},"style":{"width":1200,"height":820,"backgroundColor":"#fff"},"responsiveOverrides":{"mobile":{"width":375,"height":1000,"backgroundColor":"#fff"}},"components":[{"id":"comp-title","type":"Text","style":{"top":40,"left":40,"width":500,"height":96,"zIndex":2,"rotate":0,"opacity":1},"responsiveOverrides":{"mobile":{"top":12,"left":12,"width":351,"height":88,"rotate":0,"fontSize":30}},"props":{"content":"页面标题"},"events":[{"type":"click","config":{"action":"none"}}],"name":"主标题","schemaVersion":"2026.05"}]}`
        let lastError = ''
        send({ type: 'progress', stage: 'planning', message: '第一阶段：正在规划页面分区、视觉层级与配色…' })
        const layoutPlan = await createLayoutPlan(env, prompt.trim(), clientController.signal)
        if (clientController.signal.aborted) return
        if (layoutPlan) {
          send({ type: 'progress', stage: 'planned', message: '布局计划已完成，正在生成可编辑组件…' })
        } else {
          send({ type: 'progress', stage: 'planning-fallback', message: '规划阶段响应较慢，已切换快速布局策略继续生成…' })
        }
        const planContext = layoutPlan
          ? `\n已批准的布局计划（必须遵循）：${JSON.stringify(layoutPlan)}`
          : '\n规划服务未及时返回，请使用系统中的桌面 8px 网格规则，并为手机端生成 375px 单列纵向布局。'
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (clientController.signal.aborted) return
          const correction = `${prompt.trim()}${planContext}${lastError ? `\n上一次生成结果无效：${lastError}。请保留视觉方向和内容结构，但必须修改违反桌面或手机硬约束的组件矩形及相邻布局，重新生成完整页面 JSON。` : ''}`
          send({ type: 'progress', stage: 'requesting', attempt, message: `第二阶段：正在生成页面 Schema（第 ${attempt}/3 次尝试）…` })
          let upstream: Response
          let data: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string } = {}
          let args = ''
          try {
            const controller = new AbortController()
            const unlinkAbort = linkAbortSignal(controller, clientController.signal)
            let timeout: ReturnType<typeof setTimeout> | undefined
            const resetIdleTimeout = () => {
              if (timeout) clearTimeout(timeout)
              // 首包或任一输出块连续 45 秒未到达时才判定连接已失活。
              timeout = setTimeout(() => controller.abort(), 45_000)
            }
            resetIdleTimeout()
            try {
              upstream = await fetch(`${env.AI_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: env.AI_MODEL || 'qwen/qwen3.7-plus',
                  messages: [{ role: 'system', content: system }, { role: 'user', content: correction }],
                  // 生成页面只需遵循 Schema；推理模式会让该模型长时间不返回最终 JSON。
                  reasoning: { enabled: false },
                  response_format: strictResponseFormat('page_data', pageDataSchema),
                  temperature: 0.2,
                  max_tokens: 3800,
                  stream: true
                }),
                signal: controller.signal
              })
              if (upstream.ok) {
                args = await collectStreamContent(
                  upstream,
                  () => send({ type: 'progress', stage: 'processing', attempt, message: 'Qwen 已响应，正在生成页面结构…' }),
                  () => send({ type: 'progress', stage: 'streaming', attempt, message: 'Qwen 已开始返回页面结构，正在接收并校验 JSON…' }),
                  resetIdleTimeout
                )
              } else {
                data = await upstream.json() as typeof data
              }
            } finally {
              clearTimeout(timeout)
              unlinkAbort()
            }
          } catch (error) {
            if (clientController.signal.aborted) return
            lastError = error instanceof Error && error.name === 'AbortError' ? 'Qwen 连续 45 秒未返回响应数据。' : `无法连接 OpenRouter：${error instanceof Error ? error.message : '未知网络错误'}。`
            if (attempt < 3) {
              send({ type: 'progress', stage: 'retrying', attempt, message: `${lastError} 正在重试（下一次为第 ${attempt + 1}/3 次）…` })
              continue
            }
            send({ type: 'error', code: 'OPENROUTER_CONNECTION_FAILED', message: `页面生成失败：${lastError}` })
            return res.end()
          }
          if (!upstream.ok) {
            lastError = `OpenRouter 请求被拒绝（${upstream.status}）：${data.error?.message || data.message || '未知错误'}`
            if (upstream.status === 401 || upstream.status === 403) {
              send({ type: 'error', code: 'OPENROUTER_REJECTED', message: `${lastError}，请检查 API Key。` })
              return res.end()
            }
            if (attempt < 3) {
              send({ type: 'progress', stage: 'retrying', attempt, message: `${lastError} 正在重试（下一次为第 ${attempt + 1}/3 次）…` })
              continue
            }
            send({ type: 'error', code: 'OPENROUTER_REJECTED', message: `页面生成失败：${lastError}` })
            return res.end()
          }
          if (!args) {
            lastError = '模型未返回 JSON 内容。'
          } else {
            try {
              const structuredPage = compactStructuredValue(JSON.parse(args)) as GeneratedPage
              if (containsModelProtocolArtifact(structuredPage)) {
                lastError = '页面文案混入了模型协议标记，必须只保留用户可见内容。'
                continue
              }
              const page = normalizeMobileLayout(normalizeContentLayout(normalizeForms(normalizeDecorativeImages(structuredPage))))
              const validationError = basicPageError(page)
              if (!validationError) {
                send({ type: 'success', page, attempts: attempt })
                return res.end()
              }
              lastError = validationError
            } catch { lastError = '模型返回内容不是合法 JSON。' }
          }
          if (attempt < 3) {
            send({ type: 'progress', stage: 'retrying', attempt, message: `第 ${attempt}/3 次结果校验失败：${lastError} 正在要求 AI 修正并重试…` })
          }
        }
        send({ type: 'error', code: 'INVALID_AI_PAGE', message: `AI 连续 3 次未生成有效页面：${lastError}。请补充页面结构、组件和布局要求后重试。` })
        return res.end()
      } catch (error) {
        if (clientController.signal.aborted) return
        return reply(500, { code: 'AI_SERVER_ERROR', message: error instanceof Error ? `页面生成服务异常：${error.message}` : '页面生成服务异常，请稍后重试。' })
      }
    })
  }
})

export default defineConfig({
  plugins: [
    vue(),
    aiPageGeneratorV2(),
    vueDevTools({
      // 禁用 component inspector overlay，防止它拦截画布上的鼠标事件（拖拽/缩放）
      componentInspector: false,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
