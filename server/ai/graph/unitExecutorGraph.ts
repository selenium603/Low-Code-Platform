import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { applyAIPagePatch, GeometryConflictError, validateFullPageGeometry } from '../../../src/domain/pagePatchExecutor'
import type { AIEditActionScope } from '../../../src/types/aiPatch'
import { compactStructuredValue, createEditResponseSchema, strictResponseFormat } from '../../structuredSchemas'
import type { OpenRouterClient } from '../model/openRouterClient'
import { createProposal } from './autonomousFallback'
import { deleteTargetIdsFor, editTargetIdsFor, taskHasPageEditAction } from './editSemanticAnalysis'
import {
  currentExecutionUnit,
  requestForExecutionUnit,
  taskForExecutionUnit
} from './executionUnits'
import { createExecutionUnitContext } from './executionContext'
import { hasEffectivePageChange } from './pageChange'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'
import { validateGeneratedEditResponse } from './patchPolicy'

export interface UnitExecutorDependencies {
  modelClient: Pick<OpenRouterClient, 'completeStructured'>
}

const safeIdPart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')

const activateUnitNode = (state: PageEditStateValue): PageEditStateUpdate => {
  const unit = currentExecutionUnit(state)
  if (!unit) {
    return {
      status: 'error',
      result: {
        type: 'execution_failed', runId: state.runId, code: 'MISSING_EXECUTION_UNIT',
        message: '找不到待执行的 Execution Unit。', retryable: true, pendingTask: state.pendingTask
      }
    }
  }
  return {
    ...createExecutionUnitContext(state),
    operationLimit: Math.min(unit.operationBudget, state.executionPolicy?.operationLimit || 12),
    status: 'running',
    result: null
  }
}

