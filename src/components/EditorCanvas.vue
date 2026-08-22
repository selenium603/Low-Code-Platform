<template>
  <div class="editor-canvas">
    <div class="canvas-toolbar">
      <div class="toolbar-left">
        <el-button-group>
          <el-button @click="zoomOut" :disabled="canvasScale <= 0.3"><el-icon><ZoomOut /></el-icon></el-button>
          <el-button>{{ Math.round(canvasScale * 100) }}%</el-button>
          <el-button @click="zoomIn" :disabled="canvasScale >= 2"><el-icon><ZoomIn /></el-icon></el-button>
          <el-button @click="fitToViewport(true)"><el-icon><FullScreen /></el-icon></el-button>
        </el-button-group>
        <el-switch v-model="snapToGrid" active-text="网格吸附" />
        <el-switch v-model="showGuidelines" active-text="对齐线" />
      </div>
      <span class="tip">支持拖拽、缩放、方向键微调</span>
    </div>

    <div
      ref="viewportRef"
      class="canvas-viewport"
      tabindex="0"
      @keydown="handleKeydown"
      @mousedown.self="clearSelection"
      @dragover.prevent
      @drop="handleDrop"
    >
      <div class="canvas-stage" @mousedown.self="clearSelection">
        <div class="canvas-scaler" :style="scalerStyle">
        <div
          ref="backgroundRef"
          class="canvas-background"
          :style="canvasBgStyle"
          @mousedown.self="clearSelection"
        >
          <div class="canvas-dots"></div>
          <div
            v-for="component in sortedComponents"
            :key="component.id"
            class="component-wrapper"
            :class="{
              selected: currentComponent?.id === component.id,
              'is-mobile-dragging': isMobile && mobileDragId === component.id
            }"
            :style="wrapperStyle(component)"
            :data-cid="component.id"
            @mousedown.stop="startDrag(component, $event)"
          >
            <component :is="getRenderer(component.type)" :component="getEffectiveComponent(component)" class="component-content" />

            <div
              class="component-hitbox"
              :class="{ active: currentComponent?.id === component.id }"
              @click.stop="editorStore.selectComponent(component)"
            >
              <div v-if="currentComponent?.id === component.id" class="selection-box">
                <div class="selection-label">{{ component.name }}</div>
                <div v-if="!isMobile" class="rotate-badge">{{ getEffectiveStyle(component).rotate }}°</div>
                <div v-if="!isMobile" class="rotate-handle" @mousedown.stop.prevent="beginRotate(component, $event)">
                  <div class="rotate-handle-dot"></div>
                </div>
                <div class="resize-handles">
                  <div class="handle handle-tl" @mousedown.stop.prevent="beginResize(component, 'tl', $event)"></div>
                  <div class="handle handle-tr" @mousedown.stop.prevent="beginResize(component, 'tr', $event)"></div>
                  <div class="handle handle-bl" @mousedown.stop.prevent="beginResize(component, 'bl', $event)"></div>
                  <div class="handle handle-br" @mousedown.stop.prevent="beginResize(component, 'br', $event)"></div>
                  <div class="handle handle-t" @mousedown.stop.prevent="beginResize(component, 't', $event)"></div>
                  <div class="handle handle-r" @mousedown.stop.prevent="beginResize(component, 'r', $event)"></div>
                  <div class="handle handle-b" @mousedown.stop.prevent="beginResize(component, 'b', $event)"></div>
                  <div class="handle handle-l" @mousedown.stop.prevent="beginResize(component, 'l', $event)"></div>
                </div>
              </div>
            </div>
          </div>
          <template v-if="showGuidelines">
            <div v-for="gx in guides.x" :key="`x${gx}`" class="guide guide-x" :style="{ left: `${gx}px` }"></div>
            <div v-for="gy in guides.y" :key="`y${gy}`" class="guide guide-y" :style="{ top: `${gy}px` }"></div>
          </template>
        </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRaw, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import type { ComponentData } from '@/types'
import { ComponentType } from '@/types'
import { componentRendererMap } from './components/registry'
import { getMobileComponentStyle, getMobilePageStyle, MOBILE_AVAILABLE_WIDTH } from '@/utils/mobile'
import { getFormMinimumHeight } from '@/utils/formLayout'

