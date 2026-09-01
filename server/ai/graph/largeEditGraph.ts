import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { createLargeEditPlan } from '../../largeEditPlan'
import type { AIClarification, AIPageEditPlan } from '../../../src/types/aiPatch'
import { createProposal } from './autonomousFallback'
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
  const planned = await createLargeEditPlan({
    request: state.request,
    componentCount: state.draftPage.components.length,
    componentTypes,
    pageSize: {
      width: state.draftPage.style.width,
      height: state.draftPage.style.height,
      mobileHeight: state.draftPage.responsiveOverrides?.mobile?.height ?? state.draftPage.style.height
    },
    conversationMemory: state.conversationMemory,
    recentMessages: state.recentMessages,
    canClarify: state.executionPolicy?.canClarify !== false,
    ...config,
    signal: signal || new AbortController().signal
  })
  if (planned.type !== 'page_edit_plan') return planned
  const maxPlanSteps = state.executionPolicy?.maxPlanSteps || 6
  const operationLimit = state.executionPolicy?.operationLimit || 12
  return {
    ...planned,
    steps: planned.steps.slice(0, maxPlanSteps).map((step) => ({
      ...step,
      operationBudget: Math.min(step.operationBudget, operationLimit)
    }))
  }
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
  const scopedActions = (state.task?.actionScopes || []).filter((action) => action.kind !== 'preserve')
  if (scopedActions.length >= 2 && scopedActions.length <= 6) {
    return {
      plan: {
        type: 'page_edit_plan',
        planId: `semantic-${state.task?.taskId || state.runId}`,
        summary: '按已确认的独立动作范围完成组合修改',
        steps: scopedActions.map((action, index) => ({
          id: action.actionId || `action-${index + 1}`,
          title: action.instruction.slice(0, 80),
          instruction: action.instruction,
          scope: action.targetScope,
          operationBudget: Math.min(8, state.executionPolicy?.operationLimit || 12),
          actionIds: [action.actionId]
        }))
      },
      stepIndex: 0,
      status: 'running',
      result: null
    }
  }
  try {
    const planned = await dependencies.planLargeEdit(state, config?.signal)
    if (planned.type === 'need_clarification') {
      const code = planned.clarificationCode
      return { clarificationProposals: [createProposal({
        source: 'large_edit_planner', code, question: planned.question,
        blocking: true, hasSafeFallback: true, affectedComponentCount: state.draftPage.components.length,
        fallback: { kind: 'use_conservative_plan', maxSteps: 2, operationLimit: 8 }
      })] }
    }
    const error = validatePlan(planned)
    if (error) {
      return {
        status: 'error',
        result: { type: 'execution_failed', runId: state.runId, code: 'INVALID_EDIT_PLAN', message: error, retryable: true, pendingTask: state.pendingTask }
      }
    }
    return { plan: planned, stepIndex: 0, status: 'running', result: null }
  } catch (error) {
    return {
      status: 'error',
      result: {
        type: 'execution_failed',
        runId: state.runId,
        code: 'EDIT_PLAN_FAILED',
        message: error instanceof Error ? error.message : '无法生成大幅修改计划。',
        retryable: true,
        pendingTask: state.pendingTask
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
        result: { type: 'execution_failed', runId: state.runId, code: 'MISSING_PLAN_STEP', message: '找不到待执行的计划步骤。', retryable: true, pendingTask: state.pendingTask }
      }
    }
    const output = await localGraph.invoke({
      ...state,
      request: step.instruction,
      task: state.task && step.actionIds?.length
        ? {
            ...state.task,
            actionScopes: [
              ...(state.task.actionScopes || []).filter((action) => action.kind === 'preserve'),
              ...(state.task.actionScopes || []).filter((action) => step.actionIds?.includes(action.actionId))
            ]
          }
        : state.task,
      operationLimit: Math.min(step.operationBudget, state.executionPolicy?.operationLimit || 12),
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
      geometryRepairAttempt: 0,
      needsRelocate: false,
      clarificationProposals: [],
      executionCheckpoint: null,
      result: null
    }, config)

    if (output.clarificationProposals.length) {
      return {
        draftPage: output.draftPage,
        operationCount: output.operationCount,
        warnings: output.warnings,
        clarificationProposals: output.clarificationProposals,
        executionCheckpoint: output.executionCheckpoint,
        task: output.task,
        status: 'running',
        result: null
      }
    }
    if (output.result?.type !== 'page_edit_completed') {
      return {
        draftPage: output.draftPage,
        operationCount: output.operationCount,
        warnings: output.warnings,
        status: output.status,
        result: output.result || {
          type: 'execution_failed', runId: state.runId, code: 'STEP_EXECUTION_FAILED', message: `计划步骤 ${step.id} 未完成。`, retryable: true, pendingTask: state.pendingTask
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
      geometryRepairAttempt: 0,
      needsRelocate: false,
      clarificationProposals: [],
      executionCheckpoint: null,
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
    .addConditionalEdges(START, (state) => (
      state.executionCheckpoint?.branch === 'large_edit' && state.plan ? 'resume' : 'plan'
    ), { resume: 'executeStep', plan: 'createPlan' })
    .addConditionalEdges('createPlan', (state) => state.result || state.clarificationProposals.length ? 'done' : 'execute', {
      done: END,
      execute: 'executeStep'
    })
    .addConditionalEdges('executeStep', (state) => {
      if (state.result || state.clarificationProposals.length) return 'done'
      return state.plan && state.stepIndex < state.plan.steps.length ? 'next' : 'finalize'
    }, { done: END, next: 'executeStep', finalize: 'finalize' })
    .addEdge('finalize', END)
    .compile()
}