const createGeneratePatchNode = (dependencies: UnitExecutorDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  const unit = currentExecutionUnit(state)
  const scopedTask = taskForExecutionUnit(state.task, unit)
  if (!unit || !scopedTask) {
    return { validationError: '缺少当前 Execution Unit 或任务。', modelAttempt: state.modelAttempt + 1 }
  }
  const allowedIds = new Set(state.selectedComponentIds)
  const semanticEditIds = editTargetIdsFor(scopedTask)
  const allowedSemanticEditIds = taskHasPageEditAction(scopedTask) && state.intent === 'full_relayout'
    ? state.selectedComponentIds
    : semanticEditIds.filter((id) => allowedIds.has(id))
  const semanticDeleteIds = new Set(deleteTargetIdsFor(scopedTask))
  const allowedDeleteIds = new Set((state.executionPolicy?.deleteAuthorization.componentIds || []).filter((id) => (
    allowedIds.has(id) && semanticDeleteIds.has(id)
  )))
  const responseSchema = createEditResponseSchema(
    state.draftPage.components.map((component) => ({ id: component.id, type: component.type })),
    {
      baseRevision: state.baseRevision,
      operationLimit: state.operationLimit,
      allowedComponentIds: state.editScope === 'components' ? allowedIds : new Set<string>(),
      allowedEditComponentIds: scopedTask.actionScopes.length ? new Set(allowedSemanticEditIds) : undefined,
      allowedDeleteComponentIds: allowedDeleteIds,
      allowedOperationKinds: new Set(state.allowedOperationKinds),
      canClarify: state.executionPolicy?.canClarify !== false
    }
  )
  const repairInstruction = state.validationError && state.previousPatch
    ? `上次 Patch 未生效或应用失败：${state.validationError}。上次 Patch：${JSON.stringify(state.previousPatch)}。必须保留用户目标并修正失败原因；若错误代码为 GEOMETRY_CONFLICT，应依据其中的设备、组件矩形和相邻组件调整尺寸或相对位置，不得重复原坐标。`
    : state.validationError ? `上次结构化结果无效：${state.validationError}。` : ''
  const unitRequest = requestForExecutionUnit(scopedTask, unit, state.unitIndex, state.executionUnits.length)
  const system = `你是低代码页面增量修改代理。只输出 strict JSON，不生成完整页面。必须使用当前 Execution Unit 允许的稳定组件 ID；只执行授权操作；新增组件由应用生成 ID。baseRevision 必须原样返回 ${state.baseRevision}。
当目标组件已唯一确定，用户要求优化、美化、调整或变得协调时，颜色、样式、尺寸、位置和间距等未指定参数由你根据当前页面配色、画布边界、相邻组件和视觉层级自主决定；缺少精确色值、像素或坐标不属于必须澄清的歧义，必须生成实际 Patch。
${state.executionPolicy?.canClarify === false
    ? '业务澄清预算已用完，必须在授权范围内生成安全 Patch；不得请求再次澄清，也不得扩大目标或删除未授权组件。'
    : '仅当目标确实无法区分、删除授权不明确、要求互相冲突或缺少构造合法 Patch 的必要业务数据时返回 need_clarification。'}`
  try {
    const completion = await dependencies.modelClient.completeStructured({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({
          request: unitRequest,
          originalRequest: state.originalRequest,
          task: scopedTask,
          executionUnit: unit,
          executionPolicy: state.executionPolicy,
          baseRevision: state.baseRevision,
          conversationMemory: state.conversationMemory,
          recentMessages: state.recentMessages,
          componentIndex: state.activeComponentIndex,
          currentPage: state.currentPageContext,
          repairInstruction
        }) }
      ],
      responseFormat: strictResponseFormat('page_edit_response', responseSchema),
      signal: config?.signal,
      temperature: 0.1,
      maxTokens: Math.min(4200, Math.max(2000, 1200 + state.operationLimit * 320))
    })
    const checked = validateGeneratedEditResponse(compactStructuredValue(completion.value), state)
    if (!checked.result) {
      return { currentPatch: null, validationError: checked.error || 'Patch 校验失败。', modelAttempt: state.modelAttempt + 1 }
    }
    if (checked.result.type === 'need_clarification') {
      const code = checked.result.clarificationCode
      const fallback = code === 'DELETION_AUTH_REQUIRED'
        ? { kind: 'limit_execution' as const, operationLimit: Math.min(4, state.operationLimit) }
        : code === 'CONFLICTING_REQUIREMENTS'
          ? { kind: 'return_no_change' as const, message: '当前要求互相冲突，无法确定安全修改子集。' }
          : { kind: 'use_model_defaults' as const, allowedComponentIds: [...state.selectedComponentIds] }
      return {
        clarificationProposals: [createProposal({
          source: 'patch_generator', code, question: checked.result.question,
          blocking: true, hasSafeFallback: fallback.kind !== 'return_no_change',
          affectedComponentCount: state.selectedComponentIds.length, fallback
        })],
        modelAttempt: state.modelAttempt + 1
      }
    }
    return { currentPatch: checked.result, validationError: null, modelAttempt: state.modelAttempt + 1 }
  } catch (error) {
    if (config?.signal?.aborted) throw error
    return {
      currentPatch: null,
      validationError: error instanceof Error ? error.message : '模型请求失败。',
      modelAttempt: state.modelAttempt + 1
    }
  }
}

const expandGeometryScope = (state: PageEditStateValue, affectedComponentIds: string[]): {
  task: PageEditStateValue['task']
  executionUnits: PageEditStateValue['executionUnits']
} => {
  const unit = currentExecutionUnit(state)
  if (!state.task || !unit) return { task: state.task, executionUnits: state.executionUnits }
  const actionIds = new Set(unit.actionIds)
  const updateIndex = state.task.actionScopes.findIndex((action) => (
    actionIds.has(action.actionId) && (action.kind === 'update' || action.kind === 'replace')
  ))
  let actionScopes: AIEditActionScope[]
  let nextActionIds = unit.actionIds
  if (updateIndex >= 0) {
    actionScopes = state.task.actionScopes.map((action, index) => index === updateIndex
      ? { ...action, targetComponentIds: [...new Set([...action.targetComponentIds, ...affectedComponentIds])], candidateComponentIds: [] }
      : action)
  } else {
    const actionId = `geometry-repair-${unit.id}`
    actionScopes = [...state.task.actionScopes, {
      actionId, kind: 'update', instruction: '在已授权区域内修复布局冲突。', targetScope: 'components',
      componentTypes: [], targetComponentIds: affectedComponentIds, candidateComponentIds: []
    }]
    nextActionIds = [...unit.actionIds, actionId]
  }
  return {
    task: { ...state.task, actionScopes, delegatedToModel: true },
    executionUnits: state.executionUnits.map((candidate, index) => index === state.unitIndex
      ? {
          ...candidate,
          actionIds: nextActionIds,
          componentIds: [...new Set([...candidate.componentIds, ...affectedComponentIds])].slice(0, 12),
          allowPageStyle: true
        }
      : candidate)
  }
}

