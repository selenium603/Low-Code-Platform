const CJK_OR_WIDE_CHARACTER = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uffef]/

/**
 * 根据文本、可用宽度和排版参数估算完整显示文本所需的最小高度。
 * 这里使用偏保守的字符宽度，宁可多留半行空间，也不要让画布和导出页截断文字。
 */
export const estimateTextHeight = (
  content: unknown,
  width: number | undefined,
  fontSize: number | undefined,
  lineHeight: number | undefined,
  minimumHeight = 40
) => {
  const text = typeof content === 'string' && content.length ? content : '文本内容'
  const safeFontSize = Math.max(8, typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : 14)
  const safeLineHeight = Math.max(1, typeof lineHeight === 'number' && Number.isFinite(lineHeight) ? lineHeight : 1.5)
  // TextComponent 水平方向各 8px padding，额外预留 2px 避免浏览器小数像素换行差异。
  const availableWidth = Math.max(safeFontSize, (typeof width === 'number' && Number.isFinite(width) ? width : 120) - 18)
  const unitsPerLine = Math.max(1, availableWidth / safeFontSize)
  const lines = text.split(/\r?\n/).reduce((total, paragraph) => {
    if (!paragraph) return total + 1
    let units = 0
    for (const character of paragraph) {
      if (/\s/.test(character)) units += 0.34
      else if (CJK_OR_WIDE_CHARACTER.test(character)) units += 1
      else if (/[A-Z0-9]/.test(character)) units += 0.66
      else if (/[.,:;!'\"|`ijlI]/.test(character)) units += 0.32
      else units += 0.56
    }
    return total + Math.max(1, Math.ceil(units / unitsPerLine))
  }, 0)
  // TextComponent 垂直方向各 4px padding，再留 2px 抵消字体 ascender/descender 差异。
  return Math.max(minimumHeight, Math.ceil(lines * safeFontSize * safeLineHeight + 10))
}
