import type { AIClarification, AIPagePatch } from '../../../src/types/aiPatch'
import { isPureAddRequest } from './editActionAnalysis'
import { deleteTargetIdsFor, editTargetIdsFor } from './editSemanticAnalysis'
import type { PageEditStateValue } from './pageEditState'

const businessCodes = new Set(['TARGET_AMBIGUOUS', 'DELETION_AUTH_REQUIRED', 'GEOMETRY_RELAYOUT_AUTH_REQUIRED', 'CONFLICTING_REQUIREMENTS', 'MISSING_EXECUTION_DATA'])

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const validateGeneratedEditResponse = (
  value: unknown,
  state: PageEditStateValue
): { result?: AIPagePatch | AIClarification; error?: string } => {
  if (!isRecord(value)) return { error: '模型未返回 JSON 对象。' }
  if (value.type === 'need_clarification') {
    if (state.executionPolicy?.canClarify === false) return { error: '业务澄清预算已用完，模型不得再次请求澄清。' }
    if (typeof value.question !== 'string' || !value.question.trim()) return { error: '澄清问题为空。' }
    return {
      result: {
        type: 'need_clarification',
        question: value.question.trim().slice(0, 500),
        clarificationCode: businessCodes.has(String(value.clarificationCode))
          ? value.clarificationCode as AIClarification['clarificationCode']
          : 'MISSING_EXECUTION_DATA'
      }
    }
  }
  if (value.type !== 'page_patch') return { error: '返回类型必须是 page_patch 或 need_clarification。' }
  if (value.baseRevision !== state.baseRevision) return { error: `Patch 的 baseRevision 必须为 ${state.baseRevision}。` }
  if (typeof value.summary !== 'string' || !value.summary.trim()) return { error: 'Patch 缺少修改摘要。' }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > state.operationLimit) {
    return { error: `Patch 必须包含 1～${state.operationLimit} 个操作。` }
  }

  const pageIds = new Set(state.draftPage.components.map((component) => component.id))
  const selectedIds = new Set(state.selectedComponentIds)
  const hasSemanticScopes = Boolean(state.task?.actionScopes?.length)
  const scopedEditIds = new Set(editTargetIdsFor(state.task))
  const scopedDeleteIds = new Set(deleteTargetIdsFor(state.task))
  const allowedKinds = new Set(state.allowedOperationKinds)
  const componentOperations = new Set(['updateProps', 'updateStyle', 'placeRelative', 'removeComponent', 'moveLayer'])
  const knownOperations = new Set([
    'updateProps', 'updateStyle', 'updatePageStyle', 'placeRelative', 'addComponent', 'removeComponent', 'moveLayer'
  ])

  for (const operation of value.operations) {
    if (!isRecord(operation) || !knownOperations.has(String(operation.op))) {
      return { error: `包含不支持的操作“${String(isRecord(operation) ? operation.op : '')}”。` }
    }
    const kind = String(operation.op)
    if (kind === 'removeComponent' && !state.executionPolicy?.deleteAuthorization.componentIds.includes(String(operation.componentId))) {
      return { error: '用户没有明确授权删除组件。' }
    }
    if (kind === 'removeComponent' && hasSemanticScopes && !scopedDeleteIds.has(String(operation.componentId))) {
      return { error: '删除操作超出了对应 delete action 的授权范围。' }
    }
    if (isPureAddRequest(state.request) && kind !== 'addComponent' && kind !== 'updatePageStyle') {
      return { error: `纯新增任务不允许执行 ${kind}。` }
    }
    if (allowedKinds.size && !allowedKinds.has(kind)) return { error: `当前修改范围不允许执行 ${kind}。` }
    if (componentOperations.has(kind)) {
      if (typeof operation.componentId !== 'string' || !pageIds.has(operation.componentId)) {
        return { error: `操作 ${kind} 引用了不存在的 componentId。` }
      }
      if (!selectedIds.has(operation.componentId)) return { error: `操作 ${kind} 超出了已授权组件范围。` }
      if (hasSemanticScopes && kind !== 'removeComponent' && !scopedEditIds.has(operation.componentId)) {
        return { error: `操作 ${kind} 超出了对应修改 action 的授权范围。` }
      }
    }
    if (kind === 'placeRelative') {
      if (typeof operation.targetId !== 'string' || !pageIds.has(operation.targetId)) {
        return { error: 'placeRelative 引用了不存在的 targetId。' }
      }
      if (!selectedIds.has(operation.targetId)) return { error: 'placeRelative 的目标超出了已授权组件范围。' }
    }
  }

  return {
    result: {
      type: 'page_patch',
      baseRevision: state.baseRevision,
      summary: value.summary.trim().slice(0, 300),
      operations: value.operations
    } as AIPagePatch
  }
}
