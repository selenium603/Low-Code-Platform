import { ComponentType } from '../../../src/types'

export type EditActionKind = 'add' | 'replace' | 'delete'

export interface EditActionMention {
  kind: EditActionKind
  negated: boolean
  componentTypes: ComponentType[]
  rawClause: string
  action: string
  start: number
  end: number
}

export interface EditActionAnalysis {
  mentions: EditActionMention[]
  positiveAddTypes: ComponentType[]
  positiveDestructiveTypes: ComponentType[]
  hasPositiveAdd: boolean
  hasPositiveDestructive: boolean
  isPureAdd: boolean
}

const CLAUSE_SEPARATOR = /[，,。；;！!？?\n]+/
const NEGATION_BEFORE_ACTION = /(?:不要再?|别|禁止|无需|不能|不允许|不用|不再)(?:.{0,4})$/i
const actionPatterns: Array<{ kind: EditActionKind; pattern: RegExp }> = [
  {
    kind: 'add',
    // “来”不进入确定性快速路径；“来个按钮”交给语义模型处理，避免命中“原来的按钮”。
    pattern: /新增|添加|加入|插入|创建|放(?:上|入)?|加(?:上|入)?|\b(?:add|create|insert)\b/gi
  },
  { kind: 'replace', pattern: /替换|换掉|换成|\breplace\b/gi },
  { kind: 'delete', pattern: /删除|移除|删掉|删去|去掉|\b(?:remove|delete)\b/gi }
]

const componentPatterns: Array<[ComponentType, RegExp]> = [
  [ComponentType.CHART, /图表|数据图|chart/i],
  [ComponentType.FORM, /表单|form/i],
  [ComponentType.BUTTON, /按钮|按键|cta|button/i],
  [ComponentType.IMAGE, /图片|图像|照片|截图|主视觉|image|图(?!表)/i],
  [ComponentType.INPUT, /输入框|输入项|input/i],
  [ComponentType.TEXT, /标题|正文|文本|文字|文案|段落|text/i]
]

export const detectComponentTypes = (text: string) => componentPatterns
  .filter(([, pattern]) => pattern.test(text))
  .map(([type]) => type)

const SINGLE_ADD_PREFIX = /(?:^|[\s，,。；;！!？?、]|请|要|想|再|就|只要|帮我|给我)$/
const SINGLE_ADD_TARGET = /^(?:一|两|几|些|个|张|幅|块|组|套|条|段|点|上|入)*(?:图表|数据图|表单|按钮|按键|图片|图像|照片|截图|主视觉|产品图|营销图|背景图|装饰图|输入框|输入项|标题|正文|文本|文字|文案|段落|chart|form|button|image|input|text)/i

const actionIsHighConfidence = (clause: string, index: number, action: string) => {
  if (!/^(?:加|放)/.test(action)) return true
  const prefix = clause.slice(0, index)
  const suffix = clause.slice(index + action.length).trimStart()
  return SINGLE_ADD_PREFIX.test(prefix) && SINGLE_ADD_TARGET.test(suffix)
}

const uniqueTypes = (types: ComponentType[]) => [...new Set(types)]

export const analyzeEditActions = (request: string): EditActionAnalysis => {
  const clauses = request.trim().replace(/\s+/g, ' ').split(CLAUSE_SEPARATOR).map((item) => item.trim()).filter(Boolean)
  const mentions: EditActionMention[] = []

  for (const clause of clauses) {
    const clauseMatches: Array<{ kind: EditActionKind; action: string; index: number; end: number }> = []
    for (const { kind, pattern } of actionPatterns) {
      pattern.lastIndex = 0
      for (const match of clause.matchAll(pattern)) {
        const action = match[0]
        const index = match.index ?? 0
        if (kind === 'add' && !actionIsHighConfidence(clause, index, action)) continue
        clauseMatches.push({ kind, action, index, end: index + action.length })
      }
    }
    clauseMatches.sort((left, right) => left.index - right.index || right.action.length - left.action.length)
    const deduplicated = clauseMatches.filter((match, index, all) => (
      !all.slice(0, index).some((previous) => previous.index <= match.index && previous.end >= match.end)
    ))
    deduplicated.forEach((match, index) => {
      const nextActionStart = deduplicated[index + 1]?.index ?? clause.length
      const localTail = clause.slice(match.end, nextActionStart)
      const boundary = localTail.search(/(?:并且|并|同时|然后|再|以及|和|但|而|、)/)
      const actionText = boundary >= 0 ? localTail.slice(0, boundary) : localTail
      const prefix = clause.slice(Math.max(0, match.index - 12), match.index)
      mentions.push({
        kind: match.kind,
        negated: NEGATION_BEFORE_ACTION.test(prefix),
        componentTypes: detectComponentTypes(actionText),
        rawClause: clause,
        action: match.action,
        start: match.index,
        end: match.end
      })
    })
  }

  const positiveAdds = mentions.filter((mention) => mention.kind === 'add' && !mention.negated && mention.componentTypes.length)
  const positiveDestructive = mentions.filter((mention) => mention.kind !== 'add' && !mention.negated)
  const positiveAddTypes = uniqueTypes(positiveAdds.flatMap((mention) => mention.componentTypes))
  const positiveDestructiveTypes = uniqueTypes(positiveDestructive.flatMap((mention) => mention.componentTypes))

  return {
    mentions,
    positiveAddTypes,
    positiveDestructiveTypes,
    hasPositiveAdd: positiveAddTypes.length > 0,
    hasPositiveDestructive: positiveDestructive.length > 0,
    isPureAdd: positiveAddTypes.length > 0 && positiveDestructive.length === 0
  }
}

export const isPureAddRequest = (request: string) => analyzeEditActions(request).isPureAdd