const editorStore = useEditorStore()
const viewportRef = ref<HTMLElement | null>(null)
const backgroundRef = ref<HTMLElement | null>(null)
const guides = ref<{ x: number[]; y: number[] }>({ x: [], y: [] })
const canvasContentHeight = ref(0)

const currentPage = computed(() => editorStore.currentPage)
const currentComponent = computed(() => editorStore.currentComponent)
const canvasScale = computed(() => editorStore.canvasScale)
const snapToGrid = computed({ get: () => editorStore.snapToGrid, set: (v) => editorStore.setSnapToGrid(v) })
const showGuidelines = computed({ get: () => editorStore.showGuidelines, set: (v) => editorStore.setShowGuidelines(v) })
const currentDevice = computed(() => editorStore.currentDevice)
const isMobile = computed(() => currentDevice.value === 'mobile')
const effectivePageStyle = computed(() => editorStore.getEffectivePageStyle())
const pageWidth = computed(() => effectivePageStyle.value.width)
const pageHeight = computed(() => effectivePageStyle.value.height)
const sortedComponents = computed(() => {
  const comps = [...(currentPage.value?.components || [])]
  return comps.sort((a, b) => a.style.zIndex - b.style.zIndex)
})

// scaler 占据缩放后的视觉尺寸，使布局正确反映缩放后的大小
const scalerStyle = computed(() => {
  const w = pageWidth.value * canvasScale.value
  const h = isMobile.value
    ? (canvasContentHeight.value || pageHeight.value) * canvasScale.value
    : pageHeight.value * canvasScale.value
  return { width: `${w}px`, height: `${h}px` }
})

// canvas-background 使用逻辑尺寸，再通过 transform: scale() 缩放
const canvasBgStyle = computed(() => ({
  ...(isMobile.value
    ? getMobilePageStyle({
        width: pageWidth.value,
        height: pageHeight.value,
        backgroundColor: effectivePageStyle.value.backgroundColor,
        backgroundImage: effectivePageStyle.value.backgroundImage,
        // scaler 已经负责编辑器缩放，画布内部保持完整逻辑宽度，避免二次压缩。
        fluid: false
      })
    : {
        width: `${pageWidth.value}px`,
        height: `${pageHeight.value}px`,
        backgroundColor: effectivePageStyle.value.backgroundColor || '#ffffff',
        backgroundImage: effectivePageStyle.value.backgroundImage || 'none'
      }),
  minHeight: isMobile.value ? 'auto' : `${pageHeight.value}px`,
  transform: `scale(${canvasScale.value})`,
  transformOrigin: 'top left',
  boxSizing: 'border-box' as const
}))

const getRenderer = (type: ComponentType) => componentRendererMap[type] || componentRendererMap[ComponentType.TEXT]

const getEffectiveStyle = (component: ComponentData) => {
  return editorStore.getEffectiveStyle(component)
}
// 构造有效组件：将 style 替换为当前设备的合并样式，使子组件内部读取到正确的样式
const getEffectiveComponent = (component: ComponentData): ComponentData => ({
  ...component,
  style: getEffectiveStyle(component)
})

const wrapperStyle = (component: ComponentData) => {
  const eff = getEffectiveStyle(component)
  if (isMobile.value) {
    return getMobileComponentStyle(eff)
  }
  return {
    position: 'absolute' as const,
    top: `${eff.top}px`,
    left: `${eff.left}px`,
    width: `${eff.width}px`,
    height: `${eff.height}px`,
    zIndex: eff.zIndex,
    transform: `rotate(${eff.rotate}deg)`,
    opacity: eff.opacity
  }
}
const align = (value: number) => snapToGrid.value ? Math.round(value / editorStore.GRID_SIZE) * editorStore.GRID_SIZE : value
// 缩放时吸附鼠标位移而不是最终宽高，避免非网格尺寸在首次 mousemove 时突然跳动。
const alignDelta = (value: number) => snapToGrid.value
  ? Math.round(value / editorStore.GRID_SIZE) * editorStore.GRID_SIZE
  : value
