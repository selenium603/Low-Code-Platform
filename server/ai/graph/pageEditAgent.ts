import type { RunnableConfig } from '@langchain/core/runnables'
import { END, START, StateGraph } from '@langchain/langgraph'

import { createFullRelayoutGraph, type FullRelayoutGraphDependencies } from './fullRelayoutGraph'
import { classifyPageEditIntent } from './intentRouter'
import { createLargeEditGraph, type LargeEditGraphDependencies } from './largeEditGraph'
import { createLocalEditGraph } from './localEditGraph'
import { createContextIntentNode, createToolIntentNode, type ModelIntentRouterDependencies } from './modelIntentRouter'
import { hasEffectivePageChange } from './pageChange'
import { PageEditState, type PageEditStateValue } from './pageEditState'

export interface PageEditAgentDependencies extends FullRelayoutGraphDependencies, LargeEditGraphDependencies, ModelIntentRouterDependencies {}

export const createPageEditAgent = (dependencies: PageEditAgentDependencies) => {
  const localGraph = createLocalEditGraph(dependencies)
  const largeGraph = createLargeEditGraph(dependencies)
  const fullGraph = createFullRelayoutGraph(dependencies)
  const invoke = (graph: { invoke(state: PageEditStateValue, config?: RunnableConfig): Promise<PageEditStateValue> }) => (
    state: PageEditStateValue,
    config?: RunnableConfig
  ) => graph.invoke(state, config)

  const ruleIntentNode = (state: PageEditStateValue) => {
    const intent = classifyPageEditIntent(state.originalRequest, state.draftPage.components.length)
    const unresolved = intent === 'unresolved'
    const traceOutcome: 'fallback' | 'resolved' = unresolved ? 'fallback' : 'resolved'
    return {
      intent,
      status: 'running' as const,
      routingSource: unresolved ? null : 'rule' as const,
      routingReason: unresolved
        ? '确定性规则未获得足够证据。'
        : `确定性规则命中 ${intent}。`,
      clarificationQuestion: null,
      routingTrace: [
        ...(state.routingTrace || []),
        {
          source: 'rule' as const,
          outcome: traceOutcome,
          reason: unresolved ? '确定性规则未获得足够证据。' : `确定性规则命中 ${intent}。`
        }
      ]
    }
  }
  const verifyEffectiveChange = (state: PageEditStateValue) => {
    if (state.result?.type !== 'page_edit_completed') return {}
    if (hasEffectivePageChange(state.originalPage, state.draftPage)) return {}
    return {
      status: 'error' as const,
      result: {
        type: 'error' as const,
        runId: state.runId,
        code: 'NO_EFFECTIVE_PAGE_CHANGE',
        message: '本次 AI 操作没有产生有效页面修改，请补充更具体的目标后重试。'
      }
    }
  }

  return new StateGraph(PageEditState)
    .addNode('ruleIntent', ruleIntentNode)
    .addNode('contextIntent', createContextIntentNode(dependencies))
    .addNode('toolIntent', createToolIntentNode(dependencies))
    .addNode('localEdit', invoke(localGraph))
    .addNode('largeEdit', invoke(largeGraph))
    .addNode('fullRelayout', invoke(fullGraph))
    .addNode('question', (state) => ({
      status: 'clarification' as const,
      result: {
        type: 'need_clarification' as const,
        runId: state.runId,
        question: state.clarificationQuestion
          || '当前入口用于修改页面。请说明希望修改的组件、内容、布局或页面样式。'
      }
    }))
    .addNode('verifyEffectiveChange', verifyEffectiveChange)
    .addEdge(START, 'ruleIntent')
    .addConditionalEdges('ruleIntent', (state) => state.intent, {
      local_edit: 'localEdit',
      large_edit: 'largeEdit',
      full_relayout: 'fullRelayout',
      question: 'question',
      unresolved: 'contextIntent'
    })
    .addConditionalEdges('contextIntent', (state) => state.intent, {
      local_edit: 'localEdit',
      large_edit: 'largeEdit',
      full_relayout: 'fullRelayout',
      question: 'question',
      unresolved: 'toolIntent'
    })
    .addConditionalEdges('toolIntent', (state) => state.intent, {
      local_edit: 'localEdit',
      large_edit: 'largeEdit',
      full_relayout: 'fullRelayout',
      question: 'question',
      unresolved: 'question'
    })
    .addEdge('localEdit', 'verifyEffectiveChange')
    .addEdge('largeEdit', 'verifyEffectiveChange')
    .addEdge('fullRelayout', 'verifyEffectiveChange')
    .addEdge('verifyEffectiveChange', END)
    .addEdge('question', END)
    .compile()
}
