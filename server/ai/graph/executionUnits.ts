import type { PageData } from '../../../src/types'
import type { AIEditTaskState, ExecutionPolicy, ExecutionUnit } from '../../../src/types/aiPatch'
import { createFullRelayoutGroups } from '../context/fullRelayoutGroups'

const executableActions = (task: AIEditTaskState) => task.actionScopes.filter((action) => action.kind !== 'preserve')
const unique = (items: string[]) => [...new Set(items)]
const budgetFor = (policy: ExecutionPolicy, preferred: number) => Math.max(1, Math.min(preferred, policy.operationLimit, 12))

const localUnits = (task: AIEditTaskState, policy: ExecutionPolicy): ExecutionUnit[] => {
  const actions = executableActions(task)
  return actions.length ? [{
    id: 'local-1',
    actionIds: actions.map((action) => action.actionId),
    componentIds: unique(actions.flatMap((action) => action.targetComponentIds)),
    allowAdd: actions.some((action) => action.kind === 'add'),
    allowPageStyle: actions.some((action) => action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace')),
    operationBudget: budgetFor(policy, 12)
  }] : []
}

const largeUnits = (task: AIEditTaskState, policy: ExecutionPolicy): ExecutionUnit[] => (
  executableActions(task).map((action, index) => ({
    id: `large-${index + 1}-${action.actionId}`,
    actionIds: [action.actionId],
    componentIds: [...action.targetComponentIds],
    allowAdd: action.kind === 'add',
    allowPageStyle: action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace'),
    operationBudget: budgetFor(policy, 8)
  }))
)

const fullUnits = (task: AIEditTaskState, page: PageData, policy: ExecutionPolicy): ExecutionUnit[] => {
  const actions = executableActions(task)
  const groupedActions = actions.filter((action) => action.kind !== 'add')
  const addActions = actions.filter((action) => action.kind === 'add')
  const hasPageStyleAction = groupedActions.some((action) => (
    action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace')
  ))
  const groupBudget = Math.max(1, budgetFor(policy, 8) - (hasPageStyleAction ? 1 : 0))
  const groups = createFullRelayoutGroups(page, { operationBudget: groupBudget })
  const groupUnits: ExecutionUnit[] = (groups.length ? groups : [{ index: 0, componentIds: [], estimatedOperations: 1 }])
    .map((group, index) => ({
      id: `full-group-${index + 1}`,
      actionIds: groupedActions.map((action) => action.actionId),
      componentIds: [...group.componentIds],
      allowAdd: false,
      allowPageStyle: index === 0 && hasPageStyleAction,
      operationBudget: budgetFor(policy, Math.max(1, group.estimatedOperations + (index === 0 && hasPageStyleAction ? 1 : 0)))
    }))
    .filter((unit) => unit.actionIds.length > 0)
  const addUnits: ExecutionUnit[] = addActions.map((action, index) => ({
    id: `full-add-${index + 1}-${action.actionId}`,
    actionIds: [action.actionId],
    componentIds: [],
    allowAdd: true,
    allowPageStyle: false,
    operationBudget: budgetFor(policy, 8)
  }))
  return [...groupUnits, ...addUnits]
}

export const createExecutionUnits = (input: {
  task: AIEditTaskState
  page: PageData
  policy: ExecutionPolicy
}): ExecutionUnit[] => {
  const units = input.task.intent === 'large_edit'
    ? largeUnits(input.task, input.policy)
    : input.task.intent === 'full_relayout'
      ? fullUnits(input.task, input.page, input.policy)
      : localUnits(input.task, input.policy)
  const pageIds = new Set(input.page.components.map((component) => component.id))
  const actionIds = new Set(input.task.actionScopes.map((action) => action.actionId))
  return units.map((unit) => ({
    ...unit,
    actionIds: unique(unit.actionIds.filter((id) => actionIds.has(id))),
    componentIds: unique(unit.componentIds.filter((id) => pageIds.has(id))).slice(0, 12),
    operationBudget: budgetFor(input.policy, unit.operationBudget)
  })).filter((unit) => unit.actionIds.length > 0)
}

export const currentExecutionUnit = (state: { executionUnits?: ExecutionUnit[]; unitIndex?: number }) => (
  state.executionUnits?.[state.unitIndex || 0] || null
)

export const taskForExecutionUnit = (
  task: AIEditTaskState | null | undefined,
  unit: ExecutionUnit | null | undefined
): AIEditTaskState | null => {
  if (!task) return null
  if (!unit) return task
  const actionIds = new Set(unit.actionIds)
  return {
    ...task,
    actionScopes: task.actionScopes.filter((action) => action.kind === 'preserve' || actionIds.has(action.actionId))
  }
}

export const requestForExecutionUnit = (task: AIEditTaskState, unit: ExecutionUnit, unitIndex: number, total: number) => {
  const actionIds = new Set(unit.actionIds)
  const instructions = task.actionScopes
    .filter((action) => actionIds.has(action.actionId))
    .map((action) => action.instruction)
  return [
    ...instructions,
    total > 1 ? `当前执行单元 ${unitIndex + 1}/${total}（${unit.id}）。` : '',
    unit.componentIds.length ? `只处理这些稳定组件 ID：${unit.componentIds.join(', ')}。` : ''
  ].filter(Boolean).join('\n')
}