const clearGuides = () => { guides.value = { x: [], y: [] } }
// 只收集当前操作组件之外的有效矩形；画布边界不属于“组件对齐”。
const getOtherRects = (activeComponentId: string) => {
  const rects: Array<{ left: number; top: number; width: number; height: number }> = []
  if (isMobile.value) return rects
  for (const comp of currentPage.value?.components || []) {
    if (comp.id === activeComponentId) continue
    const eff = getEffectiveStyle(comp)
    rects.push({ left: eff.left, top: eff.top, width: eff.width, height: eff.height })
  }
  return rects
}
// 只有当前组件的边缘/中线接近其他组件的边缘/中线时才显示参考线。
const updateGuides = (left: number, top: number, width: number, height: number, activeComponentId: string) => {
  const near = (targets: number[], val: number) => targets.find((n) => Math.abs(n - val) <= 4) ?? null

  const refX: number[] = []
  const refY: number[] = []
  for (const rect of getOtherRects(activeComponentId)) {
    refX.push(rect.left, rect.left + rect.width / 2, rect.left + rect.width)
    refY.push(rect.top, rect.top + rect.height / 2, rect.top + rect.height)
  }

  const ownX = [left, left + width / 2, left + width]
  const ownY = [top, top + height / 2, top + height]

  // 仅收集命中的参考线，去重后作为引导线渲染
  const matchedX: number[] = []
  for (const v of ownX) {
    const hit = near(refX, v)
    if (hit !== null && !matchedX.includes(hit)) matchedX.push(hit)
  }
  const matchedY: number[] = []
  for (const v of ownY) {
    const hit = near(refY, v)
    if (hit !== null && !matchedY.includes(hit)) matchedY.push(hit)
  }

  guides.value = { x: matchedX, y: matchedY }
}

const measureMobileHeight = () => {
  if (isMobile.value && backgroundRef.value) {
    canvasContentHeight.value = backgroundRef.value.offsetHeight
  }
}

const fitToViewport = async (force = false) => {
  await nextTick()
  await nextTick()
  if (!viewportRef.value || !currentPage.value) return
  if (!force && !editorStore.needsCanvasFit()) return
  measureMobileHeight()
  const availableWidth = viewportRef.value.clientWidth - 80
  const availableHeight = viewportRef.value.clientHeight - 80
  const widthScale = availableWidth / pageWidth.value
  // 手机端画布高度为 auto，需测量实际内容高度而非设备预设高度
  let effectiveHeight = pageHeight.value
  if (isMobile.value) {
    effectiveHeight = canvasContentHeight.value || pageHeight.value
  }
  const heightScale = availableHeight / effectiveHeight
  const nextScale = Math.max(0.3, Math.min(1, Math.min(widthScale, heightScale)))
  editorStore.setCanvasScale(Number(nextScale.toFixed(2)))
}

const zoomIn = () => editorStore.setCanvasScale(Math.min(canvasScale.value + 0.1, 2))
const zoomOut = () => editorStore.setCanvasScale(Math.max(canvasScale.value - 0.1, 0.3))
const clearSelection = () => editorStore.selectComponent(null)

const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  if (!event.dataTransfer || !currentPage.value || !backgroundRef.value) return
  const componentType = event.dataTransfer.getData('componentType') as ComponentType
  if (!componentType) return

  if (isMobile.value) {
    const rect = backgroundRef.value.getBoundingClientRect()
    const left = Math.max(12, align((event.clientX - rect.left) / canvasScale.value))
    const top = Math.max(12, align((event.clientY - rect.top) / canvasScale.value))
    editorStore.addComponent(componentType, {
      responsiveOverrides: {
        mobile: { left, top }
      }
    })
    return
  }

  const rect = backgroundRef.value.getBoundingClientRect()
  const left = Math.max(0, align((event.clientX - rect.left) / canvasScale.value))
  const top = Math.max(0, align((event.clientY - rect.top) / canvasScale.value))
  editorStore.addComponent(componentType, { style: { left, top } })
}

/* ---- 画布内组件拖拽移动 ---- */
let dragId = ''
let dragStartX = 0
let dragStartY = 0
let dragInitial: ComponentData['style'] | null = null
let dragStartSnapshots: Record<string, Partial<ComponentData['style']>> = {}
// 手机端拖拽：被拖组件保持 hidden 占位，ghost 影子跟随鼠标
const DRAG_THRESHOLD = 6 // 超过该距离才视为拖拽，避免普通点击因轻微抖动移动组件
let mobileDragActivated = false
const mobileDragId = ref<string | null>(null)       // 被拖组件 id（激活后设置）

