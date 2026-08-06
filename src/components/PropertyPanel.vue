<template>
  <div class="property-panel">
    <div class="panel-header">
      <div>
        <h3>配置面板</h3>
        <p>{{ currentComponent ? currentComponent.name : '页面级配置 / 组件配置' }}</p>
      </div>
      <el-button v-if="currentComponent" type="danger" size="small" @click="deleteCurrentComponent">删除</el-button>
    </div>

    <div class="property-content">
      <el-scrollbar>
        <div class="property-section">
          <h4>页面信息</h4>
          <div class="property-grid">
            <div class="property-item">
              <label>页面标题</label>
              <el-input v-model="pageTitle" @change="commitPageMeta" />
            </div>
            <div class="property-item">
              <label>页面描述</label>
              <el-input v-model="pageDescription" type="textarea" :rows="3" @change="commitPageMeta" />
            </div>
            <div class="property-item">
              <label>场景</label>
              <el-select v-model="pageScene" @change="commitPageMeta">
                <el-option label="营销活动" value="marketing" />
                <el-option label="落地页" value="landing" />
                <el-option label="表单页" value="form" />
              </el-select>
            </div>
            <div class="property-item">
              <label>页面宽度</label>
              <el-input-number v-model="pageWidth" :min="320" :step="10" @change="commitPageStyle" />
            </div>
            <div class="property-item">
              <label>页面高度</label>
              <el-input-number v-model="pageHeight" :min="400" :step="10" @change="commitPageStyle" />
            </div>
            <div class="property-item">
              <label>背景色</label>
              <el-color-picker v-model="pageBgColor" show-alpha @change="commitPageStyle" />
            </div>
            <div class="property-item full-width">
              <label>背景样式</label>
              <el-input v-model="pageBgImage" placeholder="可填写 url(...)，留空则使用纯色背景" @change="commitPageStyle" />
            </div>
          </div>
        </div>

        <template v-if="currentComponent && localStyle && localProps">
          <div class="property-section">
            <h4>位置和大小</h4>
            <div class="property-grid two-columns">
              <div class="property-item"><label>X</label><el-input-number v-model="localStyle.left" :min="0" @change="commitStyle" /></div>
              <div class="property-item"><label>Y</label><el-input-number v-model="localStyle.top" :min="0" @change="commitStyle" /></div>
              <div class="property-item"><label>宽度</label><el-input-number v-model="localStyle.width" :min="40" @change="commitStyle" /></div>
              <div class="property-item"><label>高度</label><el-input-number v-model="localStyle.height" :min="40" @change="commitStyle" /></div>
              <div class="property-item"><label>旋转</label><el-input-number v-model="localStyle.rotate" :min="-180" :max="180" @change="commitStyle" /></div>
              <div class="property-item"><label>透明度</label><el-slider v-model="localStyle.opacity" :min="0" :max="1" :step="0.1" @change="commitStyle" /></div>
            </div>
          </div>

          <div class="property-section">
            <h4>图层管理</h4>
            <div class="property-buttons">
              <el-button-group>
                <el-button @click="moveLayer('up')">上移</el-button>
                <el-button @click="moveLayer('down')">下移</el-button>
              </el-button-group>
              <el-button-group>
                <el-button @click="moveLayer('top')">置顶</el-button>
                <el-button @click="moveLayer('bottom')">置底</el-button>
              </el-button-group>
            </div>
          </div>

          <div class="property-section">
            <h4>样式设置</h4>
            <div class="property-grid two-columns">
              <div class="property-item"><label>字体大小</label><el-input-number v-model="localStyle.fontSize" :min="8" :max="72" @change="commitStyle" /></div>
              <div class="property-item"><label>字重</label><el-input-number v-model="localStyle.fontWeight" :min="100" :max="900" :step="100" @change="commitStyle" /></div>
              <div class="property-item"><label>文字颜色</label><el-color-picker v-model="localStyle.color" @change="commitStyle" /></div>
              <div class="property-item"><label>背景颜色</label><el-color-picker v-model="localStyle.backgroundColor" show-alpha @change="commitStyle" /></div>
              <div class="property-item"><label>边框宽度</label><el-input-number v-model="localStyle.borderWidth" :min="0" :max="10" @change="commitStyle" /></div>
              <div class="property-item"><label>圆角</label><el-input-number v-model="localStyle.borderRadius" :min="0" :max="999" @change="commitStyle" /></div>
              <div class="property-item"><label>边框颜色</label><el-color-picker v-model="localStyle.borderColor" @change="commitStyle" /></div>
              <div class="property-item"><label>对齐方式</label><el-select v-model="localStyle.textAlign" @change="commitStyle"><el-option label="左对齐" value="left" /><el-option label="居中" value="center" /><el-option label="右对齐" value="right" /></el-select></div>
            </div>
          </div>

          <div class="property-section" v-if="isMobile && hasMobileOverrides">
            <el-button type="warning" plain size="small" @click="resetMobileStyle" style="width:100%">恢复桌面端样式</el-button>
          </div>

          <div class="property-section">
            <h4>组件属性</h4>
            <div class="property-grid">
              <template v-for="field in componentProtocol?.schema" :key="field.key">
                <div class="property-item" :class="{ 'full-width': field.control === 'textarea' || field.type === 'array' || field.key === 'src' }">
                  <label>{{ field.label }}</label>
                  <div v-if="field.type === 'string' && currentComponent.type === 'Image' && field.key === 'src'" class="input-with-upload">
                    <el-input v-model="(localProps as Record<string, unknown>)[field.key]" :placeholder="field.placeholder" @change="commitProps" />
                    <el-upload :show-file-list="false" accept="image/*" :auto-upload="false" @change="handleImageUpload">
                      <el-button type="primary" size="small">上传</el-button>
                    </el-upload>
                  </div>
                  <el-input v-else-if="field.type === 'string'" v-model="(localProps as Record<string, unknown>)[field.key]" :type="field.control === 'textarea' ? 'textarea' : 'text'" :rows="field.control === 'textarea' ? 4 : undefined" :placeholder="field.placeholder" @change="commitProps" />
                  <el-input-number v-else-if="field.type === 'number'" v-model="(localProps as Record<string, unknown>)[field.key]" :min="field.min" :max="field.max" :step="field.step || 1" @change="commitProps" />
                  <el-color-picker v-else-if="field.type === 'color'" v-model="(localProps as Record<string, unknown>)[field.key]" show-alpha @change="commitProps" />
                  <el-select v-else-if="field.type === 'select'" v-model="(localProps as Record<string, unknown>)[field.key]" @change="commitProps">
                    <el-option v-for="option in field.options" :key="option" :label="option" :value="option" />
                  </el-select>
                  <el-input v-else-if="field.type === 'array'" :model-value="formatArrayField(field)" type="textarea" :rows="5" :placeholder="arrayPlaceholder(field)" @change="commitArrayField(field, $event)" />
                </div>
              </template>
            </div>
          </div>

          <div class="property-section">
            <h4>事件配置</h4>
            <div class="property-grid" v-if="localEventConfig">
              <div class="property-item"><label>点击动作</label><el-select v-model="localEventConfig.action" @change="commitEvents"><el-option label="无动作" value="none" /><el-option label="打开链接" value="url" /><el-option label="提示消息" value="message" /></el-select></div>
              <div class="property-item full-width" v-if="localEventConfig.action === 'url'"><label>链接地址</label><el-input v-model="localEventConfig.url" @change="commitEvents" /></div>
              <div class="property-item" v-if="localEventConfig.action === 'url'"><label>新窗口打开</label><el-switch v-model="localEventConfig.newTab" @change="commitEvents" /></div>
              <div class="property-item full-width" v-if="localEventConfig.action === 'message'"><label>提示内容</label><el-input v-model="localEventConfig.message" @change="commitEvents" /></div>
            </div>
          </div>
        </template>

        <div v-else class="empty-state">
          <el-icon><InfoFilled /></el-icon>
          <p>当前未选中组件，可先配置页面，再从左侧拖入组件。</p>
        </div>
      </el-scrollbar>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import type { ClickEventAction, ComponentData, ComponentSchemaField, ComponentStyle } from '@/types'