const applyPatchNode = (state: PageEditStateValue): PageEditStateUpdate => {
  const patch = state.currentPatch
  if (!patch) return { validationError: '缺少可执行 Patch。' }
  try {
    const applied = applyAIPagePatch(state.draftPage, patch, state.baseRevision, {
      now: state.startedAt,
      createComponentId: (operationIndex) => `comp_ai_${safeIdPart(state.runId)}_${state.unitIndex}_${operationIndex}`
    })
    if (!hasEffectivePageChange(state.draftPage, applied.page)) {
      const validationError = '上次 Patch 执行后没有改变任何页面业务数据，请生成会实际改变目标内容或样式的新 Patch。'
      if (state.noOpRetry < 1) {
        return {
          previousPatch: patch, currentPatch: null, validationError,
          noOpRetry: state.noOpRetry + 1, modelAttempt: 0, status: 'running', result: null
        }
      }
      return {
        status: 'completed', validationError,
        result: { type: 'no_change', runId: state.runId, message: '本次 AI 操作没有产生有效页面变化，页面保持不变。', retryable: true }
      }
    }
    return {
      draftPage: applied.page,
      validationError: null,
      operationCount: state.operationCount + applied.patch.operations.length,
      warnings: [...state.warnings, ...applied.warnings],
      unitSummaries: [...state.unitSummaries, applied.patch.summary],
      unitIndex: state.unitIndex + 1,
      currentPatch: null,
      previousPatch: null,
      modelAttempt: 0,
      repairAttempt: 0,
      noOpRetry: 0,
      geometryRepairAttempt: 0,
      needsRelocate: false,
      status: 'running',
      result: null
    }
  } catch (error) {
    const geometryError = error instanceof GeometryConflictError ? error : null
    const errorMessage = error instanceof Error ? error.message : '页面副本校验失败。'
    const validationError = geometryError
      ? JSON.stringify({
          code: 'GEOMETRY_CONFLICT', message: errorMessage, conflicts: geometryError.conflicts,
          affectedComponentIds: geometryError.affectedComponentIds, devices: geometryError.devices
        })
      : errorMessage
    if (geometryError) {
      const allAffectedComponentIds = [...new Set([...state.selectedComponentIds, ...geometryError.affectedComponentIds])]
      const affectedComponentIds = allAffectedComponentIds.slice(0, 12)
      if (!state.executionPolicy?.allowRegionalRelayout || geometryError.overflow) {
        const names = affectedComponentIds
          .map((id) => state.draftPage.components.find((component) => component.id === id)?.name)
          .filter((name): name is string => Boolean(name))
        const location = [...new Set(geometryError.devices)]
          .map((device) => device === 'mobile' ? '手机端' : '桌面端').join('和')
        const question = geometryError.overflow
          ? '这次布局调整的冲突闭包超过 12 个组件，已经超出单次安全自动修复范围。是否缩小修改范围后再继续？'
          : `为了完成这次调整，需要在${location || '当前页面'}同时微调${names.slice(0, 4).map((name) => `“${name}”`).join('、') || '目标附近组件'}。是否允许我在这片区域内统一调整，并在提交前重新校验？`
        const fallback = !geometryError.overflow && allAffectedComponentIds.length <= 12
          ? { kind: 'limit_geometry_scope' as const, allowedComponentIds: affectedComponentIds, maxAffectedComponents: 12 as const }
          : { kind: 'return_no_change' as const, message: '布局调整影响范围超过 12 个组件，本次未提交修改。请缩小范围后重试。' }
        return {
          clarificationProposals: [createProposal({
            source: 'geometry_validator', code: 'GEOMETRY_RELAYOUT_AUTH_REQUIRED', question,
            blocking: true, hasSafeFallback: fallback.kind !== 'return_no_change',
            affectedComponentCount: geometryError.overflow ? 13 : allAffectedComponentIds.length, fallback
          })],
          validationError
        }
      }
      if (state.geometryRepairAttempt < 1) {
        const expanded = expandGeometryScope(state, affectedComponentIds)
        return {
          ...expanded,
          previousPatch: patch,
          currentPatch: null,
          validationError,
          geometryRepairAttempt: state.geometryRepairAttempt + 1,
          modelAttempt: 0,
          needsRelocate: true,
          selectedComponentIds: affectedComponentIds,
          status: 'running',
          result: null
        }
      }
      return {
        status: 'completed', validationError,
        result: { type: 'no_change', runId: state.runId, message: '已尝试在授权区域内修复布局，但仍无法得到无碰撞结果。本次修改未提交。', retryable: true }
      }
    }
    if (state.repairAttempt < 1) {
      return {
        previousPatch: patch, currentPatch: null, validationError,
        repairAttempt: state.repairAttempt + 1, modelAttempt: 0
      }
    }
    return {
      status: 'error', validationError,
      result: {
        type: 'execution_failed', runId: state.runId, code: 'PATCH_APPLICATION_FAILED',
        message: `AI 修改连续两次校验失败：${validationError}`, retryable: true, pendingTask: state.pendingTask
      }
    }
  }
}