const startDrag = (component: ComponentData, event: MouseEvent) => {
  if (event.button !== 0) return
  event.preventDefault()
  editorStore.selectComponent(component)
  dragId = component.id
  dragInitial = JSON.parse(JSON.stringify(toRaw(getEffectiveStyle(component))))
  dragStartSnapshots = {}
  for (const comp of currentPage.value?.components || []) {
    dragStartSnapshots[comp.id] = JSON.parse(JSON.stringify(toRaw(comp.responsiveOverrides?.mobile || {})))
  }
  dragStartX = event.clientX
  dragStartY = event.clientY
  mobileDragActivated = false

  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
}

const onDrag = (event: MouseEvent) => {
  if (!dragId || !dragInitial) return
  if (isMobile.value) {
    const totalDx = event.clientX - dragStartX
    const totalDy = event.clientY - dragStartY
    if (!mobileDragActivated) {
      if (Math.abs(totalDx) < DRAG_THRESHOLD && Math.abs(totalDy) < DRAG_THRESHOLD) return
      mobileDragActivated = true
      mobileDragId.value = dragId
    }

    const width = Math.min(MOBILE_AVAILABLE_WIDTH, Math.max(40, dragInitial.width))
    const left = Math.min(
      pageWidth.value - 12 - width,
      Math.max(12, align(dragInitial.left + totalDx / canvasScale.value))
    )
    const top = Math.max(12, align(dragInitial.top + totalDy / canvasScale.value))
    editorStore.applyComponentStyle(dragId, { left, top })
    updateGuides(left, top, width, dragInitial.height, dragId)
    return
  }
  const left = Math.max(0, align(dragInitial.left + (event.clientX - dragStartX) / canvasScale.value))
  const top = Math.max(0, align(dragInitial.top + (event.clientY - dragStartY) / canvasScale.value))
  editorStore.applyComponentStyle(dragId, { left, top })
  updateGuides(left, top, dragInitial.width, dragInitial.height, dragId)
}

const stopDrag = () => {
  if (dragId && dragInitial) {
    const component = currentPage.value?.components.find((item) => item.id === dragId)
    if (component) {
      if (isMobile.value && mobileDragActivated) {
        const previousOverrides = dragStartSnapshots[dragId] || {}
        const nextOverrides = component.responsiveOverrides?.mobile || {}
        editorStore.commitComponentStyle(
          dragId,
          JSON.parse(JSON.stringify(toRaw(nextOverrides))),
          JSON.parse(JSON.stringify(previousOverrides))
        )
      } else if (!isMobile.value) {
        // 手机端提交所有被交换组件的覆盖样式快照，确保撤销时全部恢复
        editorStore.commitComponentStyle(
          dragId,
          JSON.parse(JSON.stringify(toRaw(component.style))),
          dragInitial
        )
      }
    }
  }
  dragId = ''
  dragInitial = null
  dragStartSnapshots = {}
  mobileDragId.value = null
  mobileDragActivated = false
  clearGuides()
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
}

/* ---- 组件缩放 ---- */
let resizeId = ''
let resizeDir = ''
let resizeStartX = 0
let resizeStartY = 0
let resizeInitial: ComponentData['style'] | null = null
let resizeInitialOverrides: Partial<ComponentData['style']> | null = null
let resizeMinimumWidth = 40
let resizeMinimumHeight = 40

const beginResize = (component: ComponentData, direction: string, event: MouseEvent) => {
  if (event.button !== 0) return
  event.preventDefault()
  editorStore.selectComponent(component)
  resizeId = component.id
  resizeDir = direction
  const effStyle = getEffectiveStyle(component)
  // 手机渲染层会把继承自桌面的超宽尺寸收敛到 351px；缩放快照必须使用
  // 用户实际看到的几何尺寸，否则首次移动会从桌面宽度跳回手机宽度。
  const visibleStyle = isMobile.value
    ? {
        ...effStyle,
        width: Math.min(MOBILE_AVAILABLE_WIDTH, Math.max(40, effStyle.width)),
        height: effStyle.height > 40 ? effStyle.height : 120,
        left: Math.min(
          pageWidth.value - 12 - Math.min(MOBILE_AVAILABLE_WIDTH, Math.max(40, effStyle.width)),
          Math.max(12, effStyle.left)
        ),
        top: Math.max(12, effStyle.top)
      }
    : effStyle
  resizeInitial = JSON.parse(JSON.stringify(toRaw(visibleStyle)))
  resizeInitialOverrides = JSON.parse(JSON.stringify(toRaw(component.responsiveOverrides?.mobile || {})))
  resizeMinimumWidth = component.type === ComponentType.FORM ? 320 : 40
  resizeMinimumHeight = component.type === ComponentType.FORM ? getFormMinimumHeight(component.props) : 40
  resizeStartX = event.clientX
  resizeStartY = event.clientY
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'nwse-resize'
  document.addEventListener('mousemove', onResize)
  document.addEventListener('mouseup', stopResize)
}