import { getComponentProtocol } from './components/registry'

const editorStore = useEditorStore()
const currentComponent = computed(() => editorStore.currentComponent)
const currentPage = computed(() => editorStore.currentPage)
const componentProtocol = computed(() => currentComponent.value ? getComponentProtocol(currentComponent.value.type) : undefined)
const isMobile = computed(() => editorStore.currentDevice === 'mobile')
const hasMobileOverrides = computed(() => {
  const comp = currentComponent.value
  return !!(comp && comp.responsiveOverrides?.mobile && Object.keys(comp.responsiveOverrides.mobile).length > 0)
})

const pageTitle = ref('')
const pageDescription = ref('')
const pageScene = ref<'marketing' | 'landing' | 'form'>('marketing')
const pageWidth = ref(1200)
const pageHeight = ref(800)
const pageBgColor = ref('#ffffff')
const pageBgImage = ref('')

const localStyle = ref<ComponentStyle | null>(null)
const localProps = ref<ComponentData['props'] | null>(null)
const localEventConfig = ref<ClickEventAction | null>(null)

watch(() => currentPage.value?.meta, (meta) => {
  if (!meta) return
  pageTitle.value = meta.title
  pageDescription.value = meta.description
  pageScene.value = meta.scene
}, { immediate: true })

watch(() => editorStore.getEffectivePageStyle(), (style) => {
  if (!style) return
  pageWidth.value = style.width
  pageHeight.value = style.height
  pageBgColor.value = style.backgroundColor
  pageBgImage.value = style.backgroundImage || ''
}, { immediate: true })

