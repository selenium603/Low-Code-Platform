import type { ComponentStyle } from '@/types'

export const MOBILE_DEFAULT_MIN_HEIGHT = 120
export const MOBILE_WIDTH_THRESHOLD = 375
export const MOBILE_SMALL_BREAKPOINT = 360
export const MOBILE_PADDING = 12
/** 移动端可用内容宽度 = 设备宽度 - 左右 padding */
export const MOBILE_AVAILABLE_WIDTH = MOBILE_WIDTH_THRESHOLD - MOBILE_PADDING * 2

/** 计算手机端组件包装样式 */
export const getMobileComponentStyle = (eff: ComponentStyle) => {
  const minH = eff.height && eff.height > 40 ? eff.height : MOBILE_DEFAULT_MIN_HEIGHT
  const hasCustomWidth = eff.width && eff.width > 0 && eff.width < MOBILE_WIDTH_THRESHOLD
  const widthPx = hasCustomWidth ? Math.min(eff.width, MOBILE_AVAILABLE_WIDTH) : MOBILE_AVAILABLE_WIDTH
  const maxLeft = Math.max(0, MOBILE_WIDTH_THRESHOLD - MOBILE_PADDING - widthPx)
  const leftPx = Math.min(maxLeft, Math.max(MOBILE_PADDING, eff.left))
  const isFullWidth = widthPx >= MOBILE_AVAILABLE_WIDTH - 8
  return {
    position: 'absolute' as const,
    top: `${Math.max(MOBILE_PADDING, eff.top)}px`,
    left: isFullWidth
      ? `${MOBILE_PADDING}px`
      : `clamp(${MOBILE_PADDING}px, ${leftPx}px, calc(100% - ${MOBILE_PADDING + widthPx}px))`,
    width: isFullWidth
      ? `calc(100% - ${MOBILE_PADDING * 2}px)`
      : `min(${widthPx}px, calc(100% - ${MOBILE_PADDING * 2}px))`,
    maxWidth: `calc(100% - ${MOBILE_PADDING * 2}px)`,
    height: `${minH}px`,
    zIndex: eff.zIndex,
    transform: `rotate(${eff.rotate}deg)`,
    opacity: eff.opacity
  }
}

/** 计算手机端页面容器样式 */
export const getMobilePageStyle = (opts: {
  width: number
  height: number
  backgroundColor?: string
  backgroundImage?: string
  /**
   * 编辑器画布的外层 scaler 已经按缩放比例占位，此时内层必须保持
   * 375px 逻辑宽度，否则百分比宽度会被父级再次压缩，造成双重缩放。
   * 预览和导出仍使用默认的流式宽度，以适配真实手机视口。
   */
  fluid?: boolean
}) => {
  const logicalWidth = Math.min(opts.width, MOBILE_WIDTH_THRESHOLD)
  return {
    width: opts.fluid === false ? `${logicalWidth}px` : `min(100%, ${logicalWidth}px)`,
    maxWidth: `${logicalWidth}px`,
    minHeight: `${opts.height}px`,
    height: `${opts.height}px`,
    backgroundColor: opts.backgroundColor || '#ffffff',
    backgroundImage: opts.backgroundImage || 'none',
    position: 'relative' as const,
    boxSizing: 'border-box' as const
  }
}