const onResize = (event: MouseEvent) => {
  if (!resizeId || !resizeInitial) return
  const pointerDx = (event.clientX - resizeStartX) / canvasScale.value
  const pointerDy = (event.clientY - resizeStartY) / canvasScale.value
  const angle = (resizeInitial.rotate || 0) * Math.PI / 180
  // 控制点随组件旋转，鼠标位移需先转换回组件自身坐标系。
  const dx = alignDelta(pointerDx * Math.cos(angle) + pointerDy * Math.sin(angle))
  const dy = alignDelta(-pointerDx * Math.sin(angle) + pointerDy * Math.cos(angle))
  const minimumLeft = isMobile.value ? 12 : 0
  const minimumTop = isMobile.value ? 12 : 0
  const maximumRight = isMobile.value ? pageWidth.value - 12 : pageWidth.value
  const maximumBottom = isMobile.value ? pageHeight.value - 12 : pageHeight.value
  const initialRight = resizeInitial.left + resizeInitial.width
  const initialBottom = resizeInitial.top + resizeInitial.height
  const rotated = Math.abs(resizeInitial.rotate || 0) > 0.01

  let width = resizeInitial.width
  let height = resizeInitial.height
  if (resizeDir.includes('r')) {
    const maxWidth = rotated ? maximumRight - minimumLeft : maximumRight - resizeInitial.left
    width = Math.min(maxWidth, Math.max(resizeMinimumWidth, resizeInitial.width + dx))
  } else if (resizeDir.includes('l')) {
    const maxWidth = rotated ? maximumRight - minimumLeft : initialRight - minimumLeft
    width = Math.min(maxWidth, Math.max(resizeMinimumWidth, resizeInitial.width - dx))
  }
  if (resizeDir.includes('b')) {
    const maxHeight = rotated ? maximumBottom - minimumTop : maximumBottom - resizeInitial.top
    height = Math.min(maxHeight, Math.max(resizeMinimumHeight, resizeInitial.height + dy))
  } else if (resizeDir.includes('t')) {
    const maxHeight = rotated ? maximumBottom - minimumTop : initialBottom - minimumTop
    height = Math.min(maxHeight, Math.max(resizeMinimumHeight, resizeInitial.height - dy))
  }

  const widthDelta = width - resizeInitial.width
  const heightDelta = height - resizeInitial.height
  const localCenterShiftX = resizeDir.includes('l') ? -widthDelta / 2 : resizeDir.includes('r') ? widthDelta / 2 : 0
  const localCenterShiftY = resizeDir.includes('t') ? -heightDelta / 2 : resizeDir.includes('b') ? heightDelta / 2 : 0
  const worldCenterShiftX = localCenterShiftX * Math.cos(angle) - localCenterShiftY * Math.sin(angle)
  const worldCenterShiftY = localCenterShiftX * Math.sin(angle) + localCenterShiftY * Math.cos(angle)
  let left = resizeInitial.left + resizeInitial.width / 2 + worldCenterShiftX - width / 2
  let top = resizeInitial.top + resizeInitial.height / 2 + worldCenterShiftY - height / 2

  // 非旋转组件已经按固定对侧锚点限制尺寸，此处只消除浮点误差；旋转组件再做安全边界兜底。
  left = Math.max(minimumLeft, Math.min(maximumRight - width, left))
  top = Math.max(minimumTop, Math.min(maximumBottom - height, top))
  editorStore.applyComponentStyle(resizeId, { left, top, width, height })
  updateGuides(left, top, width, height, resizeId)
}