const clone = <T>(val: T): T => JSON.parse(JSON.stringify(toRaw(val)))

watch(currentComponent, (component) => {
  if (component) {
    localStyle.value = clone(editorStore.getEffectiveStyle(component))
    localProps.value = clone(component.props)
  } else {
    localStyle.value = null
    localProps.value = null
  }
  localEventConfig.value = component?.events?.[0]?.config ? clone(component.events[0].config) : { action: 'none' }
}, { immediate: true })

// 画布拖拽/撤销重做后，组件引用没变但属性变了，需要同步到面板
watch(() => {
  const comp = currentComponent.value
  if (!comp) return null
  return editorStore.getEffectiveStyle(comp)
}, (newStyle) => {
  if (!newStyle) return
  if (!localStyle.value || JSON.stringify(localStyle.value) !== JSON.stringify(newStyle)) {
    localStyle.value = clone(newStyle)
  }
}, { deep: true })

watch(() => currentComponent.value?.props, (newProps) => {
  if (!newProps) return
  if (!localProps.value || JSON.stringify(localProps.value) !== JSON.stringify(newProps)) {
    localProps.value = clone(newProps)
  }
})

const commitPageMeta = () => {
  editorStore.updatePageMeta({ title: pageTitle.value, description: pageDescription.value, scene: pageScene.value })
}

const commitPageStyle = () => {
  editorStore.updatePageStyle({ width: pageWidth.value, height: pageHeight.value, backgroundColor: pageBgColor.value, backgroundImage: pageBgImage.value })
}

const commitStyle = () => {
  if (!currentComponent.value || !localStyle.value) return
  editorStore.commitComponentStyle(currentComponent.value.id, clone(localStyle.value))
}

const resetMobileStyle = () => {
  if (!currentComponent.value) return
  const comp = currentComponent.value
  const prevOverrides = clone(comp.responsiveOverrides?.mobile || {})
  // 传入桌面端基础样式，delta 计算后所有视觉字段相同 → 清空移动端覆盖，恢复继承
  editorStore.commitComponentStyle(comp.id, clone(comp.style), prevOverrides)
}

