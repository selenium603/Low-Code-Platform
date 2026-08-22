import type { EChartsOption } from 'echarts'
import type { ChartProps } from '@/types'

/**
 * 编辑器、预览与 HTML 导出共同使用的图表 Option 构建器。
 * 函数保持自包含，HTML 导出时可以序列化函数源码并在独立页面中复用同一套规则。
 */
export function buildChartOption(input: Partial<ChartProps>): EChartsOption {
  const chartType = input.chartType === 'line' || input.chartType === 'pie' ? input.chartType : 'bar'
  const title = typeof input.title === 'string' ? input.title : ''
  const data = Array.isArray(input.data)
    ? input.data.filter((item) => item && typeof item.name === 'string' && Number.isFinite(item.value))
    : []
  const showLegend = input.showLegend !== false
  const legendPosition = input.legendPosition === 'top' || input.legendPosition === 'right'
    ? input.legendPosition
    : 'bottom'
  const showXAxis = input.showXAxis !== false
  const showYAxis = input.showYAxis !== false
  const xAxisName = typeof input.xAxisName === 'string' ? input.xAxisName : ''
  const yAxisName = typeof input.yAxisName === 'string' ? input.yAxisName : ''
  const valueUnit = typeof input.valueUnit === 'string' ? input.valueUnit : ''
  const tooltipFormat = input.tooltipFormat === 'value' || input.tooltipFormat === 'percent'
    ? input.tooltipFormat
    : 'name-value'
  const colors = [
    typeof input.primaryColor === 'string' && input.primaryColor ? input.primaryColor : '#5470c6',
    typeof input.secondaryColor === 'string' && input.secondaryColor ? input.secondaryColor : '#91cc75',
    typeof input.accentColor === 'string' && input.accentColor ? input.accentColor : '#fac858'
  ]
  const total = data.reduce((sum, item) => sum + Math.abs(item.value), 0)

  const tooltipFormatter = (rawParams: unknown) => {
    const params = Array.isArray(rawParams) ? rawParams[0] : rawParams
    const item = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const rawValue = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value
    const value = Number(rawValue)
    const safeValue = Number.isFinite(value) ? value : 0
    const percent = Number.isFinite(Number(item.percent))
      ? Number(item.percent)
      : total > 0
        ? Number((Math.abs(safeValue) / total * 100).toFixed(1))
        : 0
    const displayValue = tooltipFormat === 'percent'
      ? `${percent}%`
      : `${safeValue}${valueUnit}`
    return tooltipFormat === 'value'
      ? displayValue
      : `${String(item.name || '')}: ${displayValue}`
  }

  const legend = showLegend
    ? {
        show: true,
        type: 'scroll' as const,
        ...(legendPosition === 'right'
          ? { orient: 'vertical' as const, right: 8, top: 'middle' as const }
          : legendPosition === 'top'
            ? { orient: 'horizontal' as const, top: 8, left: 'center' as const }
            : { orient: 'horizontal' as const, bottom: 8, left: 'center' as const })
      }
    : { show: false }

  const baseOption: EChartsOption = {
    color: colors,
    animationDurationUpdate: 240,
    title: {
      text: title,
      left: 16,
      top: 8,
      textStyle: { fontSize: 14, fontWeight: 600, overflow: 'truncate', width: 220 }
    },
    legend,
    tooltip: {
      trigger: chartType === 'pie' ? 'item' : 'axis',
      renderMode: 'richText',
      formatter: tooltipFormatter
    }
  }

  if (chartType === 'pie') {
    return {
      ...baseOption,
      series: [{
        name: title || '数值',
        type: 'pie',
        radius: ['30%', '60%'],
        center: [legendPosition === 'right' && showLegend ? '42%' : '50%', '52%'],
        data: data.map((item) => ({ name: item.name, value: item.value })),
        label: {
          show: true,
          formatter: (params: { name?: string; value?: unknown }) => `${params.name || ''}: ${Number(params.value) || 0}${valueUnit}`
        },
        emphasis: { scale: true, scaleSize: 6 }
      }]
    }
  }

  return {
    ...baseOption,
    grid: {
      left: showYAxis ? 56 : 24,
      right: showLegend && legendPosition === 'right' ? 112 : 24,
      top: showLegend && legendPosition === 'top' ? 64 : 48,
      bottom: showLegend && legendPosition === 'bottom' ? 64 : 36,
      containLabel: true
    },
    xAxis: {
      type: 'category',
      show: showXAxis,
      name: xAxisName,
      nameLocation: 'middle',
      nameGap: 28,
      data: data.map((item) => item.name),
      axisLabel: { fontSize: 11, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      show: showYAxis,
      name: yAxisName,
      nameGap: 14,
      axisLabel: {
        formatter: (value: number) => `${value}${valueUnit}`
      }
    },
    series: [{
      name: title || '数值',
      type: chartType,
      data: data.map((item) => item.value),
      smooth: chartType === 'line',
      itemStyle: {
        color: colors[0],
        borderRadius: chartType === 'bar' ? [4, 4, 0, 0] : 0
      },
      lineStyle: { width: 3, color: colors[0] },
      symbolSize: 6
    }]
  }
}

export const getChartOptionFactorySource = () => `(${buildChartOption.toString()})`
