<template>
  <div class="page-renderer" :style="pageStyle">
    <div
      v-for="component in sortedComponents"
      :key="component.id"
      class="rendered-component"
      :class="{ interactive: hasClickAction(component) }"
      :style="componentStyle(component)"
      @click="handleComponentClick(component, $event)"
    >
      <component
        :is="getRenderer(component.type)"
        :component="getEffectiveComponent(component)"
        mode="preview"
        @submit="handleFormSubmit(component)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { ComponentData, ComponentType, PageData } from '@/types'
import { ComponentType as ComponentTypes } from '@/types'
import { componentRendererMap } from './components/registry'
import { useEditorStore } from '@/stores/editor'
import { getMobileComponentStyle, getMobilePageStyle } from '@/utils/mobile'

const props = defineProps<{
  page: PageData
}>()

const editorStore = useEditorStore()
const isMobile = computed(() => editorStore.currentDevice === 'mobile')

const sortedComponents = computed(() => {
  const comps = [...props.page.components]
  return comps.sort((a, b) => a.style.zIndex - b.style.zIndex)
})

const pageStyle = computed(() => {
  const effective = editorStore.getEffectivePageStyle(props.page)
  if (isMobile.value) {
    return getMobilePageStyle({
      width: effective.width,
      height: effective.height,
      backgroundColor: effective.backgroundColor,
      backgroundImage: effective.backgroundImage
    })
  }
  return {
    width: `${effective.width}px`,
    height: `${effective.height}px`,
    backgroundColor: effective.backgroundColor || '#ffffff',
    backgroundImage: effective.backgroundImage || 'none'
  }
})

const getRenderer = (type: ComponentType) => componentRendererMap[type] || componentRendererMap[ComponentTypes.TEXT]
// 构造有效组件：将 style 替换为当前设备的合并样式，使子组件内部读取到正确的样式
const getEffectiveComponent = (component: ComponentData): ComponentData => ({
  ...component,
  style: editorStore.getEffectiveStyle(component)
})
const componentStyle = (component: ComponentData) => {
  const eff = editorStore.getEffectiveStyle(component)
  if (isMobile.value) return getMobileComponentStyle(eff)
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

const getClickAction = (component: ComponentData) => component.events.find((event) => event.type === 'click')?.config
const hasClickAction = (component: ComponentData) => getClickAction(component)?.action !== 'none'

const runClickAction = (component: ComponentData) => {
  const config = getClickAction(component)
  if (!config || config.action === 'none') return false

  if (config.action === 'message') {
    ElMessage.info(config.message || '操作已触发')
    return true
  }

  if (!config.url) {
    ElMessage.warning('请先配置跳转地址')
    return true
  }

  try {
    const target = new URL(config.url, window.location.origin)
    if (!['http:', 'https:'].includes(target.protocol)) {
      ElMessage.error('仅支持 http 或 https 链接')
      return true
    }

    if (config.newTab) {
      window.open(target.href, '_blank', 'noopener,noreferrer')
    } else {
      window.location.assign(target.href)
    }
  } catch {
    ElMessage.error('跳转地址格式不正确')
  }

  return true
}

const handleComponentClick = (component: ComponentData, event: MouseEvent) => {
  // 表单按钮由 submit 事件统一处理，避免一次点击触发两次动作。
  if (component.type === ComponentTypes.FORM && event.target instanceof HTMLButtonElement) return
  runClickAction(component)
}

const handleFormSubmit = (component: ComponentData) => {
  if (!runClickAction(component)) {
    ElMessage.success('表单校验通过：当前为纯前端预览，数据不会提交或保存。')
  }
}
</script>

<style scoped>
.page-renderer {
  position: relative;
  margin: 0 auto;
  border: 1px solid #e5e7eb;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
}

.rendered-component {
  position: absolute;
}

.rendered-component > * {
  width: 100%;
  height: 100%;
}

.rendered-component.interactive {
  cursor: pointer;
}
</style>