const failGenerationNode = (state: PageEditStateValue): PageEditStateUpdate => ({
  status: 'error',
  result: {
    type: 'execution_failed', runId: state.runId, code: 'INVALID_AI_PATCH',
    message: `AI 未能生成可安全执行的增量修改：${state.validationError || '未知错误'}`,
    retryable: true, pendingTask: state.pendingTask
  }
})

const finalizeNode = (state: PageEditStateValue): PageEditStateUpdate => {
  try {
    if (state.intent === 'full_relayout') validateFullPageGeometry(state.draftPage)
    return {
      status: 'completed',
      result: {
        type: 'page_edit_completed', runId: state.runId, baseRevision: state.baseRevision,
        summary: state.unitSummaries.join('；').slice(0, 300) || '完成页面修改',
        page: state.draftPage, operationCount: state.operationCount,
        stepCount: state.executionUnits.length, warnings: state.warnings
      }
    }
  } catch (error) {
    return {
      status: 'error',
      result: {
        type: 'execution_failed', runId: state.runId, code: 'FULL_PAGE_GEOMETRY_FAILED',
        message: `整页最终校验失败，未提交任何修改：${error instanceof Error ? error.message : '未知错误'}`,
        retryable: true, pendingTask: state.pendingTask
      }
    }
  }
}

const afterActivate = (state: PageEditStateValue) => state.result ? 'done' : 'generate'
const afterGenerate = (state: PageEditStateValue) => {
  if (state.result || state.clarificationProposals.length) return 'done'
  if (state.currentPatch) return 'apply'
  return state.modelAttempt < 2 ? 'retry' : 'fail'
}
const afterApply = (state: PageEditStateValue) => {
  if (state.result || state.clarificationProposals.length) return 'done'
  if (state.needsRelocate) return 'relocate'
  if (state.validationError) return 'repair'
  return state.unitIndex < state.executionUnits.length ? 'next' : 'finalize'
}

export const createUnitExecutorGraph = (dependencies: UnitExecutorDependencies) => new StateGraph(PageEditState)
  .addNode('activateUnit', activateUnitNode)
  .addNode('generatePatch', createGeneratePatchNode(dependencies))
  .addNode('applyPatch', applyPatchNode)
  .addNode('failGeneration', failGenerationNode)
  .addNode('finalize', finalizeNode)
  .addEdge(START, 'activateUnit')
  .addConditionalEdges('activateUnit', afterActivate, { done: END, generate: 'generatePatch' })
  .addConditionalEdges('generatePatch', afterGenerate, {
    done: END, apply: 'applyPatch', retry: 'generatePatch', fail: 'failGeneration'
  })
  .addConditionalEdges('applyPatch', afterApply, {
    done: END, relocate: 'activateUnit', repair: 'generatePatch', next: 'activateUnit', finalize: 'finalize'
  })
  .addEdge('failGeneration', END)
  .addEdge('finalize', END)
  .compile()
