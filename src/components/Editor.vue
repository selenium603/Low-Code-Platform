<template>
  <div class="page-editor-container">
    <div class="editor-header">
      <div class="header-left">
        <div>
          <h1>营销页面搭建平台</h1>
          <div class="header-subtitle">
            <span>{{ currentPage?.meta.title || '未命名页面' }}</span>
            <span>场景：{{ currentPage?.meta.scene || 'marketing' }}</span>
            <span>组件数：{{ currentPage?.components.length || 0 }}</span>
            <span v-if="lastSavedAt">最近保存：{{ lastSavedAt }}</span>
          </div>
        </div>
      </div>

      <div class="header-center">
        <el-button-group>
          <el-button
            v-for="(preset, key) in editorStore.devicePresets"
            :key="key"
            :type="editorStore.currentDevice === key ? 'primary' : 'default'"
            @click="switchDevice(key as any)"
          >
            {{ preset.label }}
            <span class="device-size">{{ preset.width }}×{{ preset.height }}</span>
          </el-button>
        </el-button-group>

        <el-button-group>
          <el-button @click="historyStore.undo()" :disabled="!historyStore.canUndo">
            <el-icon><RefreshLeft /></el-icon>
            撤销
          </el-button>
          <el-button @click="historyStore.redo()" :disabled="!historyStore.canRedo">
            <el-icon><RefreshRight /></el-icon>
            重做
          </el-button>
        </el-button-group>

        <el-button @click="previewVisible = true" type="primary" plain>
          <el-icon><View /></el-icon>
          预览
        </el-button>
        <el-button @click="aiGeneratorVisible = true" type="primary">
          <el-icon><MagicStick /></el-icon>
          AI 生成
        </el-button>
        <el-dropdown split-button type="success" plain @click="handleExport" @command="handleExportFormat">
          <el-icon><Download /></el-icon>
          导出
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="json">导出 JSON</el-dropdown-item>
              <el-dropdown-item command="html">导出 HTML</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <div class="header-right">
        <el-upload :show-file-list="false" accept="application/json" :auto-upload="false" @change="handleImport">
          <el-button>
            <el-icon><Upload /></el-icon>
            导入 JSON
          </el-button>
        </el-upload>
        <el-button @click="handleSave">
          <el-icon><Document /></el-icon>
          保存
        </el-button>
        <el-button @click="handleNewPage">
          <el-icon><Plus /></el-icon>
          新建页面
        </el-button>
      </div>
    </div>

    <div class="editor-body">
      <ComponentPanel />
      <EditorCanvas />
      <PropertyPanel />
    </div>

    <el-dialog v-model="previewVisible" title="页面预览" width="90%" top="4vh">
      <div class="preview-shell">
        <div class="preview-device-bar">实时渲染预览</div>
        <PageRenderer v-if="currentPage" :page="currentPage" />
      </div>
    </el-dialog>
    <AIGenerator v-model:visible="aiGeneratorVisible" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { useEditorStore } from '@/stores/editor'
import { useHistoryStore } from '@/stores/history'
import ComponentPanel from './ComponentPanel.vue'
import EditorCanvas from './EditorCanvas.vue'
import PropertyPanel from './PropertyPanel.vue'
import PageRenderer from './PageRenderer.vue'
import AIGenerator from './AIGenerator.vue'
import { Document, Download, MagicStick, Plus, RefreshLeft, RefreshRight, Upload, View } from '@element-plus/icons-vue'
import type { ChartProps, DeviceType } from '@/types'
import { MOBILE_AVAILABLE_WIDTH, MOBILE_PADDING, MOBILE_SMALL_BREAKPOINT, MOBILE_WIDTH_THRESHOLD } from '@/utils/mobile'
import { getChartOptionFactorySource } from '@/utils/chartOption'

const switchDevice = (device: DeviceType) => {
  editorStore.setDevice(device)
}

