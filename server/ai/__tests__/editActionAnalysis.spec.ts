import { describe, expect, it } from 'vitest'

import { ComponentType } from '../../../src/types'
import { analyzeEditActions, isPureAddRequest } from '../graph/editActionAnalysis'
import { requiresSemanticActionAnalysis } from '../graph/editSemanticAnalysis'

describe('edit action analysis', () => {
  it.each([
    ['放张图片', ComponentType.IMAGE],
    ['加两张产品图', ComponentType.IMAGE],
    ['插入一段文字', ComponentType.TEXT]
  ])('recognizes %s as a pure add request', (request, type) => {
    const result = analyzeEditActions(request)
    expect(result.isPureAdd).toBe(true)
    expect(result.positiveAddTypes).toContain(type)
  })

  it('leaves colloquial 来 requests to semantic analysis', () => {
    expect(isPureAddRequest('来个按钮')).toBe(false)
  })

  it('does not match 来 inside an ordinary word', () => {
    expect(isPureAddRequest('把原来的按钮改成红色')).toBe(false)
  })

  it.each([
    '添加图片，不要替换现有图片',
    '不要替换，也不要删除，只要加图片',
    '新增按钮并保持现有按钮不变'
  ])('keeps negated destructive actions out of %s', (request) => {
    expect(isPureAddRequest(request)).toBe(true)
  })

  it.each([
    '替换现有图片',
    '新增图片并删除旧图',
    '添加按钮并换掉旧按钮'
  ])('does not classify destructive request %s as pure add', (request) => {
    expect(isPureAddRequest(request)).toBe(false)
  })

  it.each(['把按钮加宽', '放大图片'])('does not confuse property adjustment %s with addition', (request) => {
    expect(isPureAddRequest(request)).toBe(false)
  })

  it.each(['附加说明', '播放按钮', '增加宽度'])('does not match embedded single-character add verb in %s', (request) => {
    expect(isPureAddRequest(request)).toBe(false)
  })

  it('binds component types to the action-local span', () => {
    const deletion = analyzeEditActions('保留图片并删除按钮').mentions.find((mention) => mention.kind === 'delete')
    expect(deletion?.componentTypes).toEqual([ComponentType.BUTTON])
  })

  it.each([
    '来个按钮',
    '保留图片并删除按钮',
    '不要删除图片，只删除按钮',
    '除了图片，修改其余组件的颜色',
    '删除页脚按钮，并把主标题改成红色'
  ])('routes complex semantic request %s to action analysis', (request) => {
    expect(requiresSemanticActionAnalysis(request)).toBe(true)
  })
})
