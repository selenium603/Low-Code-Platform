<template>
  <div
    ref="chartRef"
    class="chart-container"
    :style="containerStyle"
  ></div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import * as echarts from 'echarts'
import type { ComponentData } from '@/types'
import type { ChartProps } from '@/types'
import { buildChartOption } from '@/utils/chartOption'

const props = defineProps<{
  component: ComponentData
}>()

const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

const containerStyle = computed(() => {
  const s = props.component.style
  return {
    width: '100%',
    height: '100%',
    backgroundColor: s.backgroundColor || 'transparent',
    border: s.borderWidth ? `${s.borderWidth}px solid ${s.borderColor || '#ccc'}` : 'none',
    borderRadius: s.borderRadius ? `${s.borderRadius}px` : '0',
    opacity: s.opacity ?? 1
  }
})

const renderChart = () => {
  if (!chartRef.value) return
  if (!chartInstance) {
    chartInstance = echarts.init(chartRef.value)
  }
  chartInstance.setOption(buildChartOption(props.component.props as unknown as ChartProps), true)
}

onMounted(() => {
  renderChart()
  // 监听容器大小变化，自动适配 ECharts 尺寸
  if (chartRef.value) {
    resizeObserver = new ResizeObserver(() => {
      chartInstance?.resize()
    })
    resizeObserver.observe(chartRef.value)
  }
})

watch(() => props.component.props, () => {
  renderChart()
}, { deep: true })

watch(() => props.component.style, () => {
  // 样式变化后也重新适配一下大小（比如边框宽窄变化会影响内部可用空间）
  chartInstance?.resize()
}, { deep: true })

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chartInstance?.dispose()
  chartInstance = null
})
</script>

<style scoped>
.chart-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  box-sizing: border-box;
}
</style>
