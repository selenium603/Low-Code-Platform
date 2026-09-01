import type { RunnableConfig } from '@langchain/core/runnables'

import { ComponentType } from '../../../src/types'
import type { AIEditActionScope, AIEditTaskState } from '../../../src/types/aiPatch'
import { compactStructuredValue, createEditSemanticAnalysisSchema, strictResponseFormat } from '../../structuredSchemas'
import { buildAIComponentIndex } from '../context/componentIndex'
import type { OpenRouterClient } from '../model/openRouterClient'
import { createProposal } from './autonomousFallback'
import { analyzeEditActions } from './editActionAnalysis'
import type { PageEditStateUpdate, PageEditStateValue } from './pageEditState'

type StructuredClient = Pick<OpenRouterClient, 'completeStructured'>
type ActionScopedTask = Pick<AIEditTaskState, 'actionScopes'>

const PRESERVE_CONSTRAINT = /保留|保持.{0,8}不变|不要动|别动|除了|除去|其余|剩下|(?:不要|别|禁止|不允许).{0,6}(?:删除|移除|删掉|删去|去掉)/
const SEMANTIC_ADD = /来(?:一|两|几|些|个|张|幅|块|组|套|条|段)/
const UPDATE_ACTION = /修改|调整|改成|改为|变成|变为|设置|放大|缩小|加宽|变窄|上移|下移|左移|右移|移动/g
const NEGATION_BEFORE_ACTION = /(?:不要再?|别|禁止|无需|不能|不允许|不用|不再)(?:.{0,4})$/i
const actionKinds = new Set<AIEditActionScope['kind']>(['add', 'update', 'replace', 'delete', 'preserve'])
const componentTypes = new Set<string>(Object.values(ComponentType))

const positiveUpdateCount = (request: string) => [...request.matchAll(UPDATE_ACTION)].filter((match) => {
  const index = match.index ?? 0
  return !NEGATION_BEFORE_ACTION.test(request.slice(Math.max(0, index - 12), index))
}).length

/**
 * 快速规则只处理高置信度单动作。组合动作、保留/排除约束以及规则无法
 * 表达的口语化新增请求进入结构化语义层。
 */
export const requiresSemanticActionAnalysis = (request: string) => {
  const analysis = analyzeEditActions(request)
  const positiveMentions = analysis.mentions.filter((mention) => !mention.negated)
  const positiveKinds = new Set(positiveMentions.map((mention) => mention.kind))
  const updateCount = positiveUpdateCount(request)
  if (updateCount) positiveKinds.add('replace')
  const actionCount = positiveMentions.length + updateCount
  const hasPositiveDestructive = positiveMentions.some((mention) => mention.kind === 'delete' || mention.kind === 'replace')
  const hasScopedMutation = hasPositiveDestructive || updateCount > 0
  return SEMANTIC_ADD.test(request)
    || actionCount > 1
    || positiveKinds.size > 1
    || (PRESERVE_CONSTRAINT.test(request) && hasScopedMutation)
}

export const editTargetIdsFor = (task: ActionScopedTask | null | undefined) => [...new Set(
  (task?.actionScopes || [])
    .filter((action) => action.kind === 'update' || action.kind === 'replace')
    .flatMap((action) => action.targetComponentIds)
)]

export const deleteTargetIdsFor = (task: ActionScopedTask | null | undefined) => [...new Set(
  (task?.actionScopes || [])
    .filter((action) => action.kind === 'delete')
    .flatMap((action) => action.targetComponentIds)
)]

export const preserveTargetIdsFor = (task: ActionScopedTask | null | undefined) => [...new Set(
  (task?.actionScopes || [])
    .filter((action) => action.kind === 'preserve')
    .flatMap((action) => action.targetComponentIds)
)]

export const contextTargetIdsFor = (task: ActionScopedTask | null | undefined) => [...new Set([
  ...editTargetIdsFor(task),
  ...deleteTargetIdsFor(task),
  ...preserveTargetIdsFor(task)
])]

