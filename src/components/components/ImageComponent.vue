<template>
  <div
    class="image-component"
    :style="{
      border: component.style.borderWidth ? `${component.style.borderWidth}px solid ${component.style.borderColor || '#ccc'}` : 'none',
      borderRadius: component.style.borderRadius ? `${component.style.borderRadius}px` : '0',
      overflow: 'hidden',
      backgroundColor: component.style.backgroundColor || '#f5f5f5',
      opacity: component.style.opacity ?? 1
    }"
  >
    <img
      v-if="imageProps.src"
      :src="imageProps.src"
      :alt="imageProps.alt || '图片'"
      class="image-content"
      :style="{
        width: '100%',
        height: '100%',
        objectFit: imageProps.objectFit || 'fill'
      }"
    />
    <div v-else class="image-placeholder">
      <el-icon><Picture /></el-icon>
      <span>请设置图片地址</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Picture } from '@element-plus/icons-vue'
import type { ComponentData, ImageProps } from '@/types'

const props = defineProps<{
  component: ComponentData
}>()

const imageProps = computed(() => props.component.props as ImageProps)
</script>

<style scoped>
.image-component {
  width: 100%;
  height: 100%;
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #999;
  font-size: 12px;
  padding: 24px 16px;
  min-height: 100px;
}

.image-content {
  display: block;
}
</style>