const generateHTMLPage = (page: Record<string, unknown>): string => {
  const pageStyle = page.style as Record<string, unknown>
  const components = page.components as Array<Record<string, unknown>>
  const meta = page.meta as Record<string, unknown>
  const pageResponsive = page.responsiveOverrides as Record<string, Record<string, unknown>> | undefined
  const mobilePageOverrides = pageResponsive?.mobile || {}

  const escAttr = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escJs = (s: string) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** 将组件 ID 净化为安全的 CSS 选择器 / HTML id 值 */
  const safeId = (id: string): string => {
    const sanitized = (id || '').replace(/[^a-zA-Z0-9_-]/g, '_')
    return sanitized.replace(/^[0-9]/, '_$&') || '_'
  }

  const renderComponent = (comp: Record<string, unknown>): string => {
    const style = comp.style as Record<string, unknown>
    const props = comp.props as Record<string, unknown>
    const type = comp.type as string
    const events = comp.events as Array<Record<string, unknown>> | undefined
    const clickConfig = events?.[0]?.config as Record<string, unknown> | undefined
    const hasClick = clickConfig && clickConfig.action !== 'none'
    const onClick = hasClick
      ? clickConfig.action === 'url'
        ? `onclick="window.open('${escJs(clickConfig.url as string)}','${clickConfig.newTab ? '_blank' : '_self'}')"`
        : `onclick="alert('${escJs(clickConfig.message as string)}')"`
      : ''
    const cursorStyle = hasClick ? 'cursor:pointer' : ''

    const pos = `position:absolute;left:${style.left}px;top:${style.top}px;width:${style.width}px;height:${style.height}px;z-index:${style.zIndex};opacity:${style.opacity};transform:rotate(${style.rotate}deg)`
    const compId = `comp-${safeId((comp.id as string) || '')}`
    const idAttr = `id="${compId}"`

    switch (type) {
      case 'Text': {
        return `<div ${idAttr} style="${pos};font-size:${style.fontSize || 14}px;font-weight:${style.fontWeight || 400};line-height:${style.lineHeight || 1.5};color:${style.color || '#333333'};text-align:${style.textAlign || 'left'};background:${style.backgroundColor || 'transparent'};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#ccc'}` : 'none'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '0'};padding:4px 8px;box-sizing:border-box;white-space:pre-wrap;word-break:break-word;display:flex;align-items:center;min-height:20px;${cursorStyle}" ${onClick}>${escAttr(props.content as string) || '文本内容'}</div>`
      }
      case 'Image': {
        const src = (props.src as string) || ''
        const imageHtml = src
          ? `<img src="${escAttr(src)}" alt="${escAttr(props.alt as string)}" style="width:100%;height:100%;object-fit:${props.objectFit || 'fill'};display:block;user-select:none;-webkit-user-drag:none">`
          : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;color:#999;font-size:12px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>请设置图片地址</span></div>`
        return `<div ${idAttr} style="${pos};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#ccc'}` : 'none'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '0'};overflow:hidden;background:${style.backgroundColor || '#f5f5f5'};display:flex;align-items:center;justify-content:center;${cursorStyle}" ${onClick}>${imageHtml}</div>`
      }
      case 'Button': {
        return `<div ${idAttr} style="${pos};overflow:hidden;${cursorStyle}" ${onClick}><button style="font-size:${style.fontSize || 14}px;font-weight:${style.fontWeight || 600};color:${style.color || '#ffffff'};background:${style.backgroundColor || '#409eff'};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#409eff'}` : 'none'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '4px'};box-sizing:border-box;cursor:pointer;width:100%;height:100%;min-height:32px;display:flex;align-items:center;justify-content:center;transition:all 0.2s" onmouseover="this.style.opacity='0.92'" onmouseout="this.style.opacity=''" onmousedown="this.style.transform='scale(0.98)'" onmouseup="this.style.transform=''">${escAttr(props.content as string) || '按钮'}</button></div>`
      }
      case 'Input': {
        const inputType = (props.inputType as string) || 'text'
        const placeholder = (props.placeholder as string) || '请输入内容'
        return `<div ${idAttr} style="${pos};${cursorStyle}" ${onClick}><input type="${inputType}" placeholder="${escAttr(placeholder)}" value="${escAttr(props.value as string)}" style="font-size:${style.fontSize || 14}px;color:${style.color || '#333333'};background:${style.backgroundColor || '#ffffff'};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#dcdfe6'}` : '1px solid #dcdfe6'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '4px'};padding:8px 12px;box-sizing:border-box;width:100%;height:100%;min-height:32px;transition:border-color 0.2s;outline:none"></div>`
      }
      case 'Form': {
        const fields = (props.fields as Array<Record<string, unknown>>) || []
        const fieldsHtml = fields.map((f) => {
          const ft = f.type as string
          const label = escAttr(f.label as string)
          const requiredMark = f.required ? '<em style="color:#ef4444;font-style:normal;margin-left:2px">*</em>' : ''
          const requiredAttr = f.required ? ' required' : ''
          const inputType = ['text', 'email', 'tel', 'number', 'password'].includes(ft) ? ft : 'text'
          if (ft === 'textarea') {
            return `<label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:#374151"><span>${label}${requiredMark}</span><textarea rows="3" placeholder="${escAttr(f.placeholder as string)}"${requiredAttr} style="width:100%;padding:8px 12px;border:1px solid #dcdfe6;border-radius:8px;font-size:13px;box-sizing:border-box;background:#f9fafb;outline:none"></textarea></label>`
          }
          return `<label style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:#374151"><span>${label}${requiredMark}</span><input type="${inputType}" placeholder="${escAttr(f.placeholder as string)}"${requiredAttr} style="width:100%;height:38px;padding:0 12px;border:1px solid #dcdfe6;border-radius:8px;font-size:13px;box-sizing:border-box;background:#f9fafb;outline:none"></label>`
        }).join('')
        return `<form ${idAttr} style="${pos};background:${style.backgroundColor || '#ffffff'};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#dcdfe6'}` : '1px solid #ebeef5'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '12px'};padding:20px;box-sizing:border-box;overflow:auto;box-shadow:0 10px 30px rgba(15,23,42,0.06);display:flex;flex-direction:column;gap:16px;${cursorStyle}" onsubmit="event.preventDefault();alert('${escJs(props.submitText as string || '提交成功')}')"><div style="font-size:18px;font-weight:700;color:#1f2937;line-height:1.4">${escAttr(props.title as string) || '活动报名表单'}</div><div style="display:flex;flex:1;flex-direction:column;gap:12px;min-height:0">${fieldsHtml}</div><button type="submit" style="height:40px;min-height:40px;border:none;border-radius:999px;background:#2563eb;color:#fff;font-weight:600;font-size:14px;cursor:pointer;transition:opacity 0.2s" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity=''">${escAttr(props.submitText as string) || '立即提交'}</button></form>`
      }
      case 'Chart': {
        const chartConfig = JSON.stringify(props as unknown as ChartProps).replace(/'/g, '&#39;')
        return `<div ${idAttr} style="${pos};background:${style.backgroundColor || 'transparent'};border:${style.borderWidth ? `${style.borderWidth}px solid ${style.borderColor || '#ccc'}` : 'none'};border-radius:${style.borderRadius ? `${style.borderRadius}px` : '0'};overflow:hidden" data-chart='${chartConfig}'></div>`
      }
      default:
        return `<div ${idAttr} style="${pos};background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px">未知组件</div>`
    }
  }

  const componentsHtml = components.map(renderComponent).join('\n      ')

  // 与编辑器 mobile.ts 保持一致：375px 画布、12px 安全边距、绝对定位。
  const MOBILE_WIDTH = MOBILE_WIDTH_THRESHOLD
  const MOBILE_AVAIL_W = MOBILE_AVAILABLE_WIDTH
  const MOBILE_HEIGHT = typeof mobilePageOverrides.height === 'number'
    ? Math.max(812, mobilePageOverrides.height)
    : 812
  const MOBILE_BACKGROUND = typeof mobilePageOverrides.backgroundColor === 'string'
    ? mobilePageOverrides.backgroundColor
    : String(pageStyle.backgroundColor || '#ffffff')

  /** 根据组件类型返回视觉样式作用的目标选择器后缀 */
  const visualChildSelector = (type: string): string => {
    if (type === 'Button') return ' button'
    if (type === 'Input') return ' input'
    return ''
  }

  const mobileCss = components.map((comp) => {
    const c = comp as Record<string, unknown>
    const sid = safeId((c.id as string) || '')
    const style = c.style as Record<string, unknown>
    const overrides = (c.responsiveOverrides as Record<string, Record<string, unknown>> | undefined)?.mobile
    const type = c.type as string
    const eff = { ...style, ...(overrides || {}) }

    const wrapperRules: string[] = []
    const childRules: string[] = []
    const childSel = visualChildSelector(type)

    const rawWidth = typeof eff.width === 'number' ? eff.width : MOBILE_AVAIL_W
    const width = rawWidth > 0 && rawWidth < MOBILE_WIDTH ? Math.min(rawWidth, MOBILE_AVAIL_W) : MOBILE_AVAIL_W
    const rawHeight = typeof eff.height === 'number' ? eff.height : 120
    const height = rawHeight > 40 ? rawHeight : 120
    const rawLeft = typeof eff.left === 'number' ? eff.left : MOBILE_PADDING
    const rawTop = typeof eff.top === 'number' ? eff.top : MOBILE_PADDING
    const left = Math.min(MOBILE_WIDTH - MOBILE_PADDING - width, Math.max(MOBILE_PADDING, rawLeft))
    const top = Math.max(MOBILE_PADDING, rawTop)
    const zIndex = typeof eff.zIndex === 'number' ? eff.zIndex : 1
    // 接近 351px 的组件视为手机全宽组件；导出后随真实视口宽度伸缩。
    const isFullWidth = width >= MOBILE_AVAIL_W - 8
    const responsiveWidth = isFullWidth
      ? `calc(100% - ${MOBILE_PADDING * 2}px)`
      : `min(${width}px, calc(100% - ${MOBILE_PADDING * 2}px))`
    const responsiveLeft = isFullWidth
      ? `${MOBILE_PADDING}px`
      : `clamp(${MOBILE_PADDING}px, ${left}px, calc(100% - ${MOBILE_PADDING + width}px))`

    wrapperRules.push(
      'position:absolute !important',
      `left:${responsiveLeft} !important`,
      `top:${top}px !important`,
      `width:${responsiveWidth} !important`,
      `max-width:calc(100% - ${MOBILE_PADDING * 2}px) !important`,
      `height:${height}px !important`,
      `z-index:${zIndex} !important`
    )
    if (eff.rotate !== undefined) wrapperRules.push(`transform:rotate(${eff.rotate}deg)`)
    if (eff.opacity !== undefined) wrapperRules.push(`opacity:${eff.opacity}`)

    // 移动端覆盖的视觉样式
    if (overrides) {
      const visual: string[] = []
      if (overrides.fontSize !== undefined) visual.push(`font-size:${overrides.fontSize}px !important`)
      if (overrides.fontWeight !== undefined) visual.push(`font-weight:${overrides.fontWeight} !important`)
      if (overrides.color !== undefined) visual.push(`color:${overrides.color} !important`)
      if (overrides.lineHeight !== undefined) visual.push(`line-height:${overrides.lineHeight} !important`)
      if (overrides.textAlign !== undefined) visual.push(`text-align:${overrides.textAlign} !important`)
      if (overrides.borderWidth !== undefined) visual.push(`border-width:${overrides.borderWidth}px !important`)
      if (overrides.borderColor !== undefined) visual.push(`border-color:${overrides.borderColor} !important`)
      if (overrides.borderRadius !== undefined) visual.push(`border-radius:${overrides.borderRadius}px !important`)

      if (overrides.backgroundColor !== undefined) {
        // Button/Input 背景色在子元素上，其余在 wrapper
        if (childSel) {
          childRules.push(`background:${overrides.backgroundColor} !important`)
        } else {
          wrapperRules.push(`background:${overrides.backgroundColor} !important`)
        }
      }

      // fontSize/color/fontWeight/lineHeight/textAlign/border* 根据组件类型分发
      if (childSel) {
        childRules.push(...visual)
      } else {
        wrapperRules.push(...visual)
      }
    }

    let css = `#comp-${sid}{${wrapperRules.join(';')}}`
    if (childSel && childRules.length > 0) {
      css += `\n    #comp-${sid}${childSel}{${childRules.join(';')}}`
    }
    return css
  }).join('\n    ')

  // 320~360px 小屏按视口比例收敛字体，减少因宽度变窄导致的额外换行和截断。
  const smallScreenTypographyCss = components.flatMap((comp) => {
    const c = comp as Record<string, unknown>
    const sid = safeId((c.id as string) || '')
    const type = c.type as string
    const style = c.style as Record<string, unknown>
    const overrides = (c.responsiveOverrides as Record<string, Record<string, unknown>> | undefined)?.mobile
    const eff = { ...style, ...(overrides || {}) }
    const fontSize = typeof eff.fontSize === 'number' ? eff.fontSize : 0
    if (!fontSize || !['Text', 'Button', 'Input'].includes(type)) return []
    const minFontSize = type === 'Text' && fontSize >= 24 ? Math.max(22, Math.round(fontSize * 0.8)) : Math.max(13, Math.round(fontSize * 0.84))
    const fluidFontSize = Number((fontSize / MOBILE_WIDTH * 100).toFixed(3))
    const selector = type === 'Button'
      ? `#comp-${sid} button`
      : type === 'Input'
        ? `#comp-${sid} input`
        : `#comp-${sid}`
    return [`${selector}{font-size:clamp(${minFontSize}px, ${fluidFontSize}vw, ${fontSize}px) !important;}`]
  }).join('\n    ')

  const mobileMediaQuery = `\n  @media (max-width: 768px) {\n    body{padding:16px 0;}\n    .page-container{width:min(100%, ${MOBILE_WIDTH}px) !important;max-width:${MOBILE_WIDTH}px;height:${MOBILE_HEIGHT}px !important;min-height:${MOBILE_HEIGHT}px;background:${MOBILE_BACKGROUND} !important;position:relative;display:block;padding:0;box-sizing:border-box;}\n    .page-container > *{position:absolute !important;}\n    ${mobileCss}\n  }\n  @media (max-width: ${MOBILE_SMALL_BREAKPOINT}px) {\n    body{padding:0;}\n    .page-container{width:100% !important;max-width:none;border-radius:0;box-shadow:none;}\n    .page-container > *{max-width:calc(100% - ${MOBILE_PADDING * 2}px) !important;}\n    ${smallScreenTypographyCss}\n  }`
  const chartOptionFactorySource = getChartOptionFactorySource()

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escAttr(meta.title as string) || '营销页面'}</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@6/dist/echarts.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; background: #f5f7fa; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .page-container { position: relative; overflow: hidden; border-radius: 24px; box-shadow: 0 16px 40px rgba(15,23,42,.08); }
    .page-container > * { position: absolute; }
    input::placeholder, textarea::placeholder { color: #c0c4cc; }
    input:focus, textarea:focus { border-color: #409eff !important; box-shadow: 0 0 0 2px rgba(64,158,255,.15); }
    ${mobileMediaQuery}
  </style>
</head>
<body>
  <div class="page-container" style="width:${pageStyle.width}px;height:${pageStyle.height}px;background:${pageStyle.backgroundColor || '#ffffff'}">
      ${componentsHtml}
  </div>
  <script>
    var buildChartOption = ${chartOptionFactorySource}
    document.querySelectorAll('[data-chart]').forEach(function(el) {
      try {
        var config = JSON.parse(el.getAttribute('data-chart').replace(/&#39;/g, "'"))
        if (config.data && config.data.length) {
          var chart = echarts.init(el)
          chart.setOption(buildChartOption(config), true)
          if (typeof ResizeObserver !== 'undefined') {
            var observer = new ResizeObserver(function() { chart.resize() })
            observer.observe(el)
          } else {
            window.addEventListener('resize', function() { chart.resize() })
          }
        }
      } catch(e) { console.error('Chart render error', e) }
    })
  <\/script>
</body>
</html>`
}

const editorStore = useEditorStore()
const historyStore = useHistoryStore()
const previewVisible = ref(false)
const aiGeneratorVisible = ref(false)

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        historyStore.redo()
      } else {
        historyStore.undo()
      }
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editorStore.currentComponent) {
      const tagName = (document.activeElement?.tagName || '').toLowerCase()
      if (tagName !== 'input' && tagName !== 'textarea') {
        e.preventDefault()
        editorStore.deleteComponent(editorStore.currentComponent.id)
      }
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})

const currentPage = computed(() => editorStore.currentPage)
const lastSavedAt = computed(() => editorStore.lastSavedAt)
const handleExport = () => {
  handleExportFormat('json')
}

const handleExportFormat = (format: string) => {
  if (format === 'html') {
    handleExportHTML()
  } else {
    handleExportJSON()
  }
}

const handleExportJSON = () => {
  const data = editorStore.exportPageData()
  if (!data) {
    ElMessage.warning('当前没有可导出的页面数据')
    return
  }

  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${currentPage.value?.meta.title || 'marketing-page'}.json`
  link.click()
  URL.revokeObjectURL(url)
}

const handleExportHTML = () => {
  const data = editorStore.exportPageData()
  if (!data) {
    ElMessage.warning('当前没有可导出的页面数据')
    return
  }

  const page = JSON.parse(data)
  const html = generateHTMLPage(page)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${page.meta.title || 'marketing-page'}.html`
  link.click()
  URL.revokeObjectURL(url)
}

const handleSave = () => {
  editorStore.persistPage()
  ElMessage.success('页面已持久化保存')
}

const handleNewPage = () => {
  editorStore.createNewPage('新的营销活动页')
  historyStore.clearHistory()
  ElMessage.success('已创建新页面')
}

const handleImport = async (file: UploadFile) => {
  const raw = file.raw
  if (!raw) return

  try {
    const text = await raw.text()
    const warnings = editorStore.importPageData(text)
    historyStore.clearHistory()
    editorStore.persistPage()
    ElMessage.success('页面 JSON 导入成功')
    if (warnings.length) {
      ElMessage.warning(`导入时已修复或跳过 ${warnings.length} 项：${warnings[0]}`)
    }
  } catch {
    ElMessage.error('导入失败，请检查页面 JSON 的结构与格式')
  }
}
</script>

<style scoped>
.page-editor-container { width: 100vw; height: 100vh; display: flex; flex-direction: column; background: #f7f8fa; overflow: hidden; }
.editor-header { height: 72px; padding: 0 20px; background: #ffffff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; }
.header-left h1 { margin: 0; font-size: 20px; color: #111827; }
.header-subtitle { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #6b7280; }
.header-center,.header-right { display: flex; align-items: center; gap: 10px; }
.editor-body { flex: 1; display: flex; overflow: hidden; }
.preview-shell { background: #f8fafc; padding: 20px; border-radius: 20px; }
.preview-device-bar { margin-bottom: 14px; font-size: 13px; font-weight: 700; color: #334155; }
.device-size { font-size: 11px; opacity: 0.7; margin-left: 4px; }
</style>
