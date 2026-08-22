<template>
  <div class="component-panel">
    <div class="panel-header">
      <div>
        <h3>组件资产库</h3>
        <p>拖拽到画布快速搭建营销页面</p>
      </div>
    </div>

    <div class="component-list">
      <div class="section-title">基础组件</div>
      <div
        v-for="component in baseComponents"
        :key="component.type"
        class="component-item"
        draggable="true"
        @dragstart="handleDragStart(component.type, $event)"
      >
        <div class="component-icon">
          <el-icon>
            <component :is="component.icon" />
          </el-icon>
        </div>
        <div class="component-meta">
          <div class="component-name">{{ component.label }}</div>
          <div class="component-desc">{{ component.description }}</div>
        </div>
      </div>

      <div class="section-title marketing">营销场景</div>
      <div
        v-for="component in marketingComponents"
        :key="component.type"
        class="component-item marketing-item"
        draggable="true"
        @dragstart="handleDragStart(component.type, $event)"
      >
        <div class="component-icon marketing-icon">
          <el-icon>
            <component :is="component.icon" />
          </el-icon>
        </div>
        <div class="component-meta">
          <div class="component-name">{{ component.label }}</div>
          <div class="component-desc">{{ component.description }}</div>
        </div>
      </div>

      <div class="section-title marketing">图层管理</div>
      <div v-if="sortedLayers.length" class="layer-list">
        <div
          v-for="layer in sortedLayers"
          :key="layer.id"
          class="layer-item"
          :class="{ active: currentComponent?.id === layer.id }"
          @click="selectLayer(layer.id)"
        >
          <span class="layer-index">{{ layer.style.zIndex }}</span>
          <span class="layer-name">{{ layer.name }}</span>
          <span class="layer-type">{{ layer.type }}</span>
          <el-button
            class="layer-rename"
            text
            circle
            size="small"
            title="修改图层名称"
            :aria-label="`修改图层名称：${layer.name}`"
            @click.stop="renameLayer(layer.id, layer.name)"
          >
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
      <div v-else class="empty-layer">当前暂无图层</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { componentProtocols } from './components/registry'
import { useEditorStore } from '@/stores/editor'
import { ComponentType } from '@/types'
import {
  CircleCheck,
  Document,
  EditPen,
  Edit,
  Picture,
  Tickets,
  DataAnalysis
} from '@element-plus/icons-vue'

const editorStore = useEditorStore()
const currentComponent = computed(() => editorStore.currentComponent)
const currentPage = computed(() => editorStore.currentPage)

const iconMap = {
  [ComponentType.TEXT]: Document,
  [ComponentType.IMAGE]: Picture,
  [ComponentType.BUTTON]: CircleCheck,
  [ComponentType.INPUT]: EditPen,
  [ComponentType.FORM]: Tickets,
  [ComponentType.CHART]: DataAnalysis
}

const componentList = computed(() =>
  componentProtocols.map((item) => ({
    ...item,
    icon: iconMap[item.type]
  }))
)

const baseComponents = computed(() => componentList.value.filter((item: (typeof componentList.value)[number]) => item.category === '基础'))
const marketingComponents = computed(() => componentList.value.filter((item: (typeof componentList.value)[number]) => item.category === '营销'))
const sortedLayers = computed(() => [...(currentPage.value?.components || [])].sort((a, b) => b.style.zIndex - a.style.zIndex))

const handleDragStart = (componentType: ComponentType, event: DragEvent) => {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('componentType', componentType)
  event.dataTransfer.effectAllowed = 'copy'
}

const selectLayer = (componentId: string) => {
  const component = currentPage.value?.components.find((item) => item.id === componentId) || null
  editorStore.selectComponent(component)
}

const renameLayer = async (componentId: string, currentName: string) => {
  selectLayer(componentId)
  try {
    const { value } = await ElMessageBox.prompt('请输入新的图层名称', '修改图层名称', {
      inputValue: currentName,
      inputPlaceholder: '1～80 个字符',
      inputValidator: (input) => {
        const name = input.trim()
        if (!name) return '图层名称不能为空'
        if (name.length > 80) return '图层名称不能超过 80 个字符'
        return true
      },
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    editorStore.renameComponent(componentId, value)
    ElMessage.success('图层名称已修改')
  } catch {
    // 用户取消时保持原名称。
  }
}
</script>

<style scoped>
.component-panel {
  width: 300px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
}

.panel-header {
  padding: 20px;
  border-bottom: 1px solid #eef2f7;
  background: #fbfcfe;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #111827;
}

.panel-header p {
  margin: 6px 0 0;
  font-size: 12px;
  color: #6b7280;
}

.component-list {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  color: #6b7280;
  margin: 0 0 12px;
}

.section-title.marketing {
  margin-top: 18px;
}

.component-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  margin-bottom: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  background: #fff;
  cursor: grab;
  transition: 0.2s ease;
  user-select: none;
}

.component-item:hover {
  transform: translateY(-1px);
  border-color: #bfdbfe;
  box-shadow: 0 12px 24px rgba(148, 163, 184, 0.12);
}

.marketing-item {
  border-color: #e5e7eb;
  background: #fcfcfd;
}

.component-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: #eff6ff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.marketing-icon {
  background: #f8fafc;
}

.component-icon .el-icon {
  font-size: 20px;
  color: #2563eb;
}

.component-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.component-name {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}

.component-desc {
  font-size: 12px;
  line-height: 1.5;
  color: #6b7280;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.layer-item {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto 28px;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #ffffff;
  cursor: pointer;
}

.layer-item.active {
  border-color: #93c5fd;
  background: #eff6ff;
}

.layer-index {
  width: 24px;
  height: 24px;
  line-height: 24px;
  text-align: center;
  border-radius: 999px;
  background: #f3f4f6;
  color: #374151;
  font-size: 12px;
}

.layer-name {
  font-size: 13px;
  color: #111827;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-rename {
  color: #64748b;
}

.layer-rename:hover {
  color: #2563eb;
  background: #dbeafe;
}

.layer-type,
.empty-layer {
  font-size: 12px;
  color: #6b7280;
}
</style>