const stopResize = () => {
  if (resizeId && resizeInitial) {
    const component = currentPage.value?.components.find((item) => item.id === resizeId)
    if (component) {
      if (isMobile.value) {
        const overrides = component.responsiveOverrides?.mobile || {}
        editorStore.commitComponentStyle(
          resizeId,
          JSON.parse(JSON.stringify(overrides)),
          resizeInitialOverrides ? JSON.parse(JSON.stringify(resizeInitialOverrides)) : undefined
        )
      } else {
        editorStore.commitComponentStyle(
          resizeId,
          JSON.parse(JSON.stringify(toRaw(component.style))),
          resizeInitial
        )
      }
    }
  }
  resizeId = ''
  resizeDir = ''
  resizeInitial = null
  resizeInitialOverrides = null
  resizeMinimumWidth = 40
  resizeMinimumHeight = 40
  clearGuides()
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
}

/* ---- 组件旋转 ---- */
let rotateId = ''
let rotateStartAngle = 0
let rotateInitialVal = 0
let rotateInitial: ComponentData['style'] | null = null

const beginRotate = (component: ComponentData, event: MouseEvent) => {
  if (event.button !== 0) return
  event.preventDefault()
  editorStore.selectComponent(component)
  rotateId = component.id
  const eff = getEffectiveStyle(component)
  rotateInitialVal = eff.rotate
  rotateInitial = JSON.parse(JSON.stringify(toRaw(eff)))

  const bgRect = backgroundRef.value?.getBoundingClientRect()
  if (!bgRect) return
  const cx = (eff.left + eff.width / 2) * canvasScale.value
  const cy = (eff.top + eff.height / 2) * canvasScale.value
  rotateStartAngle = Math.atan2(event.clientY - bgRect.top - cy, event.clientX - bgRect.left - cx) * (180 / Math.PI)

  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  document.addEventListener('mousemove', onRotate)
  document.addEventListener('mouseup', stopRotate_)
}

const onRotate = (event: MouseEvent) => {
  if (!rotateId) return
  const component = currentPage.value?.components.find((c) => c.id === rotateId)
  if (!component) return

  const bgRect = backgroundRef.value?.getBoundingClientRect()
  if (!bgRect) return
  const eff = getEffectiveStyle(component)
  const cx = (eff.left + eff.width / 2) * canvasScale.value
  const cy = (eff.top + eff.height / 2) * canvasScale.value

  const currentAngle = Math.atan2(event.clientY - bgRect.top - cy, event.clientX - bgRect.left - cx) * (180 / Math.PI)
  let newRotate = rotateInitialVal + (currentAngle - rotateStartAngle)
  if (event.shiftKey) newRotate = Math.round(newRotate / 15) * 15
  newRotate = Math.round(newRotate)

  editorStore.applyComponentStyle(rotateId, { rotate: newRotate })
}

const stopRotate_ = () => {
  if (rotateId && rotateInitial) {
    const component = currentPage.value?.components.find((item) => item.id === rotateId)
    if (component) {
      const eff = getEffectiveStyle(component)
      editorStore.commitComponentStyle(
        rotateId,
        JSON.parse(JSON.stringify(toRaw(eff))),
        rotateInitial
      )
    }
  }
  rotateId = ''
  rotateInitial = null
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onRotate)
  document.removeEventListener('mouseup', stopRotate_)
}

const handleKeydown = (event: KeyboardEvent) => {
  if (!currentComponent.value) return
  const step = event.shiftKey ? 10 : 1
  if (event.key === 'Delete' || event.key === 'Backspace') { editorStore.deleteComponent(currentComponent.value.id); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); editorStore.nudgeComponent(currentComponent.value.id, 0, -step) }
  if (event.key === 'ArrowDown') { event.preventDefault(); editorStore.nudgeComponent(currentComponent.value.id, 0, step) }
  if (event.key === 'ArrowLeft') { event.preventDefault(); editorStore.nudgeComponent(currentComponent.value.id, -step, 0) }
  if (event.key === 'ArrowRight') { event.preventDefault(); editorStore.nudgeComponent(currentComponent.value.id, step, 0) }
}

onMounted(async () => {
  editorStore.loadPersistedPage()
  viewportRef.value?.focus()
  await fitToViewport(true)
  setTimeout(() => { fitToViewport() }, 0)
  // 不在 window resize 时自动 fit，避免用户手动缩放后被重置
})

watch([pageWidth, pageHeight], () => {
  fitToViewport()
})

