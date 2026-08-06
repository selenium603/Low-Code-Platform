<template>
  <button
    class="button-component"
    :class="{ 'is-preview': mode === 'preview' }"
    :style="{
      fontSize: `${component.style.fontSize || 14}px`,
      fontWeight: component.style.fontWeight || 600,
      color: component.style.color || '#ffffff',
      backgroundColor: component.style.backgroundColor || '#409eff',
      border: component.style.borderWidth ? `${component.style.borderWidth}px solid ${component.style.borderColor || '#409eff'}` : 'none',
      borderRadius: component.style.borderRadius ? `${component.style.borderRadius}px` : '4px',
      boxSizing: 'border-box',
      cursor: 'pointer',
      width: '100%',
      height: '100%',
      opacity: component.style.opacity ?? 1
    }"
    type="button"
  >
    {{ buttonProps.content || '按钮' }}
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ButtonProps, ComponentData } from '@/types'

const props = withDefaults(defineProps<{
  component: ComponentData
  mode?: 'editor' | 'preview'
}>(), {
  mode: 'editor'
})

const buttonProps = computed(() => props.component.props as ButtonProps)
</script>

<style scoped>
.button-component {
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  min-height: 32px;
}

.button-component:hover {
  opacity: 0.92;
}

.button-component:active {
  transform: scale(0.98);
}

.button-component.is-preview {
  pointer-events: none;
}
</style>
