import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { createLargeEditPlan } from '../../largeEditPlan'
import type { AIClarification, AIPageEditPlan } from '../../../src/types/aiPatch'
import { createLocalEditGraph, type LocalEditGraphDependencies } from './localEditGraph'
import { PageEditState, type PageEditStateUpdate, type PageEditStateValue } from './pageEditState'

export type LargeEditPlanner = (
  state: PageEditStateValue,
  signal?: AbortSignal
) => Promise<AIPageEditPlan | AIClarification>

export interface LargeEditGraphDependencies extends LocalEditGraphDependencies {
  planLargeEdit: LargeEditPlanner
}

export const createDefaultLargeEditPlanner = (config: {
  apiKey: string
  baseUrl: string
  model: string
}): LargeEditPlanner => async (state, signal) => {
  const componentTypes = state.draftPage.components.reduce<Record<string, number>>((counts, component) => {
    counts[component.type] = (counts[component.type] || 0) + 1
    return counts
  }, {})
  return createLargeEditPlan({
    request: state.originalRequest,
    componentCount: state.draftPage.components.length,
    componentTypes,
    pageSize: {
      width: state.draftPage.style.width,
      height: state.draftPage.style.height,
      mobileHeight: state.draftPage.responsiveOverrides?.mobile?.height ?? state.draftPage.style.height
    },
    conversationMemory: state.conversationMemory,
    recentMessages: state.recentMessages,
    ...config,
    signal: signal || new AbortController().signal
  })
}

const validatePlan = (value: AIPageEditPlan): string | null => {
  if (value.type !== 'page_edit_plan' || !value.planId?.trim() || !value.summary?.trim()) {
    return '大幅修改计划缺少标识或摘要。'
  }
  if (!Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 6) {
    return '大幅修改计划必须包含 2～6 个步骤。'
  }
  const ids = new Set<string>()
  for (const step of value.steps) {
    if (!step.id?.trim() || ids.has(step.id)) return '大幅修改计划包含空白或重复步骤 ID。'
    ids.add(step.id)
    if (!step.title?.trim() || !step.instruction?.trim()) return `计划步骤 ${step.id} 缺少标题或指令。`
    if (step.scope !== 'page' && step.scope !== 'components') return `计划步骤 ${step.id} 的范围无效。`
    if (!Number.isInteger(step.operationBudget) || step.operationBudget < 1 || step.operationBudget > 8) {
      return `计划步骤 ${step.id} 的操作预算必须为 1～8。`
    }
  }
  return null
}

const createPlanNode = (dependencies: LargeEditGraphDependencies) => async (
  state: PageEditStateValue,
  config?: RunnableConfig
): Promise<PageEditStateUpdate> => {
  try {
    const planned = await dependencies.planLargeEdit(state, config?.signal)
    if (planned.type === 'need_clarification') {
      return {
        status: 'clarification',
        result: { type: 'need_clarification', runId: state.runId, question: planned.question }
      }
    }
    const error = validatePlan(planned)
    if (error) {
      return {
        status: 'error',
        result: { type: 'error', runId: state.runId, code: 'INVALID_EDIT_PLAN', message: error }
      }
    }
    return { plan: planned, stepIndex: 0, status: 'running', result: null }
  } catch (error) {
    return {
      status: 'error',
      result: {
        type: 'error',
        runId: state.runId,
        code: 'EDIT_PLAN_FAILED',
        message: error instanceof Error ? error.message : '无法生成大幅修改计划。'
      }
    }
  }
}

export const createLargeEditGraph = (dependencies: LargeEditGraphDependencies) => {
  const localGraph = createLocalEditGraph(dependencies)

  const executeStepNode = async (
    state: PageEditStateValue,
    config?: RunnableConfig
  ): Promise<PageEditStateUpdate> => {
    const step = state.plan?.steps[state.stepIndex]
    if (!step) {
      return {
        status: 'error',
        result: { type: 'error', runId: state.runId, code: 'MISSING_PLAN_STEP', message: '找不到待执行的计划步骤。' }
      }
    }
    const output = await localGraph.invoke({
      ...state,
      request: step.instruction,
      operationLimit: step.operationBudget,
      status: 'running',
      activeComponentIndex: [],
      selectedComponentIds: [],
      currentPageContext: null,
      allowedOperationKinds: [],
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
        result: output.result || {
          type: 'error', runId: state.runId, code: 'STEP_EXECUTION_FAILED', message: `计划步骤 ${step.id} 未完成。`
        }
      }
    }
    return {
      draftPage: output.draftPage,
      operationCount: output.operationCount,
      warnings: output.warnings,
      stepIndex: state.stepIndex + 1,
      status: 'running',
      currentPatch: null,
      previousPatch: null,
      validationError: null,
      modelAttempt: 0,
      repairAttempt: 0,
      noOpRetry: 0,
      result: null
    }
  }

  const finalizeNode = (state: PageEditStateValue): PageEditStateUpdate => ({
    status: 'completed',
    result: {
      type: 'page_edit_completed',
      runId: state.runId,
      baseRevision: state.baseRevision,
      summary: state.plan?.summary || '完成大幅修改',
      page: state.draftPage,
      operationCount: state.operationCount,
      stepCount: state.plan?.steps.length || 0,
      warnings: state.warnings
    }
  })

  return new StateGraph(PageEditState)
    .addNode('createPlan', createPlanNode(dependencies))
    .addNode('executeStep', executeStepNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'createPlan')
    .addConditionalEdges('createPlan', (state) => state.result ? 'done' : 'execute', {
      done: END,
      execute: 'executeStep'
    })
    .addConditionalEdges('executeStep', (state) => {
      if (state.result) return 'done'
      return state.plan && state.stepIndex < state.plan.steps.length ? 'next' : 'finalize'
    }, { done: END, next: 'executeStep', finalize: 'finalize' })
    .addEdge('finalize', END)
    .compile()
}
