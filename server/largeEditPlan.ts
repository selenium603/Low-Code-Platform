import { compactStructuredValue, createLargeEditResponseSchema, strictResponseFormat } from './structuredSchemas'
import type { AIClarificationCode } from '../src/types/aiPatch'
import { analyzeEditActions } from './ai/graph/editActionAnalysis'

export interface LargeEditPlanStep {
  id: string
  title: string
  instruction: string
  scope: 'page' | 'components'
  operationBudget: number
  actionIds?: string[]
}

export interface LargeEditPlan {
  type: 'page_edit_plan'
  planId: string
  summary: string
  steps: LargeEditPlanStep[]
}

export interface LargeEditClarification {
  type: 'need_clarification'
  question: string
  clarificationCode: AIClarificationCode
}

interface PlanOptions {
  request: string
  componentCount: number
  componentTypes: Record<string, number>
  pageSize: { width: number; height: number; mobileHeight: number }
  conversationMemory: unknown
  recentMessages: unknown[]
  apiKey: string
  baseUrl: string
  model: string
  signal: AbortSignal
  canClarify: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const requestedComponentTarget = (request: string) => [...request.matchAll(
  /(\d+)\s*\+?\s*(?:个)?(?:组件|模块|卡片|元素)/g
)]
  .map((match) => Number(match[1]))
  .filter(Number.isFinite)
  .sort((first, second) => second - first)[0]

export const shouldPlanLargeEdit = (request: string, componentCount: number) => {
  if ((requestedComponentTarget(request) || 0) >= 13) return true
  if (/(?:新增|添加|创建|扩充).{0,10}(?:十几|十多|二十|三十|几十|大量|一批|一系列)(?:个)?(?:组件|模块|卡片|元素|区域)/i.test(request)) return true
  if (/(大幅|大改|大规模|复杂一点|更复杂|丰富.{0,6}(页面|内容)|重新设计|整体重构|整页重构|批量新增|多个(?:区域|模块|分区))/i.test(request)) return true
  return componentCount > 12 && /(全部|所有|整页|全局).{0,12}(修改|调整|替换|重排|统一)/i.test(request)
}

const parsePlan = (value: unknown): Omit<LargeEditPlan, 'planId'> | LargeEditClarification | null => {
  if (!isRecord(value)) return null
  if (value.type === 'need_clarification') {
    return typeof value.question === 'string' && value.question.trim()
      ? {
          type: 'need_clarification',
          question: value.question.trim().slice(0, 500),
          clarificationCode: ['TARGET_AMBIGUOUS', 'DELETION_AUTH_REQUIRED', 'GEOMETRY_RELAYOUT_AUTH_REQUIRED', 'CONFLICTING_REQUIREMENTS', 'MISSING_EXECUTION_DATA'].includes(String(value.clarificationCode))
            ? value.clarificationCode as AIClarificationCode
            : 'MISSING_EXECUTION_DATA'
        }
      : null
  }
  if (value.type !== 'page_edit_plan' || typeof value.summary !== 'string' || !Array.isArray(value.steps)) return null
  const rawSteps = value.steps.slice(0, 6)
  const steps = rawSteps.flatMap((rawStep, index) => {
    if (!isRecord(rawStep) || typeof rawStep.title !== 'string' || typeof rawStep.instruction !== 'string') return []
    const instruction = rawStep.instruction.trim().slice(0, 800)
    const addsComponents = analyzeEditActions(instruction).hasPositiveAdd
    const scope = addsComponents ? 'page' : rawStep.scope === 'components' ? 'components' : 'page'
    const touchesBothDevices = /(desktop|桌面|PC).{0,80}(mobile|手机|移动端)|(mobile|手机|移动端).{0,80}(desktop|桌面|PC)/i.test(instruction)
      && /(页面|画布).{0,20}(高度|尺寸)|updatePageStyle/i.test(instruction)
    const operationBudget = Math.max(
      touchesBothDevices ? 2 : 1,
      Math.min(8, Math.round(Number(rawStep.operationBudget) || 6))
    )
    return [{
      id: typeof rawStep.id === 'string' && rawStep.id.trim() ? rawStep.id.trim().slice(0, 40) : `step-${index + 1}`,
      title: rawStep.title.trim().slice(0, 80),
      instruction,
      scope,
      operationBudget
    } satisfies LargeEditPlanStep]
  })
  if (!steps.length || steps.length !== rawSteps.length) return null
  return { type: 'page_edit_plan', summary: value.summary.trim().slice(0, 300), steps }
}

export const createLargeEditPlan = async (options: PlanOptions): Promise<LargeEditPlan | LargeEditClarification> => {
  const overflowRule = options.canClarify
    ? '若用户目标无法在 48 个操作内完成，应询问用户缩小范围。'
    : '若用户目标无法在 48 个操作内完成，必须保守缩小为当前轮可安全完成的范围，不得再次询问用户。'
  const system = `你是低代码页面“大幅修改”的任务规划器。只输出 JSON，不生成页面 Schema，不生成 Patch。

严格输出统一信封对象：
1. 计划：{"type":"page_edit_plan","summary":"总体目标","steps":[...],"question":null,"clarificationCode":null}
2. 澄清：{"type":"need_clarification","summary":null,"steps":null,"question":"缺少关键信息时只问一个问题","clarificationCode":"MISSING_EXECUTION_DATA"}

规则：把任务拆成 2～6 步，每步预计 1～8 个 Patch 操作，总操作最多 48；每个 instruction 必须自包含，说明组件数量、类型、文案方向、桌面区域和手机端顺序，不能使用“继续上一步”等模糊指代。可用组件只有 Text、Image、Button、Input、Form、Chart，不存在 Container、Icon 或组件组。新增大量组件时，第一步必须先用 updatePageStyle 分别扩展 desktop/mobile 页面高度，后续每步新增不超过 operationBudget 且最多 8 个组件；新增、添加、创建组件的步骤 scope 必须使用 page。修改现有组件时 scope 使用 components。优先按首屏、卖点、数据、案例、转化等语义分区拆分。不要在计划中输出具体 JSON 操作。${overflowRule}`
  const context = {
    request: options.request,
    currentPage: {
      componentCount: options.componentCount,
      componentTypes: options.componentTypes,
      size: options.pageSize
    },
    conversationMemory: options.conversationMemory,
    recentMessages: options.recentMessages
  }
  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${JSON.stringify(context)}${lastError ? `\n上次计划无效：${lastError}。请缩短并输出完整 JSON。` : ''}` }
        ],
        reasoning: { enabled: false },
        response_format: strictResponseFormat('large_page_edit_plan', createLargeEditResponseSchema(options.canClarify)),
        temperature: 0.1,
        max_tokens: attempt === 1 ? 1100 : 1400
      }),
      signal: options.signal
    })
    if (!response.ok) {
      const payload = await response.json() as { error?: { message?: string }; message?: string }
      throw new Error(payload.error?.message || payload.message || `规划请求失败（${response.status}）`)
    }
    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
    }
    const choice = payload.choices?.[0]
    if (choice?.finish_reason === 'length') {
      lastError = '输出达到 token 上限，JSON 被截断'
      continue
    }
    try {
      const parsed = choice?.message?.content
        ? parsePlan(compactStructuredValue(JSON.parse(choice.message.content)))
        : null
      if (parsed?.type === 'need_clarification') return parsed
      if (parsed?.type === 'page_edit_plan') {
        const requestedTarget = requestedComponentTarget(options.request)
        const steps = [...parsed.steps]
        if (requestedTarget && requestedTarget > options.componentCount) {
          const requiredAdds = requestedTarget - options.componentCount
          const isPageSetupStep = (step: LargeEditPlanStep) => /updatePageStyle|扩展.{0,12}(页面|画布).{0,12}(高度|尺寸)/i.test(step.instruction)
          const hasPageSetup = steps.some(isPageSetupStep)
          if (!hasPageSetup) {
            steps.unshift({
              id: 'step-page-size',
              title: '扩展双端页面空间',
              instruction: `分别使用两个 updatePageStyle 操作，将 desktop 页面高度扩展到至少 ${Math.max(options.pageSize.height, 3600)}px，将 mobile 页面高度扩展到至少 ${Math.max(options.pageSize.mobileHeight, requestedTarget * 132)}px。`,
              scope: 'page',
              operationBudget: 2
            })
          }
          if (steps.length > 6) steps.splice(6)
          let addSteps = steps.filter((step) => !isPageSetupStep(step) && /(新增|添加|创建|扩充)/.test(step.instruction))
          while (addSteps.length * 8 < requiredAdds && steps.length < 6) {
            const sequence = addSteps.length + 1
            const filler: LargeEditPlanStep = {
              id: `step-extra-${sequence}`,
              title: `补充营销内容 ${sequence}`,
              instruction: '在页面后续空白区域新增一批与整体风格一致的营销组件，优先补充标题、说明、图片、数据或转化按钮；桌面端按网格排列，手机端按阅读顺序单列排列。',
              scope: 'page',
              operationBudget: 8
            }
            steps.push(filler)
            addSteps = [...addSteps, filler]
          }
          if (!addSteps.length || addSteps.length * 8 < requiredAdds) {
            lastError = `最多 6 个步骤无法安全增加 ${requiredAdds} 个组件`
            continue
          }
          let remainingAdds = requiredAdds
          addSteps.forEach((step, index) => {
            const remainingSteps = addSteps.length - index
            const targetAdds = Math.min(8, Math.max(1, Math.ceil(remainingAdds / remainingSteps)))
            step.scope = 'page'
            step.operationBudget = targetAdds
            step.instruction = `${step.instruction.replace(/\s*scope\s*:.*/i, '').slice(0, 620)} 本步骤严格只输出 ${targetAdds} 个 addComponent 操作，不执行其他操作；每个组件同时提供不重叠的 desktop style 和 mobileStyle。`
            remainingAdds -= targetAdds
          })
        }
        return {
          ...parsed,
          steps,
          planId: `plan_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
        }
      }
      lastError = '缺少有效步骤'
    } catch (error) {
      lastError = error instanceof Error ? `JSON 不完整：${error.message}` : 'JSON 不完整'
    }
  }
  throw new Error(`无法生成完整的大改计划：${lastError}`)
}
