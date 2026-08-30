import type { ComponentProtocol } from '../types'
import { ComponentType } from '../types'

export const componentProtocols: ComponentProtocol[] = [
  {
    type: ComponentType.TEXT,
    label: '营销标题',
    category: '基础',
    description: '适合主标题、卖点描述、活动文案。',
    defaultStyle: {
      top: 80,
      left: 80,
      width: 320,
      height: 72,
      zIndex: 1,
      rotate: 0,
      opacity: 1,
      fontSize: 32,
      fontWeight: 700,
      lineHeight: 1.4,
      color: '#111827',
      textAlign: 'left',
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: '#d1d5db',
      borderRadius: 0
    },
    defaultProps: {
      content: '2026 春季营销活动主标题'
    },
    schema: [
      { key: 'content', label: '文本内容', type: 'string', control: 'textarea', placeholder: '请输入文本内容' }
    ]
  },
  {
    type: ComponentType.IMAGE,
    label: '活动图片',
    category: '基础',
    description: '适合 banner、商品图、KV 视觉。',
    defaultStyle: {
      top: 180,
      left: 80,
      width: 360,
      height: 220,
      zIndex: 2,
      rotate: 0,
      opacity: 1,
      backgroundColor: '#f3f4f6',
      borderWidth: 0,
      borderColor: '#d1d5db',
      borderRadius: 16
    },
    defaultProps: {
      src: '',
      alt: '活动图片',
      objectFit: 'fill'
    },
    schema: [
      { key: 'src', label: '图片地址', type: 'string', placeholder: '请输入图片 URL' },
      { key: 'objectFit', label: '填充模式', type: 'select', options: ['fill', 'cover', 'contain'] }
    ]
  },
  {
    type: ComponentType.BUTTON,
    label: '转化按钮',
    category: '营销',
    description: '适合 CTA、立即参与、立即咨询。',
    defaultStyle: {
      top: 430,
      left: 80,
      width: 220,
      height: 48,
      zIndex: 3,
      rotate: 0,
      opacity: 1,
      fontSize: 16,
      fontWeight: 600,
      color: '#ffffff',
      backgroundColor: '#7c3aed',
      borderWidth: 0,
      borderColor: '#7c3aed',
      borderRadius: 999
    },
    defaultProps: {
      content: '立即报名',
      type: 'primary'
    },
    schema: [
      { key: 'content', label: '按钮文案', type: 'string', placeholder: '请输入按钮文案' }
    ]
  },
  {
    type: ComponentType.INPUT,
    label: '输入框',
    category: '营销',
    description: '适合手机号、邮箱、姓名收集。',
    defaultStyle: {
      top: 500,
      left: 80,
      width: 280,
      height: 44,
      zIndex: 4,
      rotate: 0,
      opacity: 1,
      fontSize: 14,
      color: '#111827',
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#dcdfe6',
      borderRadius: 10
    },
    defaultProps: {
      placeholder: '请输入手机号',
      value: '',
      inputType: 'tel'
    },
    schema: [
      { key: 'placeholder', label: '占位文案', type: 'string', placeholder: '请输入占位文案' },
      { key: 'inputType', label: '输入类型', type: 'select', options: ['text', 'email', 'tel', 'number'] }
    ]
  },
  {
    type: ComponentType.FORM,
    label: '报名表单',
    category: '营销',
    description: '内置字段区块，适合线索收集与活动报名。',
    defaultStyle: {
      top: 160,
      left: 520,
      width: 360,
      height: 380,
      zIndex: 5,
      rotate: 0,
      opacity: 1,
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#e5e7eb',
      borderRadius: 18
    },
    defaultProps: {
      title: '活动报名表单',
      submitText: '立即提交',
      fields: [
        { id: 'name', label: '姓名', type: 'text', placeholder: '请输入姓名', required: true },
        { id: 'mobile', label: '手机号', type: 'tel', placeholder: '请输入手机号', required: true },
        { id: 'email', label: '邮箱', type: 'email', placeholder: '请输入邮箱' }
      ]
    },
    schema: [
      { key: 'title', label: '表单标题', type: 'string', placeholder: '请输入表单标题' },
      { key: 'submitText', label: '提交按钮文案', type: 'string', placeholder: '请输入按钮文案' },
      { key: 'fields', label: '字段列表', type: 'array', arrayFormat: 'json' }
    ]
  },
  {
    type: ComponentType.CHART,
    label: '统计图表',
    category: '营销',
    description: '柱状图、折线图、饼图，适合数据展示。',
    defaultStyle: {
      top: 160,
      left: 80,
      width: 400,
      height: 300,
      zIndex: 6,
      rotate: 0,
      opacity: 1,
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#e5e7eb',
      borderRadius: 16
    },
    defaultProps: {
      chartType: 'bar',
      title: '数据统计',
      showLegend: true,
      legendPosition: 'bottom',
      showXAxis: true,
      showYAxis: true,
      xAxisName: '',
      yAxisName: '',
      valueUnit: '',
      primaryColor: '#5470c6',
      secondaryColor: '#91cc75',
      accentColor: '#fac858',
      tooltipFormat: 'name-value',
      data: [
        { name: '一月', value: 120 },
        { name: '二月', value: 200 },
        { name: '三月', value: 150 },
        { name: '四月', value: 80 },
        { name: '五月', value: 70 },
        { name: '六月', value: 110 }
      ]
    },
    schema: [
      { key: 'chartType', label: '图表类型', type: 'select', options: ['bar', 'line', 'pie'], optionLabels: { bar: '柱状图', line: '折线图', pie: '饼图' } },
      { key: 'title', label: '图表标题', type: 'string', placeholder: '请输入图表标题' },
      { key: 'showLegend', label: '显示图例', type: 'boolean' },
      { key: 'legendPosition', label: '图例位置', type: 'select', options: ['top', 'bottom', 'right'], optionLabels: { top: '顶部', bottom: '底部', right: '右侧' } },
      { key: 'showXAxis', label: '显示 X 轴', type: 'boolean' },
      { key: 'showYAxis', label: '显示 Y 轴', type: 'boolean' },
      { key: 'xAxisName', label: 'X 轴名称', type: 'string', placeholder: '例如：月份' },
      { key: 'yAxisName', label: 'Y 轴名称', type: 'string', placeholder: '例如：销售额' },
      { key: 'valueUnit', label: '数值单位', type: 'string', placeholder: '例如：元、%、人' },
      { key: 'primaryColor', label: '主色', type: 'color' },
      { key: 'secondaryColor', label: '辅助色', type: 'color' },
      { key: 'accentColor', label: '强调色', type: 'color' },
      { key: 'tooltipFormat', label: '提示格式', type: 'select', options: ['name-value', 'value', 'percent'], optionLabels: { 'name-value': '名称 + 数值', value: '仅数值', percent: '百分比' } },
      { key: 'data', label: '数据（名称,数值，每行一条）', type: 'array', arrayFormat: 'name-value-lines' }
    ]
  }
]

export const getComponentProtocol = (type: ComponentType) => {
  return componentProtocols.find((item) => item.type === type)
}