export const taskHasAddAction = (task: ActionScopedTask | null | undefined) => (
  (task?.actionScopes || []).some((action) => action.kind === 'add')
)

export const taskHasPageEditAction = (task: ActionScopedTask | null | undefined) => (
  (task?.actionScopes || []).some((action) => (
    action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace')
  ))
)

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
)

const semanticFailure = (state: PageEditStateValue, message: string): PageEditStateUpdate => ({
  status: 'error',
  draftPage: state.originalPage,
  result: {
    type: 'execution_failed',
    runId: state.runId,
    code: 'SEMANTIC_ACTION_ANALYSIS_FAILED',
    message: `暂时无法可靠理解这项组合修改：${message}`,
    retryable: true,
    pendingTask: state.pendingTask
  }
})

export const createEditSemanticAnalysisNode = (dependencies: { modelClient: StructuredClient }) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  if (!state.task || state.task.actionScopes.length) return {}
  if (!requiresSemanticActionAnalysis(state.request)
    && state.routingSource === 'rule'
    && state.task.intent !== 'large_edit'
    && state.task.intent !== 'full_relayout') return {}

  const index = buildAIComponentIndex(state.originalPage)
  const knownIds = new Set(index.map((component) => component.id))
  const typeById = new Map(index.map((component) => [component.id, component.type]))
  const positiveDeleteEvidence = analyzeEditActions(state.request).mentions
    .some((mention) => mention.kind === 'delete' && !mention.negated)
  let lastError = '语义模型没有返回有效结果。'

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await dependencies.modelClient.completeStructured({
        messages: [
          {
            role: 'system',
            content: `你是页面编辑的复杂动作作用域分析器，只解释用户明确表达的动作和目标，不生成 Patch、页面或执行计划。
把组合要求拆成 add、update、replace、delete、preserve 动作。preserve 表示不得修改或删除的约束。每个 components 动作只能选择候选中真实存在的稳定 ID；add 使用 page scope 且 componentIds 为空。large_edit 必须拆成 2～6 个可以独立执行、且各自不超过 8 个 Patch 操作的动作，不得再交给后续规划器二次拆分。full_relayout 使用 page scope 的 update/replace 表达整页修改；只有用户明确要求删除时才额外生成 delete action。
删除动作只能来自用户明确的正向删除要求；“保留/不要删除”不得转换为 delete。不同动作必须保留各自独立目标，例如“删除页脚按钮，并把主标题改红”必须产生两个 action。无法确定唯一目标或数量范围时返回 need_clarification。`
          },
          {
            role: 'user',
            content: JSON.stringify({
              request: state.request,
              originalRequest: state.originalRequest,
              candidates: index,
              clarificationUsed: state.task.clarificationUsed
            })
          }
        ],
        responseFormat: strictResponseFormat(
          'page_edit_semantic_actions',
          createEditSemanticAnalysisSchema([...knownIds])
        ),
        signal: config?.signal,
        temperature: 0,
        maxTokens: 1_200,
        timeoutMs: 8_000
      })
      const value = compactStructuredValue(completion.value)
      if (!isRecord(value)) throw new Error('语义结果不是 JSON 对象。')
      if (value.type === 'need_clarification') {
        if (typeof value.question !== 'string' || !value.question.trim()) throw new Error('语义澄清问题为空。')
        return {
          clarificationProposals: [createProposal({
            source: 'semantic_analyzer',
            code: value.clarificationCode === 'CONFLICTING_REQUIREMENTS' ? 'CONFLICTING_REQUIREMENTS' : 'TARGET_AMBIGUOUS',
            question: value.question.trim().slice(0, 500),
            blocking: true,
            hasSafeFallback: false,
            affectedComponentCount: 0,
            fallback: { kind: 'return_no_change', message: '组合修改的动作目标仍不明确，本次未提交修改。' }
          })]
        }
      }
      if (value.type !== 'semantic_actions' || !Array.isArray(value.actions) || !value.actions.length) {
        throw new Error('语义结果缺少动作列表。')
      }

      const scopes: AIEditActionScope[] = value.actions.map((raw, actionIndex) => {
        if (!isRecord(raw) || !actionKinds.has(raw.kind as AIEditActionScope['kind'])) {
          throw new Error('语义动作类型无效。')
        }
        const kind = raw.kind as AIEditActionScope['kind']
        const targetScope = raw.targetScope === 'page' ? 'page' : raw.targetScope === 'components' ? 'components' : null
        const ids = Array.isArray(raw.componentIds)
          ? [...new Set(raw.componentIds.filter((id): id is string => typeof id === 'string'))]
          : []
        const types = Array.isArray(raw.componentTypes)
          ? [...new Set(raw.componentTypes.filter((type): type is ComponentType => componentTypes.has(String(type))))]
          : []
        if (!targetScope || ids.some((id) => !knownIds.has(id))) throw new Error('语义动作引用了页面之外的组件。')
        if (targetScope === 'components' && !ids.length) throw new Error('组件动作没有唯一目标。')
        if (targetScope === 'page' && ids.length) throw new Error('页面动作不得携带组件 ID。')
        if (kind === 'add' && targetScope !== 'page') throw new Error('新增动作必须使用页面作用域。')
        if (kind === 'delete' && !positiveDeleteEvidence) throw new Error('模型生成了用户未明确授权的删除动作。')
        if (types.length && ids.some((id) => !types.includes(typeById.get(id) as ComponentType))) {
          throw new Error('语义动作的组件类型与目标 ID 不一致。')
        }
        const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim().slice(0, 500) : ''
        if (!instruction) throw new Error('语义动作缺少原始要求。')
        return {
          actionId: typeof raw.actionId === 'string' && raw.actionId.trim()
            ? raw.actionId.trim().slice(0, 80)
            : `action-${actionIndex + 1}`,
          kind,
          instruction,
          targetScope,
          componentTypes: targetScope === 'components'
            ? [...new Set(ids.map((id) => typeById.get(id) as ComponentType))]
            : types,
          targetComponentIds: ids,
          candidateComponentIds: []
        }
      })
      const allTargetIds = [...new Set(scopes.flatMap((scope) => scope.targetComponentIds))]
      if (new Set(scopes.map((scope) => scope.actionId)).size !== scopes.length) {
        throw new Error('语义动作包含重复 actionId。')
      }
      if (allTargetIds.length > 12) throw new Error('组合修改涉及超过 12 个组件。')
      const executableActions = scopes.filter((scope) => scope.kind !== 'preserve')
      if (state.task.intent === 'large_edit' && (executableActions.length < 2 || executableActions.length > 6)) {
        throw new Error('大幅修改必须拆成 2～6 个独立动作。')
      }
      const preserved = new Set(scopes.filter((scope) => scope.kind === 'preserve').flatMap((scope) => scope.targetComponentIds))
      const conflicts = scopes
        .filter((scope) => scope.kind !== 'preserve')
        .flatMap((scope) => scope.targetComponentIds)
        .filter((id) => preserved.has(id))
      if (conflicts.length) {
        return {
          clarificationProposals: [createProposal({
            source: 'semantic_analyzer',
            code: 'CONFLICTING_REQUIREMENTS',
            question: '同一组件同时被要求保留和修改，请说明以哪项要求为准。',
            blocking: true,
            hasSafeFallback: false,
            affectedComponentCount: new Set(conflicts).size,
            fallback: { kind: 'return_no_change', message: '保留与修改要求冲突，本次未提交修改。' }
          })]
        }
      }
      return {
        task: { ...state.task, actionScopes: scopes },
        selectedComponentIds: contextTargetIdsFor({ ...state.task, actionScopes: scopes })
      }
    } catch (error) {
      if (config?.signal?.aborted) throw error
      lastError = error instanceof Error ? error.message.slice(0, 300) : '未知语义分析错误'
    }
  }
  return semanticFailure(state, lastError)
}