const commitProps = () => {
  if (!currentComponent.value || !localProps.value) return
  editorStore.commitComponentProps(currentComponent.value.id, clone(localProps.value))
}

const commitEvents = () => {
  if (!currentComponent.value || !localEventConfig.value) return
  editorStore.commitComponentEvents(currentComponent.value.id, [{ type: 'click', config: clone(localEventConfig.value) }])
}

const formatArrayField = (field: ComponentSchemaField) => {
  if (!localProps.value) return ''
  const value = (localProps.value as Record<string, unknown>)[field.key]
  if (!Array.isArray(value)) return ''
  if (field.arrayFormat === 'name-value-lines') {
    return value.map((item) => {
      const data = item as { name?: unknown; value?: unknown }
      return `${String(data.name || '')},${String(data.value ?? '')}`
    }).join('\n')
  }
  return JSON.stringify(value, null, 2)
}

const arrayPlaceholder = (field: ComponentSchemaField) => field.arrayFormat === 'name-value-lines'
  ? '名称,数值，一行一条'
  : '请输入合法的 JSON 数组'

const commitArrayField = (field: ComponentSchemaField, value: string) => {
  if (!localProps.value) return
  try {
    const parsed = field.arrayFormat === 'name-value-lines'
      ? value.split('\n').filter((line) => line.trim()).map((line) => {
          const [name, amount] = line.split(',')
          if (!name?.trim() || amount === undefined || !Number.isFinite(Number(amount.trim()))) throw new Error('invalid chart data')
          return { name: name.trim(), value: Number(amount.trim()) }
        })
      : JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error('not array')
    ;(localProps.value as Record<string, unknown>)[field.key] = parsed
    commitProps()
  } catch {
    ElMessage.error(field.arrayFormat === 'name-value-lines' ? '图表数据格式应为“名称,数值”，每行一条。' : '数组属性必须是合法的 JSON 数组。')
  }
}

const handleImageUpload = (file: UploadFile) => {
  const raw = file.raw
  if (!raw) return
  const reader = new FileReader()
  reader.onload = () => {
    if (!localProps.value) return
    ;(localProps.value as Record<string, unknown>).src = reader.result as string
    commitProps()
  }
  reader.readAsDataURL(raw)
}

const moveLayer = (direction: 'up' | 'down' | 'top' | 'bottom') => {
  if (!currentComponent.value) return
  editorStore.moveComponentLayer(currentComponent.value.id, direction)
}

const deleteCurrentComponent = () => {
  if (!currentComponent.value) return
  editorStore.deleteComponent(currentComponent.value.id)
}
</script>

<style scoped>
.property-panel { width: 340px; background: #fff; border-left: 1px solid #e5e7eb; display: flex; flex-direction: column; }
.panel-header { padding: 18px; border-bottom: 1px solid #eef2f7; background: #ffffff; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.panel-header h3 { margin: 0; font-size: 16px; color: #111827; }
.panel-header p { margin: 6px 0 0; font-size: 12px; color: #6b7280; }
.property-content { flex: 1; min-height: 0; }
.property-section { padding: 16px; border-bottom: 1px solid #f3f4f6; }
.property-section h4 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #374151; }
.property-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.property-grid.two-columns { grid-template-columns: 1fr 1fr; }
.property-item { display: flex; flex-direction: column; gap: 6px; }
.property-item.full-width { grid-column: 1 / -1; }
.property-item label { font-size: 12px; color: #6b7280; font-weight: 600; }
.input-with-upload { display: flex; gap: 8px; }
.input-with-upload .el-input { flex: 1; }
.property-buttons { display: flex; justify-content: center; gap: 12px; }
.property-buttons .el-button { min-width: 66px; }
.property-buttons .el-button-group .el-button + .el-button { margin-left: 12px; }
.empty-state { padding: 32px 20px; color: #9ca3af; text-align: center; }
.empty-state .el-icon { font-size: 40px; margin-bottom: 12px; }
</style>
