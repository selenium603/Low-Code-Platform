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

const getChartOption = () => {
  const chartProps = props.component.props as unknown as ChartProps
  const { chartType, title, data } = chartProps

  const baseOption: echarts.EChartsOption = {
    title: {
      text: title,
      textStyle: { fontSize: 14, fontWeight: 600 },
      left: 'center'
    },
    tooltip: {},
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    series: []
  }

  if (chartType === 'pie') {
    return {
      ...baseOption,
      series: [{
        type: 'pie',
        radius: ['30%', '60%'],
        center: ['50%', '55%'],
        data: data.map(item => ({ name: item.name, value: item.value })),
        label: { show: true, formatter: '{b}: {c}' }
      }]
    }
  }

  return {
    ...baseOption,
    xAxis: {
      type: 'category',
      data: data.map(item => item.name),
      axisLabel: { fontSize: 11 }
    },
    yAxis: { type: 'value' },
    series: [{
      type: chartType,
      data: data.map(item => item.value),
      itemStyle: {
        color: chartType === 'bar' ? '#5470c6' : '#ee6666',
        borderRadius: chartType === 'bar' ? [4, 4, 0, 0] : 0
      },
      lineStyle: { width: 3 },
      symbolSize: 6
    }]
  }
}

const renderChart = () => {
  if (!chartRef.value) return
  if (!chartInstance) {
    chartInstance = echarts.init(chartRef.value)
  }
  chartInstance.setOption(getChartOption(), true)
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