<template>
  <form
    class="form-component"
    :style="containerStyle"
    @submit.prevent="handleSubmit"
  >
    <div class="form-title">{{ formProps.title || '活动报名表单' }}</div>

    <div class="form-fields">
      <label
        v-for="field in formProps.fields"
        :key="field.id"
        class="form-field"
      >
        <span>{{ field.label }}<em v-if="field.required">*</em></span>
        <input
          :type="field.type"
          :placeholder="field.placeholder"
          :required="field.required"
          :disabled="mode === 'editor'"
        />
      </label>
    </div>

    <button class="submit-button" type="submit" :disabled="mode === 'editor'">
      {{ formProps.submitText || '立即提交' }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import type { ComponentData, FormProps } from '@/types'

const props = withDefaults(defineProps<{
  component: ComponentData
  mode?: 'editor' | 'preview'
}>(), {
  mode: 'editor'
})

const emit = defineEmits<{
  submit: []
}>()

const formProps = computed(() => props.component.props as FormProps)

const handleSubmit = () => {
  if (props.mode === 'preview') emit('submit')
}

const containerStyle = computed<CSSProperties>(() => ({
  backgroundColor: props.component.style.backgroundColor || '#ffffff',
  border: props.component.style.borderWidth
    ? `${props.component.style.borderWidth}px solid ${props.component.style.borderColor || '#dcdfe6'}`
    : '1px solid #ebeef5',
  borderRadius: `${props.component.style.borderRadius ?? 12}px`,
  boxSizing: 'border-box',
  padding: '20px',
  width: '100%',
  height: '100%',
  opacity: props.component.style.opacity ?? 1
}))
</script>

<style scoped>
.form-component {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  height: 100%;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
  overflow: auto;
}

.form-title {
  font-size: 18px;
  font-weight: 700;
  color: #1f2937;
  line-height: 1.4;
}

.form-fields {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

.form-field em {
  color: #ef4444;
  font-style: normal;
  margin-left: 2px;
}

.form-field input {
  width: 100%;
  height: 38px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  padding: 0 12px;
  box-sizing: border-box;
  background: #f9fafb;
}

.submit-button {
  height: 40px;
  min-height: 40px;
  border: none;
  border-radius: 999px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
}
</style>
