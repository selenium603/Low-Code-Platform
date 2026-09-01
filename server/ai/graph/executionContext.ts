import { buildAIComponentIndex, selectLocalPageComponents } from '../context/componentIndex'
import { isPureAddRequest } from './editActionAnalysis'
import {
  deleteTargetIdsFor,
  editTargetIdsFor,
  preserveTargetIdsFor,
  taskHasAddAction,
  taskHasPageEditAction
} from './editSemanticAnalysis'
import { currentExecutionUnit, taskForExecutionUnit } from './executionUnits'
import type { PageEditStateUpdate, PageEditStateValue } from './pageEditState'

const pageContext = (state: PageEditStateValue): PageEditStateUpdate => {
  const unit = currentExecutionUnit(state)
  const scopedTask = taskForExecutionUnit(state.task, unit)
  const actions = scopedTask?.actionScopes || []
  const hasSemanticScopes = actions.length > 0
  const canAdd = unit?.allowAdd ?? (!hasSemanticScopes || actions.some((action) => action.kind === 'add'))
  const canUpdatePage = unit?.allowPageStyle ?? (!hasSemanticScopes || actions.some((action) => (
    action.targetScope === 'page' && (action.kind === 'update' || action.kind === 'replace')
  )))
  return {
    componentIndex: buildAIComponentIndex(state.draftPage),
    activeComponentIndex: [],
    selectedComponentIds: [],
    editScope: 'page',
    allowedOperationKinds: [
      ...(canUpdatePage ? ['updatePageStyle'] : []),
      ...(canAdd ? ['addComponent'] : [])
    ],
    currentPageContext: {
      contextMode: isPureAddRequest(state.request) ? 'pure-add' : 'page',
      totalComponentCount: state.draftPage.components.length,
      page: {
        id: state.draftPage.id,
        meta: state.draftPage.meta,
        style: state.draftPage.style,
        responsiveOverrides: state.draftPage.responsiveOverrides
      }
    }
  }
}

const componentContext = (state: PageEditStateValue, targetIds: string[]): PageEditStateUpdate => {
  const unit = currentExecutionUnit(state)
  const scopedTask = taskForExecutionUnit(state.task, unit)
  const selectedIds = new Set(targetIds)
  const componentIndex = buildAIComponentIndex(state.draftPage)
  const localComponents = selectLocalPageComponents(state.draftPage, targetIds)
  const localIds = new Set(localComponents.map((component) => component.id))
  const authorizedDeleteIds = new Set(state.executionPolicy?.deleteAuthorization.componentIds || [])
  const hasSemanticScopes = Boolean(scopedTask?.actionScopes.length)
  const semanticEditIds = new Set(editTargetIdsFor(scopedTask))
  const semanticDeleteIds = new Set(deleteTargetIdsFor(scopedTask))
  const editableIds = hasSemanticScopes
    ? taskHasPageEditAction(scopedTask) && state.intent === 'full_relayout'
      ? targetIds
      : targetIds.filter((id) => semanticEditIds.has(id))
    : targetIds
  const canDelete = targetIds.some((id) => authorizedDeleteIds.has(id) && semanticDeleteIds.has(id))
  const canEdit = editableIds.length > 0
  const canAdd = unit?.allowAdd ?? (hasSemanticScopes && taskHasAddAction(scopedTask))
  const canUpdatePage = unit?.allowPageStyle ?? Boolean(state.executionPolicy?.allowRegionalRelayout)
  return {
    componentIndex,
    activeComponentIndex: componentIndex.filter((item) => localIds.has(item.id)),
    selectedComponentIds: targetIds,
    editScope: 'components',
    allowedOperationKinds: [
      ...(canEdit ? ['updateProps', 'updateStyle', 'placeRelative', 'moveLayer'] : []),
      ...(canDelete ? ['removeComponent'] : []),
      ...(canAdd ? ['addComponent'] : []),
      ...(canUpdatePage ? ['updatePageStyle'] : [])
    ],
    currentPageContext: {
      contextMode: state.intent === 'full_relayout' ? 'full-relayout-group' : 'localized',
      totalComponentCount: state.draftPage.components.length,
      page: {
        id: state.draftPage.id,
        meta: state.draftPage.meta,
        style: state.draftPage.style,
        responsiveOverrides: state.draftPage.responsiveOverrides
      },
      selectedComponentIds: targetIds,
      selectedComponents: state.draftPage.components.filter((component) => selectedIds.has(component.id)),
      nearbyComponents: localComponents,
      preservedComponentIds: preserveTargetIdsFor(scopedTask)
    },
    needsRelocate: false
  }
}

export const createExecutionUnitContext = (state: PageEditStateValue): PageEditStateUpdate => {
  const unit = currentExecutionUnit(state)
  if (!unit) {
    return {
      status: 'error',
      result: {
        type: 'execution_failed', runId: state.runId, code: 'MISSING_EXECUTION_UNIT',
        message: '找不到当前执行单元。', retryable: true, pendingTask: state.pendingTask
      }
    }
  }
  return unit.componentIds.length ? componentContext(state, unit.componentIds) : pageContext(state)
}
