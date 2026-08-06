import type { ComponentData, ComponentStyle } from '@/types'

export const MOBILE_DEFAULT_MIN_HEIGHT = 120
export const MOBILE_WIDTH_THRESHOLD = 375
export const MOBILE_PADDING = 12
export const MOBILE_GAP = 8
/** 移动端可用内容宽度 = 设备宽度 - 左右 padding */
export const MOBILE_AVAILABLE_WIDTH = MOBILE_WIDTH_THRESHOLD - MOBILE_PADDING * 2

/** 按 mobile order 排序组件 */
export const sortMobileComponents = (components: ComponentData[]): ComponentData[] =>
  [...components].sort((a, b) => {
    const aOrder = a.responsiveOverrides?.mobile?.order ?? a.style.zIndex
    const bOrder = b.responsiveOverrides?.mobile?.order ?? b.style.zIndex
    return aOrder - bOrder
  })

/** 计算手机端组件包装样式 */
export const getMobileComponentStyle = (eff: ComponentStyle) => {
  const minH = eff.height && eff.height > 40 ? eff.height : MOBILE_DEFAULT_MIN_HEIGHT
  const hasCustomWidth = eff.width && eff.width > 0 && eff.width < MOBILE_WIDTH_THRESHOLD
  const widthPx = hasCustomWidth ? Math.min(eff.width, MOBILE_AVAILABLE_WIDTH) : MOBILE_AVAILABLE_WIDTH
  const maxLeft = Math.max(0, MOBILE_WIDTH_THRESHOLD - MOBILE_PADDING - widthPx)
  return {
    position: 'absolute' as const,
    top: `${Math.max(MOBILE_PADDING, eff.top)}px`,
    left: `${Math.min(maxLeft, Math.max(MOBILE_PADDING, eff.left))}px`,
    width: `${widthPx}px`,
    height: `${minH}px`,
    zIndex: eff.zIndex,
    transform: `rotate(${eff.rotate}deg)`,
    opacity: eff.opacity
  }
}

/** 计算手机端页面容器样式 */
export const getMobilePageStyle = (opts: {
  width: number
  backgroundColor?: string
  backgroundImage?: string
}) => ({
  width: `${opts.width}px`,
  minHeight: 'auto' as const,
  height: '812px' as const,
  backgroundColor: opts.backgroundColor || '#ffffff',
  backgroundImage: opts.backgroundImage || 'none',
  position: 'relative' as const,
  boxSizing: 'border-box' as const
})
