import { END, START, StateGraph } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'

import { applyAIPagePatch } from '../../../src/domain/pagePatchExecutor'
import type { AIPagePatch } from '../../../src/types/aiPatch'
import {
  compactStructuredValue,
  createEditResponseSchema,
  strictResponseFormat
} from '../../structuredSchemas'
import type { OpenRouterClient } from '../model/openRouterClient'
import { createLocateComponentsNode, type LocateComponentsDependencies } from './locateComponents'
import { hasEffectivePageChange } from './pageChange'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'
import { validateGeneratedEditResponse } from './patchPolicy'

export interface LocalEditGraphDependencies extends LocateComponentsDependencies {
  modelClient: Pick<OpenRouterClient, 'completeStructured'>
}

const safeIdPart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')

const createGeneratePatchNode = (dependencies: LocalEditGraphDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  const allowedIds = new Set(state.selectedComponentIds)
  const allowedOperationKinds = new Set(state.allowedOperationKinds)
  const responseSchema = createEditResponseSchema(
    state.draftPage.components.map((component) => ({ id: component.id, type: component.type })),
    {
      baseRevision: state.baseRevision,
      operationLimit: state.operationLimit,
      allowedComponentIds: state.editScope === 'components' ? allowedIds : new Set<string>(),
      allowedOperationKinds
    }
  )
  const repairInstruction = state.validationError && state.previousPatch
    ? `上次 Patch 未生效或应用失败：${state.validationError}。上次 Patch：${JSON.stringify(state.previousPatch)}。必须保留用户目标并修正失败原因。`
    : state.validationError
      ? `上次结构化结果无效：${state.validationError}。`
      : ''
  const system = `你是低代码页面增量修改代理。只输出 strict JSON，不生成完整页面。必须使用当前允许的稳定组件 ID；只执行授权操作；目标有歧义时返回 need_clarification。新增组件由应用生成 ID。baseRevision 必须原样返回 ${state.baseRevision}。`

  try {
    const completion = await dependencies.modelClient.completeStructured({
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            request: state.request,
            originalRequest: state.originalRequest,
            baseRevision: state.baseRevision,
            conversationMemory: state.conversationMemory,
            recentMessages: state.recentMessages,
            componentIndex: state.activeComponentIndex,
            currentPage: state.currentPageContext,
            plan: state.plan,
            stepIndex: state.stepIndex,
            repairInstruction
          })
        }
      ],
      responseFormat: strictResponseFormat('page_edit_response', responseSchema),
      signal: config?.signal,
      temperature: 0.1,
      maxTokens: Math.min(4200, Math.max(2000, 1200 + state.operationLimit * 320))
    })
    const checked = validateGeneratedEditResponse(compactStructuredValue(completion.value), state)
    if (!checked.result) {
      return {
        currentPatch: null,
        validationError: checked.error || 'Patch 校验失败。',
        modelAttempt: state.modelAttempt + 1
      }
    }
    if (checked.result.type === 'need_clarification') {
      return {
        status: 'clarification',
        modelAttempt: state.modelAttempt + 1,
        result: { type: 'need_clarification', runId: state.runId, question: checked.result.question }
      }
    }
    return {
      currentPatch: checked.result,
      validationError: null,
      modelAttempt: state.modelAttempt + 1
    }
  } catch (error) {
    return {
      currentPatch: null,
      validationError: error instanceof Error ? error.message : '模型请求失败。',
      modelAttempt: state.modelAttempt + 1
    }
  }
}

const applyPatchNode = (state: PageEditStateValue): PageEditStateUpdate => {
  const patch = state.currentPatch
  if (!patch) return { validationError: '缺少可执行 Patch。' }
  try {
    const applied = applyAIPagePatch(state.draftPage, patch, state.baseRevision, {
      now: state.startedAt,
      createComponentId: (operationIndex) => (
        `comp_ai_${safeIdPart(state.runId)}_${state.stepIndex}_${operationIndex}`
      )
    })
    if (!hasEffectivePageChange(state.draftPage, applied.page)) {
      const validationError = '上次 Patch 执行后没有改变任何页面业务数据，请生成会实际改变目标内容或样式的新 Patch。'
      if (state.noOpRetry < 1) {
        return {
          previousPatch: patch,
          currentPatch: null,
          validationError,
          noOpRetry: state.noOpRetry + 1,
          modelAttempt: 0,
          status: 'running',
          result: null
        }
      }
      return {
        status: 'error',
        validationError,
        result: {
          type: 'error',
          runId: state.runId,
          code: 'NO_EFFECTIVE_PATCH_CHANGE',
          message: 'AI 连续两次生成了没有实际效果的修改，请补充更具体的目标后重试。'
        }
      }
    }
    const warnings = [...state.warnings, ...applied.warnings]
    return {
      draftPage: applied.page,
      validationError: null,
      operationCount: state.operationCount + applied.patch.operations.length,
      warnings,
      status: 'completed',
      result: {
        type: 'page_edit_completed',
        runId: state.runId,
        baseRevision: state.baseRevision,
        summary: applied.patch.summary,
        page: applied.page,
        operationCount: state.operationCount + applied.patch.operations.length,
        stepCount: state.plan?.steps.length || 1,
        warnings
      }
    }
  } catch (error) {
    const validationError = error instanceof Error ? error.message : '页面副本校验失败。'
    if (state.repairAttempt < 1) {
      return {
        previousPatch: patch,
        currentPatch: null,
        validationError,
        repairAttempt: state.repairAttempt + 1,
        modelAttempt: 0
      }
    }
    return {
      status: 'error',
      validationError,
      result: {
        type: 'error',
        runId: state.runId,
        code: 'PATCH_APPLICATION_FAILED',
        message: `AI 修改连续两次校验失败：${validationError}`
      }
    }
  }
}

const failGenerationNode = (state: PageEditStateValue): PageEditStateUpdate => ({
  status: 'error',
  result: {
    type: 'error',
    runId: state.runId,
    code: 'INVALID_AI_PATCH',
    message: `AI 未能生成可安全执行的增量修改：${state.validationError || '未知错误'}`
  }
})

const afterLocate = (state: PageEditStateValue) => state.result ? 'done' : 'generate'
const afterGenerate = (state: PageEditStateValue) => {
  if (state.result) return 'done'
  if (state.currentPatch) return 'apply'
  return state.modelAttempt < 2 ? 'retry' : 'fail'
}
const afterApply = (state: PageEditStateValue) => state.result ? 'done' : 'repair'

export const createLocalEditGraph = (dependencies: LocalEditGraphDependencies) => new StateGraph(PageEditState)
  .addNode('locateComponents', createLocateComponentsNode(dependencies))
  .addNode('generatePatch', createGeneratePatchNode(dependencies))
  .addNode('applyPatch', applyPatchNode)
  .addNode('failGeneration', failGenerationNode)
  .addEdge(START, 'locateComponents')
  .addConditionalEdges('locateComponents', afterLocate, { done: END, generate: 'generatePatch' })
  .addConditionalEdges('generatePatch', afterGenerate, {
    done: END,
    apply: 'applyPatch',
    retry: 'generatePatch',
    fail: 'failGeneration'
  })
  .addConditionalEdges('applyPatch', afterApply, { done: END, repair: 'generatePatch' })
  .addEdge('failGeneration', END)
  .compile()

export const isPagePatch = (value: unknown): value is AIPagePatch => (
  Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'page_patch')
)
