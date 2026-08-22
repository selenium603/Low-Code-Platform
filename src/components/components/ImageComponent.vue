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
        objectFit: imageProps.objectFit || 'fill',
        objectPosition: 'center center'
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
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}

.image-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #999;
  font-size: 12px;
  padding: 8px;
  box-sizing: border-box;
}

.image-content {
  position: absolute;
  inset: 0;
  display: block;
  max-width: none;
  max-height: none;
}
</style>
