import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { validateFullPageGeometry } from '../../../src/domain/pagePatchExecutor'
import { compactStructuredValue, strictResponseFormat } from '../../structuredSchemas'
import { createFullRelayoutGroups } from '../context/fullRelayoutGroups'
import { createLocalEditGraph, type LocalEditGraphDependencies } from './localEditGraph'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'

export interface FullRelayoutGraphDependencies extends LocalEditGraphDependencies {}

const relayoutPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'summary', 'allowDeletion'],
  properties: {
    type: { type: 'string', enum: ['full_relayout_plan'] },
    summary: { type: 'string', minLength: 1, maxLength: 300 },
    allowDeletion: { type: 'boolean' }
  }
}

const createPlanNode = (dependencies: FullRelayoutGraphDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  try {
    const completion = await dependencies.modelClient.completeStructured({
      messages: [
        {
          role: 'system',
          content: '你是整页重构规划器，只决定总体摘要和是否必须删除现有组件，不生成 Patch。仅当保留组件会明确违背用户目标时 allowDeletion=true。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            request: state.originalRequest,
            componentCount: state.draftPage.components.length,
            componentIndex: state.draftPage.components.map((item) => ({ id: item.id, type: item.type, name: item.name }))
          })
        }
      ],
      responseFormat: strictResponseFormat('full_relayout_plan', relayoutPlanSchema),
      signal: config?.signal,
      temperature: 0,
      maxTokens: 500
    })
    const value = compactStructuredValue(completion.value) as Record<string, unknown>
    if (value.type !== 'full_relayout_plan' || typeof value.summary !== 'string' || !value.summary.trim() || typeof value.allowDeletion !== 'boolean') {
      throw new Error('整页规划结果无效。')
    }
    const groups = createFullRelayoutGroups(state.draftPage)
    return {
      relayoutGroups: groups.map((group) => group.componentIds),
      relayoutAllowDeletion: value.allowDeletion,
      relayoutSummary: value.summary.trim().slice(0, 300),
      stepIndex: 0,
      status: 'running'
    }
  } catch (error) {
    return {
      status: 'error',
      result: {
        type: 'error', runId: state.runId, code: 'FULL_RELAYOUT_PLAN_FAILED',
        message: error instanceof Error ? error.message : '无法生成整页重构计划。'
      }
    }
  }
}

export const createFullRelayoutGraph = (dependencies: FullRelayoutGraphDependencies) => {
  const localGraph = createLocalEditGraph(dependencies)

  const executeGroupNode = async (state: PageEditStateValue, config?: RunnableConfig): Promise<PageEditStateUpdate> => {
    const componentIds = state.relayoutGroups[state.stepIndex]
    if (!componentIds?.length) {
      return { status: 'error', result: { type: 'error', runId: state.runId, code: 'MISSING_RELAYOUT_GROUP', message: '整页重构分组缺失。' } }
    }
    const output = await localGraph.invoke({
      ...state,
      request: `${state.originalRequest}\n当前为确定性分组 ${state.stepIndex + 1}/${state.relayoutGroups.length}，只处理这些稳定 ID：${componentIds.join(', ')}。`,
      selectedComponentIds: componentIds,
      operationLimit: 8,
      status: 'running',
      currentPatch: null,
      previousPatch: null,
      validationError: null,
      modelAttempt: 0,
      repairAttempt: 0,
      noOpRetry: 0,
      result: null
    }, config)
    if (output.result?.type !== 'page_edit_completed') {
      return {
        draftPage: output.draftPage,
        operationCount: output.operationCount,
        warnings: output.warnings,
        status: output.status,
        result: output.result || { type: 'error', runId: state.runId, code: 'RELAYOUT_GROUP_FAILED', message: '整页重构分组执行失败。' }
      }
    }
    return {
      draftPage: output.draftPage,
      operationCount: output.operationCount,
      warnings: output.warnings,
      stepIndex: state.stepIndex + 1,
      status: 'running',
      result: null
    }
  }

  const finalizeNode = (state: PageEditStateValue): PageEditStateUpdate => {
    try {
      validateFullPageGeometry(state.draftPage)
      return {
        status: 'completed',
        result: {
          type: 'page_edit_completed', runId: state.runId, baseRevision: state.baseRevision,
          summary: state.relayoutSummary, page: state.draftPage, operationCount: state.operationCount,
          stepCount: state.relayoutGroups.length, warnings: state.warnings
        }
      }
    } catch (error) {
      return {
        status: 'error',
        result: {
          type: 'error', runId: state.runId, code: 'FULL_PAGE_GEOMETRY_FAILED',
          message: `整页最终校验失败，未提交任何修改：${error instanceof Error ? error.message : '未知错误'}`
        }
      }
    }
  }

  return new StateGraph(PageEditState)
    .addNode('planRelayout', createPlanNode(dependencies))
    .addNode('executeGroup', executeGroupNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'planRelayout')
    .addConditionalEdges('planRelayout', (state) => state.result ? 'done' : 'execute', { done: END, execute: 'executeGroup' })
    .addConditionalEdges('executeGroup', (state) => {
      if (state.result) return 'done'
      return state.stepIndex < state.relayoutGroups.length ? 'next' : 'finalize'
    }, { done: END, next: 'executeGroup', finalize: 'finalize' })
    .addEdge('finalize', END)
    .compile()
}
