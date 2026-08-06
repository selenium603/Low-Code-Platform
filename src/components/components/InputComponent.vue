<template>
  <input
    class="input-component"
    :type="inputProps.inputType || 'text'"
    :placeholder="inputProps.placeholder || '请输入内容'"
    :value="inputProps.value || ''"
    :style="{
      fontSize: `${component.style.fontSize || 14}px`,
      color: component.style.color || '#333333',
      backgroundColor: component.style.backgroundColor || '#ffffff',
      border: component.style.borderWidth ? `${component.style.borderWidth}px solid ${component.style.borderColor || '#dcdfe6'}` : '1px solid #dcdfe6',
      borderRadius: component.style.borderRadius ? `${component.style.borderRadius}px` : '4px',
      padding: '8px 12px',
      boxSizing: 'border-box',
      width: '100%',
      height: '100%',
      opacity: component.style.opacity ?? 1
    }"
    :disabled="mode === 'editor'"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ComponentData, InputProps } from '@/types'

const props = withDefaults(defineProps<{
  component: ComponentData
  mode?: 'editor' | 'preview'
}>(), {
  mode: 'editor'
})

const inputProps = computed(() => props.component.props as InputProps)
</script>

<style scoped>
.input-component {
  outline: none;
  transition: border-color 0.2s;
  min-height: 32px;
}

.input-component::placeholder {
  color: #c0c4cc;
}
</style>