// 导入或 AI 替换整页时，组件数量和画布尺寸可能恰好与旧页面一致。
// 监听页面 ID 可确保画布在这种情况下也会重新计算缩放并渲染新页面。
watch(() => currentPage.value?.id, async () => {
  await nextTick()
  await fitToViewport(true)
})

// 手机端画布高度为 auto，组件增删会改变实际高度，需重新测量与适配
watch(() => currentPage.value?.components.length, async () => {
  if (isMobile.value) {
    await nextTick()
    measureMobileHeight()
  }
})

onUnmounted(() => {
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('mousemove', onRotate)
  document.removeEventListener('mouseup', stopRotate_)
})
</script>

<style scoped>
.editor-canvas {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
  overflow: hidden;
}
.canvas-toolbar {
  height: 64px;
  padding: 0 18px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.toolbar-left { display: flex; align-items: center; gap: 14px; }
.tip { font-size: 12px; color: #6b7280; }

.canvas-viewport {
  flex: 1;
  overflow: auto;
  padding: 24px;
  outline: none;
  background: #f5f7fa;
}
.canvas-stage {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px 0 48px;
  box-sizing: border-box;
  min-height: 100%;
}

.canvas-scaler {
  flex-shrink: 0;
  position: relative;
}

.canvas-background {
  position: relative;
  border-radius: 24px;
  box-shadow: 0 16px 40px rgba(15,23,42,.08);
  border: 1px solid #e5e7eb;
}
.canvas-dots {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(#e5e7eb 0.8px, transparent 0.8px);
  background-size: 16px 16px;
  pointer-events: none;
  border-radius: 24px;
}

.component-wrapper {
  position: absolute;
  cursor: move;
  user-select: none;
}
.component-wrapper.selected { z-index: 999 !important; }
.component-wrapper.is-mobile-dragging { opacity: 0.45; }

.component-content {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
}

.component-hitbox {
  position: absolute;
  inset: 0;
  z-index: 2;
  cursor: move;
  background: transparent;
  pointer-events: auto;
}
.component-hitbox.active { cursor: grab; }

.selection-box {
  position: absolute;
  inset: -2px;
  border: 2px solid #3b82f6;
  border-radius: 12px;
  /* 关键：box 本身不拦截事件，但 handle 子元素仍然可点 */
  pointer-events: none;
  box-shadow: 0 0 0 2px rgba(59,130,246,.12);
}

.selection-label, .rotate-badge {
  position: absolute;
  top: -28px;
  height: 22px;
  line-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  color: #fff;
  background: #2563eb;
}
.selection-label { left: 0; }
.rotate-badge { right: 0; background: #475569; }

.rotate-handle {
  position: absolute;
  top: -44px;
  left: 50%;
  transform: translateX(-50%);
  width: 24px;
  height: 24px;
  cursor: grab;
  pointer-events: auto;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rotate-handle::before {
  content: '';
  position: absolute;
  bottom: 50%;
  left: 50%;
  width: 1px;
  height: 16px;
  background: #3b82f6;
  transform: translateX(-50%);
}
.rotate-handle-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #3b82f6;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,0.18);
  position: relative;
  z-index: 1;
}

.resize-handles {
  position: absolute;
  inset: 0;
  /* 关键：容器不拦截，但子元素的 pointer-events: all 仍生效 */
  pointer-events: none;
}
.handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #2563eb;
  /* 关键：恢复 handle 自身的事件响应 */
  pointer-events: all;
  z-index: 10;
}
.handle-tl { top: -6px; left: -6px; cursor: nwse-resize; }
.handle-tr { top: -6px; right: -6px; cursor: nesw-resize; }
.handle-bl { bottom: -6px; left: -6px; cursor: nesw-resize; }
.handle-br { bottom: -6px; right: -6px; cursor: nwse-resize; }
.handle-t { top: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.handle-r { top: calc(50% - 5px); right: -6px; cursor: ew-resize; }
.handle-b { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.handle-l { top: calc(50% - 5px); left: -6px; cursor: ew-resize; }

.guide { position: absolute; z-index: 998; pointer-events: none; background: rgba(239,68,68,.8); }
.guide-x { top: 0; bottom: 0; width: 1px; }
.guide-y { left: 0; right: 0; height: 1px; }
</style>
